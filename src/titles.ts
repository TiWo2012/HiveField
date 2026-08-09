/**
 * Panel tab titles: automatic (OSC / input line / mode label), user-renamed,
 * and the activity/completion indicator prefixes shown on background tabs,
 * plus the agent-done notification quiet-window that reports finished agents.
 */

import { invoke } from "@tauri-apps/api/core";
import type { IDockviewPanel } from "dockview";
import { isAgentModeAll, isKnownModeAll, modeLabelAll } from "./agents";
import { customs, DEFAULT_MODE, type Mode } from "./modes";
import { getSettings } from "./settings";
import { openPromptModal } from "./modal";
import {
  getApi,
  idleTimers,
  isPanelActive,
  isWindowFocused,
  notifyTimers,
  panelStatus,
  refreshSidebarRunning,
  sessions,
  type SessionEntry,
} from "./state";
import { refreshStatusBar } from "./status-bar";

/** Tab-title prefixes used to signal background activity / command completion. */
export const INDICATOR_ACTIVITY = "● ";
export const INDICATOR_DONE = "✓ ";

/** Idle window (ms) after which a background tab's activity becomes "done". */
const ACTIVITY_IDLE_MS = 2000;

/** Quiet window (ms) before a finished background agent fires notifications. */
const NOTIFY_IDLE_MS = 8000;

function ensurePanelStatus(panelId: string, initialTitle: string, userTitle?: string) {
  let st = panelStatus.get(panelId);
  if (st) return st;
  // A restored title may carry a stale indicator prefix — strip it.
  const clean = initialTitle.replace(/^[●✓] /, "");
  st = {
    baseTitle: userTitle ?? clean,
    indicator: "",
    userTitle: typeof userTitle === "string" && userTitle.length > 0,
    // A restored custom title has no live pre-rename title to revert to;
    // renamePanel falls back to the mode label in that case.
    preRenameTitle: undefined,
    notified: false,
  };
  panelStatus.set(panelId, st);
  return st;
}

export function renderTitle(panelId: string): void {
  const st = panelStatus.get(panelId);
  const panel = getApi()?.getPanel(panelId);
  if (st && panel) panel.api.setTitle(st.indicator + st.baseTitle);
  // The sidebar's Running list mirrors tab titles/indicators live.
  refreshSidebarRunning();
  // The status bar shows the active session's title; keep it current.
  if (isPanelActive(panelId)) refreshStatusBar();
}

/** Update the base (indicator-free) title, keeping the indicator prefix. */
export function setBaseTitle(panelId: string, title: string): void {
  const st = panelStatus.get(panelId);
  if (!st) return;
  st.baseTitle = title;
  renderTitle(panelId);
}

export function setIndicator(panelId: string, indicator: string): void {
  const st = panelStatus.get(panelId);
  // Skip redundant updates: output arrives in bursts, and every background
  // chunk would otherwise re-render the sidebar list for no visible change.
  if (!st || st.indicator === indicator) return;
  st.indicator = indicator;
  renderTitle(panelId);
}

export function clearIndicator(panelId: string): void {
  clearIdle(panelId);
  setIndicator(panelId, "");
}

/** After activity, mark the tab "done" once it stays quiet for a while. */
export function armIdle(panelId: string): void {
  clearIdle(panelId);
  idleTimers.set(
    panelId,
    setTimeout(() => {
      idleTimers.delete(panelId);
      setIndicator(panelId, INDICATOR_DONE);
    }, ACTIVITY_IDLE_MS)
  );
}

export function clearIdle(panelId: string): void {
  const t = idleTimers.get(panelId);
  if (t !== undefined) {
    clearTimeout(t);
    idleTimers.delete(panelId);
  }
}

/** Cancel any pending agent-done notification timer for a panel. */
export function clearNotify(panelId: string): void {
  const t = notifyTimers.get(panelId);
  if (t !== undefined) {
    clearTimeout(t);
    notifyTimers.delete(panelId);
  }
}

/**
 * Report a finished agent session to the user: a native desktop notification
 * and/or an ntfy push, per the settings. Only fires for agent sessions
 * (any non-raw mode), once per completion episode, and skips when the user is
 * actively watching the panel (window focused + panel active).
 */
