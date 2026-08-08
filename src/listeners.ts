/**
 * Backend event wiring: PTY output/exit events, plus the tab activity
 * indicator and agent-done notification bookkeeping they drive.
 */

import { listen } from "@tauri-apps/api/event";
import { isAgentModeAll } from "./agents";
import { customs } from "./modes";
import { analyzeOutput } from "./input-line";
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
  discardSession,
  isDiscardedSession,
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
      // Ghostty canvas auto-renders via ghostty://cells; we only need
      // the markers for tab activity/completion indicators.
      
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
    // Analyze the output before buffering, same as the live-session path
    // above, so shell-integration markers (OSC 133) don't leak into xterm.js
    // when the pending chunks are replayed. The markers themselves are lost
    // for tab indicators — an acceptable trade-off for a rare edge case.
      const { text } = analyzeOutput(data);
      if (text) {
        const buf = pendingOutputs.get(sessionId) ?? [];
        buf.push(text);
        pendingOutputs.set(sessionId, buf);
      }
  });

  await listen<{ sessionId: number; code: number }>("pty://exit", (event) => {
    const { sessionId, code } = event.payload;
    discardSession(sessionId);
    pendingOutputs.delete(sessionId);
    const entry = sessions.get(sessionId);
    if (entry) {
      if (parkedSessions.has(sessionId)) {
        // The session finished while its workspace was hidden: no panel
        // removal will come to clean it up, so do it here.
        parkedSessions.delete(sessionId);
        sessions.delete(sessionId);
        // entry.canvas.dispose() not valid for off-screen parked elements.
        entry.canvas.element.remove();
        const parkedKey = parkedKeyFor(sessionId);
        clearIdle(parkedKey);
        clearNotify(parkedKey);
        panelStatus.delete(parkedKey);
        refreshSidebarRunning();
        scheduleWorkspaceRefresh();
        return;
      }
      // Ghostty canvas shows exit info via the ghostty://cells event
      // which includes the backend's exit message.
      
    }
  });
}
