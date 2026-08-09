/**
 * Composition root: builds the dockview layout, wires every feature module
 * together, and owns the startup/splash flow.
 *
 * All feature logic lives in dedicated modules (sessions, sidebar, titles,
 * bell, dnd, menus, keyboard, palette-items, listeners, terminal, …); this
 * file only glues them together, so the app's wiring is readable in one
 * place and each concern is independently testable.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  createDockview,
  positionToDirection,
  type AddPanelPositionOptions,
  type IDockviewPanel,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import "./styles.css";
import { isKnownModeAll, RAW_MODE } from "./agents";
import { customs, defaultMode, sessionModes } from "./modes";
import { getSettings, loadSettings, subscribe } from "./settings";
import { getTheme } from "./themes";
import { initDictation } from "./dictation";
import { initSearch, isSearchOpen, rerunSearch } from "./search";
import { initPalette } from "./palette";
import {
  bindWorkspaceSave,
  clearCurrentWorkspaceIfEmpty,
  getWorkspaceCwd,
  getWorkspaceSlots,
  loadWorkspaces,
  restoreWorkspace,
} from "./workspace";
import { mountSplash, type SplashHandle } from "./splash";
import { initFileDrop, shellQuote } from "./file-drop";
import {
  buildSidebar,
  refreshSidebarRunning,
  refreshWorkspaceInfo,
  renderWorkspaceStrip,
  scheduleWorkspaceRefresh,
  syncSidebarSourcesToSettings,
} from "./sidebar";
import { registerGlobalListeners } from "./listeners";
import { setupKeyboard } from "./keyboard";
import { setupContextMenu } from "./menus";
import { buildPaletteItems } from "./palette-items";
import { scheduleGitDiffReport } from "./git-toast";
import { openNewWindow } from "./windows";
import { addPanelWithMode, activeSessionEntry, createTerminalComponent } from "./sessions";
import {
  applyTerminalSettings,
  applyUiTheme,
  ensureTerminalFont,
  syncSize,
  syncTerminalCursorFocus,
} from "./terminal";
import { clearIndicator, panelForTabElement, renamePanel } from "./titles";
import {
  isHiveFieldDrag,
  markDragOpenedSession,
  resolveDragPayload,
  setupSidebarDndFallback,
} from "./dnd";
import {
  bumpPanelCounter,
  discardSession,
  getApi,
  panelStatus,
  panelToSession,
  parkedSessions,
  pendingOutputs,
  sessions,
  setApi,
  setSidebarHooks,
  setWindowFocused,
} from "./state";
import { initStatusBar, refreshStatusBar } from "./status-bar";

async function init() {
  await loadSettings();

  // Report repo changes since launch 10s after startup (git diff against the
  // HEAD commit captured at launch).
  scheduleGitDiffReport();

  // Track OS window focus so agent-done notifications still fire while the
  // user is in another application (even when the agent's panel is active).
  const win = getCurrentWindow();
  setWindowFocused(await win.isFocused().catch(() => true));
  win.onFocusChanged(({ payload }) => {
    setWindowFocused(payload);
  });

  // Keep every open terminal in sync with the settings, and let the whole UI
  // use the chosen font family + theme (sidebar, tabs, settings page).
  subscribe((settings) => {
    // Load the (possibly changed) configured font so syncSize can fit.
    void ensureTerminalFont();
    for (const [id, entry] of sessions) {
      applyTerminalSettings(entry.terminal, settings);
      // Parked sessions live in off-screen zero-size containers; fitting
      // them would resize the PTY to garbage dimensions (2 cols × 1 row),
      // corrupting running processes. Skip them — they'll be resized when
      // their workspace is restored and their element is laid out again.
      if (!parkedSessions.has(id)) syncSize(id, entry.fitAddon, entry.terminal);
    }
    document.documentElement.style.setProperty(
      "--hivefield-font",
      `"${settings.fontFamily}", monospace`
    );
    applyUiTheme(settings);
    // Keep the status bar's keybind hint current.
    refreshStatusBar();
    // Re-apply search highlights so they pick up the new theme colors.
    if (isSearchOpen()) rerunSearch();
  });

  await registerGlobalListeners();

  // Load the configured terminal font up front so the first fit() measures
  // the real cell size — a fallback font's metrics would resize the PTY
  // wrong and garble the shell's startup output in the scrollback. Also
  // refit every terminal once the font actually lands (covers sessions that
  // spawned before the font finished loading, and font changes in settings).
  void ensureTerminalFont();
  try {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts?.ready) {
      fonts.ready.then(() => {
        for (const [id, entry] of sessions) {
          if (!parkedSessions.has(id)) syncSize(id, entry.fitAddon, entry.terminal);
        }
      });
    }
  } catch {
    // Font API unavailable — nothing to wait on.
  }

  // The native File → New Window menu item broadcasts this event; only the
  // focused window acts on it (it knows its own launch directory, which it
  // passes to the backend so the new window opens on the same project).
  await listen("menu://new-window", async () => {
    const win = getCurrentWindow();
    if (await win.isFocused().catch(() => true)) openNewWindow();
  });

  buildSidebar();
  // The sidebar's Running list and Workspace section re-render on state
  // changes through these hooks; also rebuild its drag sources when the
  // visible-agent selection changes.
  setSidebarHooks({
    refreshRunning: refreshSidebarRunning,
    scheduleWorkspaceRefresh: scheduleWorkspaceRefresh,
  });
  syncSidebarSourcesToSettings();
  refreshSidebarRunning();
  void refreshWorkspaceInfo();

  setApi(
    createDockview(document.getElementById("terminal")!, {
      createComponent: createTerminalComponent,
      disableFloatingGroups: true,
      theme: getTheme(getSettings().theme).dockview,
      dropOverlayModel: ({ location }) => {
        // Wider edge zones on the terminal content so dropping a session as a
        // split in a chosen direction is easy to hit (default is 20%).
        if (location !== "content") return undefined;
        return { activationSize: { value: 30, type: "percentage" } };
      },
    })
  );
  applyUiTheme(getSettings());

  // Accept our sidebar drags so dockview shows the drop-target overlay.
  getApi().onUnhandledDragOver((event) => {
    if (isHiveFieldDrag((event.nativeEvent as DragEvent).dataTransfer)) {
      event.accept();
    }
  });

  // Create a new session where the sidebar entry was dropped. Session drops
  // always open as a *split*, never as a tab: dropping in the middle of a
  // pane splits to the right (kitty-style default) so users don't have to
  // hit a thin edge or drag a tab out afterwards. Ctrl+Shift+T is still the
  // way to open a session as a tab.
  getApi().onDidDrop((event) => {
    const drag = resolveDragPayload((event.nativeEvent as DragEvent).dataTransfer);
    if (!drag) return;

    try {
      const direction = positionToDirection(event.position);
      const splitDirection = direction === "within" ? "right" : direction;
      let position: AddPanelPositionOptions | undefined;
      if (event.panel) {
        position = { direction: splitDirection, referencePanel: event.panel };
      } else if (event.group) {
        position = { direction: splitDirection, referenceGroup: event.group };
      } else {
        position = { direction: splitDirection };
      }

      addPanelWithMode(drag.mode, position, drag.cwd);
      markDragOpenedSession();
    } catch (err) {
      // A bad position must not swallow the drop: the document-level
      // fallback opens the session at the pointer instead.
      console.error("drop failed to open session", err);
    }
  });

  // WebKitGTK can drop the final `drop` near pane top/bottom edges, deliver
  // it late, or swallow it entirely; make sure a released session still opens.
  setupSidebarDndFallback();

  getApi().onDidRemovePanel((panel: IDockviewPanel) => {
    // A workspace that just lost its last panel and has no name is completely
    // empty: drop it (saved layout included) so it goes away from the
    // strip/palette and from disk. Named workspaces are kept.
    clearCurrentWorkspaceIfEmpty();
    const sessionId = panelToSession.get(panel.id);
    if (sessionId === undefined) return;
    const entry = sessions.get(sessionId);
    if (entry) {
      if (parkedSessions.has(sessionId)) {
        // Workspace switch-away: parkWorkspaceSessions() already moved the
        // terminal off-screen. Keep the session running in the background —
        // it is re-attached when this workspace comes back. The session
        // entry, panel status and timers are deliberately kept so the tab
        // indicator / agent-done notifications keep working while hidden.
      } else {
        invoke("pty_kill", { sessionId }).catch(() => {});
        // Auto-created throwaway worktrees are torn down with the session.
        if (entry.worktreePath) {
          invoke("git_worktree_remove", {
            path: entry.worktreePath,
            force: true,
          }).catch((err) => console.error("failed to remove session worktree", err));
        }
        entry.terminal.dispose();
        sessions.delete(sessionId);
        discardSession(sessionId);
        pendingOutputs.delete(sessionId);
        clearIndicator(panel.id);
        panelStatus.delete(panel.id);
      }
    }
    panelToSession.delete(panel.id);
    refreshSidebarRunning();
    scheduleWorkspaceRefresh();
    renderWorkspaceStrip();
    // If the searched terminal just went away, move the highlights onto
    // whatever is active now (or clear them if nothing is).
    if (isSearchOpen()) rerunSearch();
  });

  setupKeyboard();
  setupContextMenu();

  // Status bar (below the terminal area): broadcast toggle + active session info.
  initStatusBar();

  initDictation();

  // Floating search bar (Ctrl+Shift+F) over the terminal workspace.
  initSearch({
    container: document.getElementById("terminal")!,
    getActive: () => activeSessionEntry(),
    toggleKeybind: () => getSettings().keybinds.find,
  });

  // Command palette (Ctrl+Shift+P): fuzzy finder over panes and actions.
  initPalette({
    getItems: buildPaletteItems,
    onClose: () => activeSessionEntry()?.terminal.focus(),
    toggleKeybind: () => getSettings().keybinds.palette,
  });

  // OS file drops: insert shell-quoted paths into the pane under the pointer,
  // falling back to the active session when the drop misses every pane.
  initFileDrop(() => {
    const panel = getApi().activePanel;
    if (!panel) return undefined;
    return panelToSession.get(panel.id);
  }).catch((err) => console.error("failed to init file drop", err));

  // If the user switches panels while searching, move the highlights to the
  // newly active terminal instead of leaving them stale on the old one, and
  // clear any activity/completion indicator on the newly focused tab.
  getApi().onDidActivePanelChange(() => {
    if (isSearchOpen()) rerunSearch();
    refreshSidebarRunning();
    const panel = getApi().activePanel;
    if (panel) clearIndicator(panel.id);
    syncTerminalCursorFocus();
    refreshStatusBar();
  });

  // Double-click a tab to rename it.
  document.addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement | null;
    const tabEl = target?.closest?.(".dv-tab");
    if (!tabEl || !(tabEl instanceof HTMLElement)) return;
    e.preventDefault();
    const panel = panelForTabElement(tabEl);
    if (panel) void renamePanel(panel);
  });

  // Resolve the launch directory and its saved layouts up front so the splash
  // can label the resume action (idempotent; restoreWorkspace re-reads too).
  await loadWorkspaces();
  const hasSavedWorkspace = getWorkspaceSlots().some((slot) => slot.hasLayout);

  /**
   * Restore the saved layout for the launch directory. Restored panels carry
   * serialized ids like `panel-1`, so bump the panel counter past them before
   * any new panel is added (avoids duplicate ids).
   */
  async function resumeSavedWorkspace(): Promise<boolean> {
    const restored = await restoreWorkspace(getApi());
    if (restored) {
      for (const panel of getApi().panels) {
        const m = /^panel-(\d+)$/.exec(panel.id);
        if (m) bumpPanelCounter(parseInt(m[1], 10));
      }
    }
    return restored;
  }

  /**
   * Write `data` into the active session's PTY once it exists (sessions spawn
   * asynchronously after their panel is created). Retries for a couple of
   * seconds, then gives up — the drop is best-effort, like normal file drops.
   */
  function writeIntoActiveSession(data: string): void {
    let attempts = 0;
    const tryWrite = () => {
      const panel = getApi().activePanel;
      const sessionId = panel ? panelToSession.get(panel.id) : undefined;
      if (sessionId !== undefined) {
        invoke("pty_write", { sessionId, data }).catch((err) =>
          console.error("failed to write dropped path", err)
        );
        return;
      }
      if (++attempts < 40) setTimeout(tryWrite, 50);
    };
    tryWrite();
  }

  let splash!: SplashHandle;

  /**
   * Dismiss the splash and continue: restore the launch directory's saved
   * layout (the deferred auto-resume). `dropPath`, when a folder/file was
   * dropped on the splash, still lands in the shell once a session is up;
   * with nothing to restore, a dropped *folder* becomes the new session's
   * directory instead.
   */
  async function continueFromSplash(dropPath?: string): Promise<void> {
    splash.hide();
    const restored = await resumeSavedWorkspace();
    // Reconcile cursor fill/outline state with the active pane once restored
    // (or fresh) sessions are attached.
    syncTerminalCursorFocus();
    if (dropPath) {
      if (restored) {
        // The drop happened while the splash deferred the resume — land the
        // path in the restored shell, like a normal file drop would.
        writeIntoActiveSession(shellQuote(dropPath));
      } else {
        const isDir = await invoke<boolean>("dir_exists", { path: dropPath }).catch(
          () => false
        );
        if (isDir) {
          // Nothing saved here: open the dropped folder as the session's dir.
          // The default agent when configured, else a plain shell.
          addPanelWithMode(defaultMode() ?? RAW_MODE, undefined, dropPath);
          void invoke("project_touch", { cwd: dropPath }).catch(() => {});
        } else {
          addPanelWithMode(defaultMode() ?? RAW_MODE);
          writeIntoActiveSession(shellQuote(dropPath));
        }
      }
    } else if (!restored) {
      // Fresh start with no saved layout: open the configured default agent.
      // When the setting is "nothing", leave the workspace empty — sessions
      // are started from the sidebar or palette instead.
      const mode = defaultMode();
      if (mode) addPanelWithMode(mode);
    }
  }

  // Always show the welcome screen *before* auto-resuming — except when this
  // window was opened with a session start request (an agent dragged out of
  // another window): then open the requested session directly, so the drag-out
  // gesture lands the agent in the new window without a welcome step.
  const startMode = new URLSearchParams(location.search).get("start");
  if (startMode && isKnownModeAll(startMode, customs())) {
    addPanelWithMode(startMode);
  } else {
    splash = mountSplash(document.getElementById("terminal")!, {
      cwd: getWorkspaceCwd(),
      hasSavedWorkspace,
      // Whether a default session is configured (the resume button label
      // and the skip link reflect it: "nothing" opens an empty workspace).
      hasDefaultSession: defaultMode() !== undefined,
      // The first few visible agents (respecting the settings filter) plus
      // the raw shell, matching the sidebar's session sources.
      quickAgents: sessionModes().slice(0, 4),
      onContinue: () => void continueFromSplash(),
      onOpenProject: (path) => {
        // Open the configured default agent in the chosen directory and mark
        // it recent; with no default configured, open a plain shell there.
        addPanelWithMode(defaultMode() ?? RAW_MODE, undefined, path);
        void invoke("project_touch", { cwd: path }).catch(() => {});
      },
      onNewSession: (mode) => addPanelWithMode(mode),
      onSkip: () => {
        // "Skip — open a fresh session here": open the configured default
        // agent; with the setting at "nothing", dismiss the splash and leave
        // the workspace empty (sessions are started from the sidebar or
        // palette).
        const mode = defaultMode();
        if (mode) addPanelWithMode(mode);
        else splash.hide();
      },
      onForgetProject: (path) => {
        void invoke("workspace_set", { cwd: path, layout: null }).catch(() => {});
      },
      onDropPath: (path) => void continueFromSplash(path),
    });
    // Any panel appearing (sidebar drop, palette action, keyboard shortcut, …)
    // dismisses the splash.
    getApi().onDidAddPanel(() => splash.hide());
  }

  // Persist subsequent layout changes for this launch directory.
  bindWorkspaceSave(getApi());

  // Keep the sidebar workspace strip in sync with the live layout (a new tab
  // or split marks the current slot as having a layout immediately).
  getApi().onDidLayoutChange(() => renderWorkspaceStrip());
  renderWorkspaceStrip();
}

init().catch((err) => console.error("failed to initialize terminal layout", err));
