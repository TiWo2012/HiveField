/**
 * Right-click context menus over the terminal workspace: new sessions /
 * splits, copy & paste, and per-panel actions (find, rename, close).
 * Rendered by the generic context-menu.ts; this module builds the items.
 */

import type { IDockviewPanel } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { isAgentModeAll } from "./agents";
import { sessionModes } from "./modes";
import { getSettings } from "./settings";
import { showContextMenu, type ContextMenuItem } from "./context-menu";
import { copyText, readClipboardText } from "./clipboard";
import { openSearch } from "./search";
import { addPanelWithMode } from "./sessions";
import { panelForTabElement, renamePanel } from "./titles";
import {
  getApi,
  panelToSession,
  sessions,
} from "./state";

/** Split directions offered by the "New split" submenu. */
const SPLIT_DIRECTIONS: Array<{
  dir: "left" | "right" | "above" | "below";
  label: string;
  icon: string;
}> = [
  { dir: "right", label: "Right", icon: "→" },
  { dir: "left", label: "Left", icon: "←" },
  { dir: "above", label: "Up", icon: "↑" },
  { dir: "below", label: "Down", icon: "↓" },
];

/**
 * The "New split" submenu: one entry per session mode, each with the four
 * split directions. The new session opens adjacent to `referencePanel`.
 */
function newSplitMenuItems(referencePanel: IDockviewPanel): ContextMenuItem[] {
  return sessionModes().map(({ mode, label, icon }) => ({
    label,
    icon,
    submenu: SPLIT_DIRECTIONS.map(({ dir, label: dLabel, icon: dIcon }) => ({
      label: dLabel,
      icon: dIcon,
      run: () => addPanelWithMode(mode, { direction: dir, referencePanel }),
    })),
  }));
}

/** Copy the right-clicked terminal's selection, when there is one. */
function copyTerminalSelection(panel: IDockviewPanel): void {
  const sessionId = panelToSession.get(panel.id);
  const entry = sessionId !== undefined ? sessions.get(sessionId) : undefined;
  const text = entry?.terminal.getSelection();
  if (text) {
    void copyText(text).catch((err) => console.error("copy failed", err));
  }
}

/** Paste the system clipboard into the right-clicked terminal. */
function pasteIntoTerminal(panel: IDockviewPanel): void {
  const sessionId = panelToSession.get(panel.id);
  const entry = sessionId !== undefined ? sessions.get(sessionId) : undefined;
  if (!entry) return;
  void readClipboardText()
    .then((text) => {
      // terminal.paste() keeps bracketed-paste mode intact, like Ctrl+Shift+V.
      if (text) entry.terminal.paste(text);
    })
    .catch((err) => console.error("paste failed", err));
}

/**
 * Open a new agent session and paste `text` into it once the PTY is ready.
 * Retries for a couple of seconds, then gives up (best-effort, like file
 * drops on the splash).
 */
function sendTextToAgent(mode: string, text: string): void {
  addPanelWithMode(mode);
  let attempts = 0;
  const tryWrite = () => {
    // Find the panel we just created by scanning for the newest one whose
    // session has the requested mode and has a sessionId (PTY is ready).
    const panels = getApi().panels;
    for (const panel of [...panels].reverse()) {
      const sessionId = panelToSession.get(panel.id);
      if (sessionId === undefined) continue;
      const entry = sessions.get(sessionId);
      if (entry?.mode !== mode) continue;
      invoke("pty_write", { sessionId, data: text }).catch((err) =>
        console.error("failed to write to agent session", err)
      );
      return;
    }
    if (++attempts < 40) setTimeout(tryWrite, 50);
  };
  tryWrite();
}

