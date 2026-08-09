/**
 * Session lifecycle: creating the terminal panel component, spawning/killing
 * PTY sessions (with auto-created throwaway worktrees), opening a session at
 * a drop point, and the helpers the palette/context menus/keyboard use to
 * act on the active session.
 */

import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type {
  AddPanelPositionOptions,
  GroupNavigationDirection,
  GroupPanelPartInitParameters,
  IContentRenderer,
} from "dockview";
import {
  agentUsesWorktreeAll,
  isAgentModeAll,
  isKnownModeAll,
  modeCommandAll,
  EDITOR_CMD,
} from "./agents";
import { customs, DEFAULT_MODE, type Mode } from "./modes";
import { getSettings } from "./settings";
import { copyText, readClipboardText } from "./clipboard";
import { setupTodoTxtPanel } from "./todotxt";
import { registerTerminalRoot } from "./file-drop";
import {
  applyTerminalSettings,
  createTerminal,
  ensureTerminalFont,
  isAtBottom,
  setFollowing,
  syncSize,
  syncTerminalCursorFocus,
  terminalFontReady,
  writeToTerminal,
} from "./terminal";
import {
  clearIdle,
  clearIndicator,
  clearNotify,
  ensurePanelStatus,
  renderTitle,
  setBaseTitle,
} from "./titles";
import { trackInputLine, sanitizeTitle, inputLineToTitle, type InputLineState } from "./input-line";
import {
  discardSession,
  getApi,
  panelStatus,
  panelToSession,
  parkedKeyFor,
  parkedSessions,
  pendingOutputs,
  refreshSidebarRunning,
  scheduleWorkspaceRefresh,
  sessions,
  terminalSessions,
  nextPanelId,
  type SessionEntry,
} from "./state";
import { broadcastToAll } from "./broadcast";

/** Result of the `git_worktree_auto_create` IPC command. */
interface AutoWorktree {
  path: string;
  branch: string;
}

/** Random-ish codename used to label a fresh opencode session's worktree. */
const ADJECTIVES = [
  "swift", "bright", "calm", "crisp", "lucky", "mellow", "quick", "silent",
  "summer", "autumn", "bold", "gentle", "golden", "quiet", "rustic", "velvet",
  "amber", "azure", "cobalt", "ember",
] as const;
const NOUNS = [
  "otter", "falcon", "bison", "heron", "lynx", "newt", "oriole", "puma",
  "quail", "rook", "seal", "tiger", "wren", "badger", "crane", "dove", "elk",
  "fox", "gecko", "hawk", "ibis", "jaguar", "koala", "llama",
] as const;

/** A short kebab-case name for a new session's worktree (e.g. "swift-otter"). */
export function generateSessionName(): string {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  const a = ADJECTIVES[buf[0] % ADJECTIVES.length];
  const n = NOUNS[buf[1] % NOUNS.length];
  return `${a}-${n}`;
}

/**
 * Resolve the directory an agent session should spawn in. When no cwd is
 * given (a fresh session), a throwaway worktree is auto-created under the
 * configured base dir. Sessions restored from a saved layout with a still-
 * existing cwd reuse it (and are not deleted on close); a stale cwd falls
 * through to a fresh worktree. Falls back to no cwd (launch dir) when the
 * launch directory is not a git repository.
 */
async function resolveWorktree(
  mode: Mode,
  cwd: string | undefined,
  name: string | undefined
): Promise<{ cwd?: string; name?: string; created: boolean }> {
  if (!isAgentModeAll(mode, customs())) return { cwd, created: false };
  // Agents that opt out of worktrees (the Editor) run in the launch dir:
  // an editor edits real files, and a throwaway checkout would swallow them.
  if (!agentUsesWorktreeAll(mode, customs())) return { cwd, created: false };
  if (cwd) {
    // Restored layout: reuse the saved worktree when it still exists.
    try {
      if (await invoke<boolean>("dir_exists", { path: cwd })) {
        return { cwd, created: false };
      }
    } catch {
      return { cwd, created: false };
    }
    // Fall through: the saved worktree is gone, mint a fresh one.
  }
  const baseDir = getSettings().worktreeBaseDir.trim() || "/tmp";
  const sessionName = (name && name.trim()) || generateSessionName();
  try {
    const created = await invoke<AutoWorktree>("git_worktree_auto_create", {
      name: sessionName,
      baseDir,
    });
    return { cwd: created.path, name: sessionName, created: true };
  } catch {
    // Not inside a git repo (or git unavailable): run in the launch dir.
    return { cwd: undefined, name: undefined, created: false };
  }
}