export function notifyAgentDone(panelId: string, entry: SessionEntry): void {
  if (!isAgentModeAll(entry.mode, customs())) return;
  // The user is looking at this very panel: interrupting them is pointless.
  if (isWindowFocused() && isPanelActive(panelId)) return;
  const st = panelStatus.get(panelId);
  if (!st || st.notified) return;
  st.notified = true;

  const settings = getSettings();
  const label = modeLabelAll(entry.mode, customs());
  const title = st.baseTitle || entry.panel?.title || label;
  const body = `${label} session “${title}” finished`;

  if (settings.desktopNotifications) {
    invoke("notify_desktop", { title: `${label} done`, body }).catch((err) =>
      console.error("notify_desktop failed", err)
    );
  }
  if (settings.ntfyEnabled) {
    invoke("ntfy_send", { title: `${label} done`, body }).catch((err) =>
      console.error("ntfy_send failed", err)
    );
  }
}

/**
 * Arm the notification quiet-window for an agent session: once it stays quiet
 * for [`NOTIFY_IDLE_MS`] (longer than the tab indicator's window, so mid-run
 * thinking pauses don't spam), treat it as done and notify.
 */
export function armNotify(panelId: string, entry: SessionEntry): void {
  clearNotify(panelId);
  notifyTimers.set(
    panelId,
    setTimeout(() => {
      notifyTimers.delete(panelId);
      notifyAgentDone(panelId, entry);
    }, NOTIFY_IDLE_MS)
  );
}

/** The mode-derived label for a panel (fallback title when no live title exists). */
export function panelModeLabel(panel: IDockviewPanel): string {
  const params = panel.api.getParameters() as Record<string, unknown>;
  const mode: Mode =
    typeof params.mode === "string" &&
    isKnownModeAll(params.mode, customs())
      ? params.mode
      : DEFAULT_MODE;
  return modeLabelAll(mode, customs());
}

/** Map a dockview tab DOM element back to its panel (for double-click rename). */
export function panelForTabElement(tabEl: HTMLElement): IDockviewPanel | undefined {
  const groupEl = tabEl.closest(".dv-groupview");
  if (!groupEl) return undefined;
  const group = getApi().groups.find((g) => g.element === groupEl);
  if (!group) return undefined;
  const tabs = Array.from(
    groupEl.querySelectorAll<HTMLElement>(
      ":scope > .dv-tabs-and-actions-container > .dv-tabs-container > .dv-tab"
    )
  );
  const idx = tabs.indexOf(tabEl);
  if (idx < 0 || idx >= group.panels.length) return undefined;
  return group.panels[idx];
}

/** Prompt to rename a tab; empty input reverts to automatic titles. */
export async function renamePanel(panel: IDockviewPanel): Promise<void> {
  const st = panelStatus.get(panel.id);
  const current = st?.baseTitle ?? panel.title ?? "";
  const value = await openPromptModal({
    title: "Rename tab",
    label: "Tab title",
    placeholder: "Name this tab",
    value: current,
    hint: "A custom name sticks and is no longer overwritten by the program. Leave empty and confirm to go back to automatic titles.",
    confirmText: "Rename",
  });
  if (value === null) return;
  const status = panelStatus.get(panel.id);
  if (!status) return;
  status.userTitle = value.length > 0;
  if (status.userTitle) {
    // Remember the automatic title in effect right now so that clearing the
    // custom name later can restore it (renaming again keeps the original
    // snapshot instead of overwriting it with the previous custom name).
    if (status.preRenameTitle === undefined) {
      status.preRenameTitle = status.baseTitle;
    }
    status.baseTitle = value;
    panel.api.updateParameters({ userTitle: value });
    renderTitle(panel.id);
  } else {
    // Revert: hand the tab back to automatic titles. Restore the pre-rename
    // title (mode label as a fallback when no snapshot exists, e.g. after a
    // layout restore where only the custom name was serialized).
    status.baseTitle = status.preRenameTitle ?? panelModeLabel(panel);
    status.preRenameTitle = undefined;
    panel.api.updateParameters({ userTitle: null });
    renderTitle(panel.id);
  }
}

/** Export for the panel component (sessions.ts): title bookkeeping entry. */
export { ensurePanelStatus };
