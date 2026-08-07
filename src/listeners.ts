/**
 * Backend event wiring: PTY output/exit events, plus the tab activity
 * indicator and agent-done notification bookkeeping they drive.
 */

import { listen } from "@tauri-apps/api/event";
import { isAgentModeAll } from "./agents";
import { customs } from "./modes";
import { analyzeOutput } from "./input-line";
import { writeToTerminal } from "./terminal";
import {
  armIdle,
  armNotify,
  clearIdle,
  clearNotify,
  notifyAgentDone,
  setIndicator,
  INDICATOR_ACTIVITY,
  INDICATOR_DONE,
} from "./titles";
import {
  isPanelActive,
  panelStatus,
  parkedKeyFor,
  parkedSessions,
  pendingOutputs,
  refreshSidebarRunning,
  scheduleWorkspaceRefresh,
  sessions,
} from "./state";

export async function registerGlobalListeners() {
  await listen<{ sessionId: number; data: string }>("pty://output", (event) => {
    const { sessionId, data } = event.payload;
    const entry = sessions.get(sessionId);
    if (entry) {
      // Shell-integration markers drive the tab completion indicator; any
      // remaining text is written to the terminal.
      const { markers, text } = analyzeOutput(data);
      if (text) writeToTerminal(entry.terminal, text);
      // Parked (background-workspace) sessions keep a status under a unique
      // `parked:<id>` key so they can never collide with a live panel that
      // happens to reuse the same panel id.
      const statusKey = parkedSessions.has(sessionId)
        ? parkedKeyFor(sessionId)
        : entry.panel && panelStatus.has(entry.panel.id)
          ? entry.panel.id
          : undefined;
      if (statusKey) {
        // Agent-done notifications run for every session (active or not): a
        // completion signal (OSC 133;D or a quiet window after output)
        // reports "done"; notifyAgentDone decides whether the user is
        // actually watching and skips if so.
        const st = panelStatus.get(statusKey);
        if (st && isAgentModeAll(entry.mode, customs())) {
          if (markers.includes("D")) {
            clearNotify(statusKey);
            notifyAgentDone(statusKey, entry);
          } else if (markers.includes("C") || text.length > 0) {
            // New command started / visible output: a fresh completion
            // episode, so the next "done" may notify again.
            st.notified = false;
            if (text.length > 0) armNotify(statusKey, entry);
          }
        }
        // The tab activity/completion indicator only applies to background
        // tabs; the active one is already in view. Parked sessions are never
        // active.
        if (!isPanelActive(entry.panel?.id ?? "")) {
          if (markers.includes("D")) {
            // Command finished (OSC 133;D): mark the tab done immediately.
            clearIdle(statusKey);
            setIndicator(statusKey, INDICATOR_DONE);
          } else if (markers.includes("C")) {
            // Command started: nothing to show yet.
          } else if (text.length > 0) {
            // Visible output in a background tab: activity, then "done" once
            // the tab stays quiet.
            setIndicator(statusKey, INDICATOR_ACTIVITY);
            armIdle(statusKey);
          }
        }
      }
      return;
    }
    const buf = pendingOutputs.get(sessionId) ?? [];
    buf.push(data);
    pendingOutputs.set(sessionId, buf);
  });

  await listen<{ sessionId: number; code: number }>("pty://exit", (event) => {
    const { sessionId, code } = event.payload;
    pendingOutputs.delete(sessionId);
    const entry = sessions.get(sessionId);
    if (entry) {
      if (parkedSessions.has(sessionId)) {
        // The session finished while its workspace was hidden: no panel
        // removal will come to clean it up, so do it here. (The "[process
        // exited]" note would only land in an off-screen terminal.)
        parkedSessions.delete(sessionId);
        sessions.delete(sessionId);
        entry.terminal.dispose();
        const parkedKey = parkedKeyFor(sessionId);
        clearIdle(parkedKey);
        clearNotify(parkedKey);
        panelStatus.delete(parkedKey);
        refreshSidebarRunning();
        scheduleWorkspaceRefresh();
        return;
      }
      writeToTerminal(entry.terminal, `\r\n[process exited with code ${code}]\r\n`);
    }
  });
}