/**
 * Copy the current selection to the system clipboard whenever it changes
 * (X11-style "copy on select"). Debounced so a mouse drag copies once;
 * a plain click that just clears the selection never copies. Reads the live
 * setting at event time, so toggling it in Settings takes effect immediately.
 */
function setupCopyOnSelect(terminal: Terminal): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastCopied = "";
  terminal.onSelectionChange(() => {
    if (!getSettings().copyOnSelect) return;
    const selection = terminal.getSelection();
    if (!selection) {
      // Selection cleared (plain click): allow re-copying the same text later.
      lastCopied = "";
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!getSettings().copyOnSelect) return;
      try {
        const current = terminal.getSelection();
        if (current && current !== lastCopied) {
          lastCopied = current;
          copyText(current).catch((err) =>
            console.error("clipboard write failed", err)
          );
        }
      } catch {
        // Terminal disposed while the debounce was pending.
      }
    }, 20);
  });
}

/**
 * Middle-click pastes the system clipboard into the terminal (X11-style).
 * Attached in the capture phase on the panel container (an ancestor of
 * xterm's element), so it runs before xterm's own mouse handling and the
 * click is never forwarded to a mouse-mode app (vim/tmux). Stopping
 * propagation also suppresses dockview's own click handling, so the panel
 * is activated explicitly here.
 */
