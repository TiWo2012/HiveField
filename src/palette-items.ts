/**
 * The command palette's item list: every open pane (with its rendered title,
 * mode icon, and cwd detail) followed by the available actions. Built fresh
 * every time the palette opens so the list reflects the live layout.
 */

import { invoke } from "@tauri-apps/api/core";
import { isKnownModeAll, modeIconAll } from "./agents";
import { customs, DEFAULT_MODE, sessionModes } from "./modes";
import { getSettings } from "./settings";
import { openSettings, toggleSettings } from "./settings-ui";
import { snippetPickerItems } from "./snippets";
import { openSearch } from "./search";
import { copyDiagnostics } from "./diagnostics";
import { openPaletteWith, type PaletteItem } from "./palette";
import {
  activeSessionEntry,
  addPanelWithMode,
  cycleTab,
  movePaneFocus,
  shortLabel,
} from "./sessions";
import { renamePanel } from "./titles";
import { switchToWorkspace, renameWorkspacePrompt } from "./sidebar";
import { openNewWindow } from "./windows";
import { getCurrentSlot, getWorkspaceSlots } from "./workspace";
import type { KeybindAction } from "./keybinds";
import {
  getApi,
  isPanelActive,
  panelToSession,
  sessions,
} from "./state";

export function buildPaletteItems(): PaletteItem[] {
  const kb = () => getSettings().keybinds;
  const items: PaletteItem[] = [];

  for (const panel of getApi().panels) {
    const params = panel.api.getParameters() as Record<string, unknown>;
    const mode =
      typeof params.mode === "string" &&
      isKnownModeAll(params.mode, customs())
        ? params.mode
        : DEFAULT_MODE;
    const sessionId = panelToSession.get(panel.id);
    const entry = sessionId !== undefined ? sessions.get(sessionId) : undefined;
    const cwd =
      entry?.cwd ?? (typeof params.cwd === "string" ? params.cwd : undefined);
    const detail = [
      isPanelActive(panel.id) ? "active" : null,
      cwd ? shortLabel(cwd) : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · ");
    items.push({
      id: panel.id,
      label: panel.title ?? "…",
      detail,
      icon: modeIconAll(mode, customs()),
      group: "Panes",
      run: () => {
        panel.api.setActive();
        const sid = panelToSession.get(panel.id);
        const e = sid !== undefined ? sessions.get(sid) : undefined;
        e?.terminal.focus();
      },
    });
  }

  const actions: Array<{
    label: string;
    detail?: string;
    icon?: string;
    run: () => void;
  }> = [
    // One "new tab" and one "new split" action per session mode; the fuzzy
    // finder keeps 30 actions navigable (type "cop" to jump to Copilot).
    ...sessionModes().map(({ mode, label, icon }) => ({
      label: `New ${label} tab`,
      detail: mode === DEFAULT_MODE ? kb().newTab : undefined,
      icon,
      run: () => addPanelWithMode(mode),
    })),
    ...sessionModes().map(({ mode, label, icon }) => ({
      label: `New ${label} split`,
      icon,
      run: () => addPanelWithMode(mode, { direction: "right" }),
    })),
    {
      label: "Insert prompt…",
      detail: (() => {
        const count = getSettings().promptSnippets.length;
        return `${count} snippet${count === 1 ? "" : "s"}`;
      })(),
      icon: "✎",
      run: () =>
        // Sub-picker: list every configured snippet; picking one pastes its
        // content into the active terminal (bracketed-paste aware).
        openPaletteWith(
          () =>
            snippetPickerItems((snippet) => {
              const entry = activeSessionEntry();
              if (entry) entry.terminal.paste(snippet.content);
            }),
          "Pick a prompt to insert…"
        ),
    },
    {
      label: "Find in terminal",
      detail: kb().find,
      icon: "⌕",
      run: () => openSearch(),
    },
    {
      label: "New window",
      detail: kb().newWindow,
      icon: "▭",
      run: () => openNewWindow(),
    },
    {
      label: "Focus pane left",
      detail: kb().focusLeft,
      run: () => movePaneFocus("left"),
    },
    {
      label: "Focus pane right",
      detail: kb().focusRight,
      run: () => movePaneFocus("right"),
    },
    {
      label: "Focus pane up",
      detail: kb().focusUp,
      run: () => movePaneFocus("up"),
    },
    {
      label: "Focus pane down",
      detail: kb().focusDown,
      run: () => movePaneFocus("down"),
    },
    {
      label: "Next tab",
      detail: kb().nextTab,
      run: () => cycleTab(1),
    },
    {
      label: "Previous tab",
      detail: kb().previousTab,
      run: () => cycleTab(-1),
    },
    {
      label: "Rename active tab",
      detail: kb().renameTab,
      run: () => {
        const panel = getApi().activePanel;
        if (panel) void renamePanel(panel);
      },
    },
    {
      label: "Close active panel",
      detail: kb().closePanel,
      run: () => getApi().activePanel?.api.close(),
    },
    {
      label: "Send SIGINT to all panes",
      icon: "⏹",
      run: () => {
        // Ctrl+C as a PTY byte: the tty driver turns 0x03 into SIGINT for
        // the foreground process group of every live session in this
        // workspace (parked background sessions are not touched).
        for (const panel of getApi().panels) {
          const sessionId = panelToSession.get(panel.id);
          if (sessionId === undefined || !sessions.has(sessionId)) continue;
          invoke("pty_write", { sessionId, data: "\x03" }).catch(() => {});
        }
      },
    },
    {
      label: "Close all panes",
      icon: "✕",
      run: () => {
        // Snapshot the list: closing a panel mutates api.panels mid-loop.
        // Each close goes through onDidRemovePanel, which kills the session
        // and tears down its terminal/worktree as usual.
        for (const panel of [...getApi().panels]) panel.api.close();
      },
    },
    {
      label: "Copy diagnostics",
      icon: "🩺",
      run: () => {
        // Best-effort: an IPC/clipboard failure shouldn't crash the palette;
        // the user can retry or use `hivefield --doctor` instead.
        void copyDiagnostics().catch((err) => console.error(err));
      },
    },
    {
      label: "Settings",
      detail: kb().settings,
      icon: "⚙",
      run: () => toggleSettings(),
    },
    {
      label: "Keybindings…",
      detail: kb().settings,
      icon: "⌨",
      run: () => openSettings("keybinds"),
    },
  ];
  for (const action of actions) {
    items.push({ id: `action-${action.label}`, group: "Actions", ...action });
  }

  // Every workspace slot: jump to it (Ctrl+1…Ctrl+0) or rename it.
  for (const ws of getWorkspaceSlots()) {
    const isCurrent = ws.slot === getCurrentSlot();
    items.push({
      id: `workspace-${ws.slot}`,
      label: ws.name
        ? `Workspace ${ws.slot} · ${ws.name}`
        : `Workspace ${ws.slot}`,
      detail: isCurrent
        ? "current"
        : ws.hasLayout
          ? kb()[`workspace${ws.slot}` as KeybindAction]
          : "empty",
      icon: "▦",
      group: "Workspaces",
      run: () => switchToWorkspace(ws.slot),
    });
  }
  items.push({
    id: `action-rename-workspace-${getCurrentSlot()}`,
    label: `Rename workspace ${getCurrentSlot()}`,
    icon: "▦",
    group: "Workspaces",
    run: () => void renameWorkspacePrompt(getCurrentSlot()),
  });
  return items;
}