/** Context menu for a right-clicked terminal pane. */
function buildPaneContextMenu(panel: IDockviewPanel): ContextMenuItem[] {
  const sessionId = panelToSession.get(panel.id);
  const entry = sessionId !== undefined ? sessions.get(sessionId) : undefined;
  const hasSelection = entry?.terminal.hasSelection() ?? false;

  return [
    {
      // One submenu for every visible session mode (enabled agents + raw
      // term), so the menu stays compact now that many agents are supported.
      label: "New session",
      icon: "✦",
      submenu: sessionModes().map(({ mode, label, icon }) => ({
        label,
        icon,
        run: () => addPanelWithMode(mode),
      })),
    },
    { label: "New split", icon: "▣", submenu: newSplitMenuItems(panel) },
    { separator: true },
    {
      label: "Copy",
      icon: "⧉",
      disabled: !hasSelection,
      run: () => copyTerminalSelection(panel),
    },
    { label: "Paste", icon: "⎘", run: () => pasteIntoTerminal(panel) },
    {
      label: "Send selection to",
      icon: "↗",
      disabled: !hasSelection,
      submenu: sessionModes()
        .filter((s) => s.mode !== "raw")
        .map(({ mode, label, icon }) => ({
          label,
          icon,
          run: () => {
            const text = entry?.terminal.getSelection();
            if (text) sendTextToAgent(mode, text);
          },
        })),
    },
    { separator: true },
    {
      label: "Find",
      icon: "⌕",
      shortcut: getSettings().keybinds.find,
      run: () => openSearch(),
    },
    {
      label: "Rename tab",
      icon: "✎",
      shortcut: getSettings().keybinds.renameTab,
      run: () => void renamePanel(panel),
    },
    { separator: true },
    {
      label: "Close panel",
      icon: "✕",
      shortcut: getSettings().keybinds.closePanel,
      danger: true,
      run: () => panel.api.close(),
    },
  ];
}

/** Context menu for a right-clicked tab (or a group's tab bar). */
function buildTabContextMenu(panel: IDockviewPanel): ContextMenuItem[] {
  return [
    { label: "New split", icon: "▣", submenu: newSplitMenuItems(panel) },
    { separator: true },
    {
      label: "Rename tab",
      icon: "✎",
      shortcut: getSettings().keybinds.renameTab,
      run: () => void renamePanel(panel),
    },
    {
      label: "Close tab",
      icon: "✕",
      shortcut: getSettings().keybinds.closePanel,
      danger: true,
      run: () => panel.api.close(),
    },
  ];
}

/** Map a dockview tab element back to its panel (for right-click menus). */
function panelForGroupElement(groupEl: HTMLElement): IDockviewPanel | undefined {
  const group = getApi().groups.find((g) => g.element === groupEl);
  return group?.activePanel ?? group?.panels[0];
}

/**
 * Right-click handling across the terminal workspace (capture phase, before
 * xterm or dockview see the event): terminal panes, tabs, and split gutters
 * each get their own menu; anything else keeps the default behavior.
 */
export function setupContextMenu(): void {
  document.addEventListener(
    "contextmenu",
    (e) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest) return;

      // Tab bar: rename / close / split relative to that tab's panel.
      const tabEl = target.closest(".dv-tab");
      if (tabEl instanceof HTMLElement) {
        const panel = panelForTabElement(tabEl);
        if (panel) {
          e.preventDefault();
          showContextMenu(buildTabContextMenu(panel), e.clientX, e.clientY);
        }
        return;
      }

      // Terminal content: full menu; the pane becomes active so Copy/Paste
      // and any subsequent typing target the right-clicked session.
      const paneEl = target.closest(".terminal-panel");
      if (paneEl instanceof HTMLElement) {
        const id = paneEl.dataset.panelId;
        const panel = id ? getApi().getPanel(id) : undefined;
        if (panel) {
          e.preventDefault();
          panel.api.setActive();
          const sid = panelToSession.get(panel.id);
          const entry = sid !== undefined ? sessions.get(sid) : undefined;
          entry?.terminal.focus();
          showContextMenu(buildPaneContextMenu(panel), e.clientX, e.clientY);
        }
        return;
      }

      // Group chrome (tab bar background / split gutters): act on the
      // group's active panel so splits land in the right group.
      const groupEl = target.closest(".dv-groupview");
      if (groupEl instanceof HTMLElement) {
        const panel = panelForGroupElement(groupEl);
        if (panel) {
          e.preventDefault();
          showContextMenu(buildTabContextMenu(panel), e.clientX, e.clientY);
        }
      }
    },
    true
  );
}