function setupMiddleClickPaste(
  terminal: Terminal,
  panelEl: HTMLElement,
  activate: () => void
): void {
  panelEl.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 1 || !getSettings().pasteWithMiddleClick) return;
      e.preventDefault();
      e.stopPropagation();
      activate();
      readClipboardText()
        .then((text) => {
          if (text) {
            try {
              terminal.focus();
              terminal.paste(text);
            } catch {
              // Terminal disposed while the clipboard read was in flight.
            }
          }
        })
        .catch((err) => console.error("clipboard read failed", err));
    },
    true
  );
  // Prevent xterm's own middle-click paste from firing on release — the
  // mousedown handler above already covers the paste, so mouseup/auxclick
  // must be suppressed to avoid a double paste.
  panelEl.addEventListener(
    "mouseup",
    (e) => {
      if (e.button !== 1 || !getSettings().pasteWithMiddleClick) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );
  panelEl.addEventListener(
    "auxclick",
    (e) => {
      if (e.button !== 1 || !getSettings().pasteWithMiddleClick) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );
}

export function createTerminalComponent(): IContentRenderer {
  const element = document.createElement("div");
  element.classList.add("terminal-panel");

  // Populated when the async spawn resolves; sync() no-ops until then.
  let sessionId: number | undefined;
  let terminal: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let searchAddon: SearchAddon | null = null;

  function sync(): boolean {
    if (sessionId === undefined || !terminal || !fitAddon) return false;
    return syncSize(sessionId, fitAddon, terminal);
  }

  /**
   * Fit + pty_resize once the configured font is loaded. Fitting before the
   * font loads measures a fallback font's cell metrics and resizes the PTY
   * to a bogus size — the shell's startup output then renders at the wrong
   * width/height and the later correction garbles the scrollback. Retries on
   * the next frame if the panel is not yet laid out.
   */
  async function syncWhenReady(): Promise<void> {
    await ensureTerminalFont();
    if (terminal) applyTerminalSettings(terminal, getSettings());
    // syncSize still gates on terminalFontReady; by now it should pass.
    sync();
  }

  return {
    element,
    init({ api: panelApi, containerApi, params }: GroupPanelPartInitParameters) {
      const mode: Mode =
        typeof params.mode === "string" &&
        isKnownModeAll(params.mode, customs())
          ? params.mode
          : DEFAULT_MODE;
      const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
      const requestedName =
        typeof params.name === "string" ? params.name : undefined;
      const userTitle =
        typeof params.userTitle === "string" ? params.userTitle : undefined;

      // Track this panel's tab title (OSC / input-line / user override).
      const st = ensurePanelStatus(panelApi.id, panelApi.title ?? "", userTitle);
      // Let right-click handlers map a terminal back to its panel cheaply.
      element.dataset.panelId = panelApi.id;

      // --- todo.txt: custom renderer, no terminal / PTY ---
      if (mode === "todotxt") {
        invoke<string>("workspace_cwd")
          .then((resolvedCwd) =>
            setupTodoTxtPanel(element, resolvedCwd, () => panelApi.setActive())
          )
          .catch(() =>
            setupTodoTxtPanel(element, "", () => panelApi.setActive())
          );
        return;
      }

      // A restored layout may carry the sessionId of a session parked in the
      // background when its workspace was left. Reuse that session: its PTY
      // kept running and its terminal (scrollback and all) was kept alive
      // off-screen — just move the element back into this panel. Input
      // forwarding, OSC titles and the resize handlers were wired when the
      // terminal was first created, so nothing else needs redoing.
      const parked =
        typeof params.sessionId === "number"
          ? parkedSessions.get(params.sessionId)
          : undefined;
      if (parked) {
        const parkedEntry = sessions.get(params.sessionId as number);
        if (parkedEntry) {
          const parkedKey = parkedKeyFor(params.sessionId as number);
          // Move the parked title/notification status back under the panel's
          // own id (it was re-keyed when the session was parked, so a live
          // panel could not collide with it). Pending timers are re-armed by
          // the next output event.
          const parkedSt = panelStatus.get(parkedKey);
          if (parkedSt) {
            panelStatus.delete(parkedKey);
            panelStatus.set(panelApi.id, parkedSt);
            clearIdle(parkedKey);
            clearNotify(parkedKey);
            // Paint the tab with the status kept across the park (the
            // serialized title may carry a stale indicator prefix).
            renderTitle(panelApi.id);
          }
          parkedSessions.delete(params.sessionId as number);
          sessionId = params.sessionId as number;
          terminal = parkedEntry.terminal;
          terminalSessions.set(terminal, sessionId);
          fitAddon = parkedEntry.fitAddon;
          searchAddon = parkedEntry.searchAddon;
          element.appendChild(parked.element);
          panelToSession.set(panelApi.id, sessionId);
          refreshSidebarRunning();
          scheduleWorkspaceRefresh();
          // The panel registers into its group only after this content
          // component is initialized, so backfill the reference next tick
          // (same as the fresh-spawn path below).
          setTimeout(() => {
            const panel = containerApi.getPanel(panelApi.id);
            if (panel && sessions.has(sessionId!)) parkedEntry.panel = panel;
          }, 0);
          panelApi.onDidDimensionsChange(() => sync());
          panelApi.onDidActiveChange(({ isActive }) => {
            if (isActive) {
              terminal?.focus();
              clearIndicator(panelApi.id);
            }
          });
          // The panel only gets its real size after it is laid out, so defer
          // the first fit + pty resize until the next tick (like the fresh-
          // spawn path, which relies on the async spawn timing).
          setTimeout(() => {
            void syncWhenReady();
            // Give every restored terminal its correct cursor rendering
            // (filled only in the active pane, outlined elsewhere).
            syncTerminalCursorFocus();
          }, 0);
          return;
        }
        // The parked session died in the background (exit event): fall
        // through and spawn a fresh one, like any other restored layout.
        parkedSessions.delete(params.sessionId as number);
      }

      const created = createTerminal();
      terminal = created.terminal;
      fitAddon = created.fitAddon;
      searchAddon = created.searchAddon;
      terminal.open(element);
      // terminal.element is only created by open(); re-apply settings so
      // element-dependent options (font ligatures) take effect. Do not fit
      // here: Dockview may still report a zero-size panel, and fitting that
      // state corrupts xterm's startup buffer with a 2x1 reflow.
      applyTerminalSettings(terminal, getSettings());

      // X11-style mouse conveniences: copy on select, middle-click paste.
      setupCopyOnSelect(terminal);
      setupMiddleClickPaste(terminal, element, () => panelApi.setActive());

      // OS file drops over this pane write the quoted path(s) into its PTY.
      registerTerminalRoot(element, () => sessionId);

      // Track the user's scroll intent so output stays pinned unless the user
      // explicitly scrolled up to read (see `followState`). xterm stopPropagation's
      // wheel/key events at the terminal element, so listen in the capture phase
      // on this panel root, which runs before xterm's own handlers.
      const followAtBottom = () => {
        if (isAtBottom(terminal!)) setFollowing(terminal!, true);
      };
      element.addEventListener(
        "wheel",
        (ev) => {
          if (!terminal?.element?.contains(ev.target as Node)) return;
          if (ev.deltaY < 0) {
            // Scrolling up = reading scrollback: leave follow mode.
            setFollowing(terminal, false);
          } else if (ev.deltaY > 0) {
            // Scrolling down re-enters follow mode once the viewport actually
            // reaches the bottom (trackpad bursts: re-check a frame later).
            requestAnimationFrame(followAtBottom);
          }
          // deltaY === 0 (momentum-scroll end) is handled by onScroll below.
        },
        { capture: true, passive: true }
      );
      element.addEventListener(
        "keydown",
        (ev) => {
          if (!terminal?.element?.contains(ev.target as Node)) return;
          if (ev.key === "PageUp") {
            setFollowing(terminal, false);
          } else if (ev.key === "PageDown" || ev.key === "End") {
            requestAnimationFrame(followAtBottom);
          }
        },
        { capture: true }
      );

      // xterm's onScroll fires for every viewport change (wheel, keyboard,
      // touch, and programmatic scrolls). Use it as a backstop: when the
      // viewport lands at the bottom — including after a momentum-scroll
      // whose final wheel event carries deltaY === 0 — re-enter follow mode
      // so the next output chunk stays pinned.
      terminal.onScroll(() => {
        if (isAtBottom(terminal!)) setFollowing(terminal!, true);
      });

      // Buffer of the input line currently being typed, used to title the
      // pane once the line is submitted to the agent.
      let inputState: InputLineState = { line: "", escape: 0 };

      // Once a program reports an OSC 0/2 title it owns this pane's tab, so
      // input-line titles no longer override it.
      let oscTitleSeen = false;

      // xterm parses OSC 0/1/2 and exposes the parsed title here; let the
      // running program's title win over the derived input-line one — but a
      // user-renamed tab is never overridden.
      //
      // Resolves the panel id and status at fire time so the handler stays
      // correct after a session is parked and restored into a different panel
      // (the captured `panelApi.id` would point at the original panel, whose
      // status was re-keyed).
      terminal.onTitleChange((title) => {
        const sanitized = sanitizeTitle(title);
        if (!sanitized) return;
        oscTitleSeen = true;
        const sid = sessionId;
        const livePanelId = sid !== undefined ? sessions.get(sid)?.panel?.id : panelApi.id;
        if (!livePanelId) return;
        const liveSt = panelStatus.get(livePanelId);
        if (liveSt?.userTitle) return;
        setBaseTitle(livePanelId, sanitized);
      });

      // Register input forwarding immediately so no early keystrokes are lost;
      // it no-ops until the session id is known.
      terminal.onData((data) => {
        if (sessionId !== undefined) {
          const sid = sessionId;
          // Typing happens at the prompt at the bottom of the buffer: the
          // user wants output to follow again (also covers pastes).
          setFollowing(terminal!, true);
          // Track the line being typed; when it is submitted (Enter) it
          // becomes this pane's title before being forwarded to the agent.
          inputState = trackInputLine(inputState, data, (line) => {
            if (isAgentModeAll(mode, customs()) && !oscTitleSeen) {
              const livePanelId = sessions.get(sid)?.panel?.id ?? panelApi.id;
              if (!livePanelId) return;
              const liveSt = panelStatus.get(livePanelId);
              if (liveSt?.userTitle) return;
              const title = inputLineToTitle(line);
              if (title) setBaseTitle(livePanelId, title);
            }
          });
          invoke("pty_write", { sessionId: sid, data }).catch(() => {});
          broadcastToAll(sid, data);
        }
      });

      panelApi.onDidDimensionsChange(() => sync());
      panelApi.onDidActiveChange(({ isActive }) => {
        if (isActive) {
          terminal?.focus();
          clearIndicator(panelApi.id);
        }
      });

      // Resolve the session: agent sessions auto-create a throwaway worktree
      // (unless restored with an existing cwd), then ask the backend for a
      // fresh PTY in the requested mode and directory, and wire the terminal
      // to it once we know its id.
      void resolveWorktree(mode, cwd, requestedName)
        .then(async (resolved) => {
          let id: number;
          try {
            // Auto-run the agent (except raw). Pass the exact command only
            // when the CLI binary differs from the mode id. The Editor agent
            // resolves $EDITOR through the backend so a profile-set value
            // (and a per-platform fallback) is honored; custom agents pass
            // their full command line (args allowed).
            const command = modeCommandAll(mode, customs());
            let autorun: string | undefined;
            if (command === EDITOR_CMD) {
              try {
                autorun = await invoke<string>("editor_command");
              } catch {
                autorun = "vi";
              }
            } else if (command !== undefined && command !== mode) {
              autorun = command;
            }
            // Fit before spawn now that the async worktree resolution gave
            // WebKitGTK time to complete layout (getBoundingClientRect on a
            // just-attached element may return zeros). Gated on the same
            // conditions as syncSize: non-zero element + font loaded.
            let spawnCols: number | undefined;
            let spawnRows: number | undefined;
            if (terminalFontReady()) {
              const el = terminal!.element;
              if (el) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  try { fitAddon!.fit(); } catch { /* ignore */ }
                  if (terminal!.cols > 2 && terminal!.rows > 1) {
                    spawnCols = terminal!.cols;
                    spawnRows = terminal!.rows;
                  }
                }
              }
            }
            id = await invoke<number>("pty_spawn", {
              mode,
              ...(resolved.cwd ? { cwd: resolved.cwd } : {}),
              ...(autorun !== undefined ? { autorun } : {}),
              ...(spawnCols !== undefined ? { cols: spawnCols } : {}),
              ...(spawnRows !== undefined ? { rows: spawnRows } : {}),
            });
          } catch (err) {
            console.error("failed to spawn session", err);
            return;
          }
          sessionId = id;
          terminalSessions.set(terminal!, id);
          const entry: SessionEntry = {
            mode,
            terminal: terminal!,
            fitAddon: fitAddon!,
            searchAddon: searchAddon!,
            cwd: resolved.cwd,
            // Only auto-created throwaway worktrees are force-deleted on close.
            ...(resolved.created ? { worktreePath: resolved.cwd } : {}),
          };
          sessions.set(id, entry);
          panelToSession.set(panelApi.id, id);
          // Persist the sessionId in the panel params so the saved workspace
          // layout can re-attach this session (instead of spawning a new one)
          // when the workspace is restored while the session is still alive.
          panelApi.updateParameters({ sessionId: id });
          refreshSidebarRunning();
          scheduleWorkspaceRefresh();

          const pending = pendingOutputs.get(id);
          if (pending) {
            for (const chunk of pending) terminal && writeToTerminal(terminal, chunk);
            pendingOutputs.delete(id);
          }

          // The panel is registered into its group only after this content
          // component is initialized, so backfill the reference next tick.
          setTimeout(() => {
            const panel = containerApi.getPanel(panelApi.id);
            if (panel && sessions.has(id)) entry.panel = panel;
          }, 0);

          // A fresh agent session's tab takes the worktree's codename.
          if (resolved.name && !st.userTitle && !oscTitleSeen) {
            setBaseTitle(panelApi.id, resolved.name);
          }

          // First pty_resize -> backend flushes the buffered prompt. Wait for
          // the configured font so the fit measures the real cell size (a
          // fallback font would resize the PTY wrong and garble the startup
          // output in the scrollback). syncSize also refuses zero-size panes.
          void syncWhenReady();
          // Reconcile cursor fill/outline state with the active pane instead
          // of unconditionally focusing: the session may have spawned while
          // another pane is focused, and stealing focus would leave this
          // terminal's cursor filled in an inactive pane.
          syncTerminalCursorFocus();
        })
        .catch((err) => console.error("failed to spawn session", err));
    },
    onShow() {
      sync();
    },
  };
}

/** Short tab-title label for a directory: last path segment. */
export function shortLabel(cwd: string): string {
  const last = cwd.split(/[\\/]/).filter(Boolean).pop();
  return last || cwd;
}

export function addPanelWithMode(
  mode: Mode,
  position?: AddPanelPositionOptions,
  cwd?: string,
  titleOverride?: string
) {
  // A fresh agent session without a pinned cwd gets a codename (the tab
  // title and the auto-created worktree's branch are both derived from it).
  // Agents that opt out of worktrees (the Editor) keep the plain mode title.
  const worktree = agentUsesWorktreeAll(mode, customs());
  const name =
    isAgentModeAll(mode, customs()) && !cwd && worktree
      ? titleOverride ?? generateSessionName()
      : undefined;
  const base = isAgentModeAll(mode, customs()) ? (name ?? mode) : "shell";
  const title = cwd ? `${base}@${shortLabel(cwd)}` : base;
  const panel = getApi().addPanel({
    id: nextPanelId(),
    component: "terminal",
    title,
    params: { mode, cwd, ...(name ? { name } : {}) },
    ...(position ? { position } : {}),
  });
  panel.api.setActive();
}

/** The terminal entry backing the currently focused panel, if any. */
export function activeSessionEntry(): SessionEntry | undefined {
  const panel = getApi().activePanel;
  if (!panel) return undefined;
  const sessionId = panelToSession.get(panel.id);
  if (sessionId === undefined) return undefined;
  return sessions.get(sessionId);
}

/**
 * Move focus to the pane adjacent in `direction` (vim-style), if one exists.
 * Returns true when the focus moved; false lets the caller pass the key
 * through to the shell (so Ctrl+L still clears the screen when there is no
 * pane to the right).
 */
export function movePaneFocus(direction: GroupNavigationDirection): boolean {
  const group = getApi().activePanel?.group;
  if (!group) return false;
  const adjacent = getApi().adjacentGroupInDirection(group, direction);
  if (!adjacent) return false;
  // Activate the group via its active panel; our component's
  // onDidActiveChange handler then focuses the terminal there.
  adjacent.activePanel?.api.setActive();
  return true;
}

/**
 * Open a session at the given client coordinates, mirroring dockview's own
 * drop-target zones: split the hovered group by edge quadrant, dock to the
 * outer layout edge, or (fallback) split the active panel to the right.
 * Returns true when a session was opened.
 */
export function openSessionAtPoint(
  clientX: number,
  clientY: number,
  drag: { mode: Mode; cwd?: string }
): boolean {
  const terminalEl = document.getElementById("terminal")!;
  const rect = terminalEl.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return false;

  // Same edge-zone ratio as the dropOverlayModel above (30%).
  const EDGE = 0.3;
  // dockview's outer-layout edge overlay activates within this many px.
  const OUTER_EDGE_PX = 10;

  const el = document.elementFromPoint(clientX, clientY);
  const groupEl = el?.closest(".dv-groupview");
  const group = groupEl
    ? getApi().groups.find((g) => g.element === groupEl)
    : undefined;

  let position: AddPanelPositionOptions | undefined;
  if (group && groupEl) {
    const contentEl = groupEl.querySelector<HTMLElement>(
      ":scope > .dv-content-container"
    );
    if (contentEl) {
      const cr = contentEl.getBoundingClientRect();
      const xp = (clientX - cr.left) / cr.width;
      const yp = (clientY - cr.top) / cr.height;
      let direction: "above" | "below" | "left" | "right" | "within";
      if (xp < EDGE) direction = "left";
      else if (xp > 1 - EDGE) direction = "right";
      else if (yp < EDGE) direction = "above";
      else if (yp > 1 - EDGE) direction = "below";
      else direction = "right"; // center -> split right (kitty-style)
      position = { direction, referenceGroup: group };
    }
  } else {
    // Outer layout edge — mirror dockview's root edge drop target.
    let direction: "above" | "below" | "left" | "right" | undefined;
    if (x < OUTER_EDGE_PX) direction = "left";
    else if (x > rect.width - OUTER_EDGE_PX) direction = "right";
    else if (y < OUTER_EDGE_PX) direction = "above";
    else if (y > rect.height - OUTER_EDGE_PX) direction = "below";
    if (direction) position = { direction };
  }

  if (position) {
    addPanelWithMode(drag.mode, position, drag.cwd);
  } else {
    // The pointer is inside the terminal but not over a group or an
    // outer-edge zone (e.g. a gutter between groups). Default to
    // splitting the active panel to the right so a released session
    // never silently disappears.
    const active = getApi().activePanel;
    addPanelWithMode(
      drag.mode,
      active ? { direction: "right", referencePanel: active } : undefined,
      drag.cwd
    );
  }
  return true;
}

/**
 * Kill a session parked in the background (sidebar ✕): the shell dies, the
 * terminal is disposed, and the parked record is dropped. The workspace's
 * saved layout still lists the panel, so restoring it spawns a fresh session.
 */
export function killParkedSession(sessionId: number): void {
  const entry = sessions.get(sessionId);
  if (entry) {
    invoke("pty_kill", { sessionId }).catch(() => {});
    // Auto-created throwaway worktrees are torn down with the session.
    if (entry.worktreePath) {
      invoke("git_worktree_remove", {
        path: entry.worktreePath,
        force: true,
      }).catch((err) => console.error("failed to remove session worktree", err));
    }
    entry.terminal.dispose();
  }
  const parked = parkedSessions.get(sessionId);
  sessions.delete(sessionId);
  parkedSessions.delete(sessionId);
  discardSession(sessionId);
  if (parked) {
    const parkedKey = parkedKeyFor(sessionId);
    clearIdle(parkedKey);
    clearNotify(parkedKey);
    panelStatus.delete(parkedKey);
  }
  refreshSidebarRunning();
  scheduleWorkspaceRefresh();
}
