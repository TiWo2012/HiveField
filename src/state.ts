/**
 * The app's session/panel state — the single source of truth for everything
 * that spans modules.
 *
 * Previously this state lived as ~20 module-level mutable globals in main.ts,
 * interleaved with UI code and untestable. Here it is owned by one module:
 * every feature (sessions, sidebar, workspace switching, listeners) reads and
 * writes through these maps, so invariants like "one panel ↔ one session"
 * have a single, typed home instead of being maintained by convention.
 *
 * The dockview `api` reference, the panel-id counter and the OS-window focus
 * flag live here too (assigned once at init, read everywhere).
 */

import type { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { DockviewApi, IDockviewPanel } from "dockview";

/** What a session auto-runs: a coding agent, or a plain shell (`"raw"`). */
export type Mode = string;

export interface SessionEntry {
  /** What this session auto-runs: a coding agent (e.g. "codex") or "raw" shell. */
  mode: Mode;
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  panel?: IDockviewPanel;
  /** Directory the session's shell was started in, when it wasn't the launch dir. */
  cwd?: string;
  /** Throwaway worktree this session auto-created; force-deleted on close. */
  worktreePath?: string;
}

/**
 * A session parked in the background while its workspace slot is hidden.
 * The PTY keeps running and the terminal element (scrollback included) is
 * kept alive off-screen; it is moved back into the panel when the workspace
 * is restored, so the session looks exactly as it was left.
 */
export interface ParkedSession {
  /** The workspace slot this session belongs to (to jump back to it). */
  slot: number;
  /** The terminal's content element, held off-screen while parked. */
  element: HTMLElement;
}

/**
 * Per-panel tab-title state: the base title (OSC / input-line / user-renamed)
 * plus an activity/completion indicator prefix, and whether the user pinned a
 * custom name that overrides automatic titles.
 */
export interface PanelStatus {
  baseTitle: string;
  indicator: string;
  userTitle: boolean;
  /**
   * The automatic (OSC / input-line / mode) title in effect before the user
   * pinned a custom name; restoring it when the custom name is cleared. Kept
   * across rename→rename so a second rename still reverts to the automatic
   * title, not the previous custom one.
   */
  preRenameTitle: string | undefined;
  /** True once a finished agent session has been reported to the user. */
  notified: boolean;
}

/** sessionId -> terminal entry. */
export const sessions = new Map<number, SessionEntry>();
/** sessionId -> session kept running in the background (workspace hidden). */
export const parkedSessions = new Map<number, ParkedSession>();

/**
 * Status-map key for a parked session: unique per session, so it can never
 * collide with a live panel's id (serialized layouts can carry the same panel
 * id across slots/runs).
 */
export function parkedKeyFor(sessionId: number): string {
  return `parked:${sessionId}`;
}
/** panel id -> sessionId (panel ids are no longer the session ids). */
export const panelToSession = new Map<string, number>();
/** Output buffered before the terminal for a session was registered. */
export const pendingOutputs = new Map<number, string[]>();
/** panel id -> title/indicator state. */
export const panelStatus = new Map<string, PanelStatus>();
/** panel id -> idle timer id (activity → "done" after inactivity). */
export const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** panel id -> notification timer id (agent done after a quiet window). */
export const notifyTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Terminal → sessionId. Set when a PTY attaches to a terminal (both the
 * fresh-spawn and the parked-restore paths), so a bell can resolve the
 * ringing session's current panel/title at fire time instead of capturing a
 * stale panel id in the `onBell` closure (parked terminals are re-attached
 * to new panels across workspace switches).
 */
export const terminalSessions = new WeakMap<Terminal, number>();

/** Whether the OS window currently has focus (false while the user is elsewhere). */
let windowFocused = true;

/** The live dockview instance (assigned once during init). */
let api: DockviewApi;
let panelCounter = 0;

/** Whether the given panel id is the currently focused/active panel. */
export function isPanelActive(panelId: string): boolean {
  return api?.activePanel?.id === panelId;
}

export function getApi(): DockviewApi {
  return api;
}

/** Set the dockview instance (init only; every other module reads it). */
export function setApi(next: DockviewApi): void {
  api = next;
}

export function isWindowFocused(): boolean {
  return windowFocused;
}

export function setWindowFocused(focused: boolean): void {
  windowFocused = focused;
}

export function nextPanelId(): string {
  return `panel-${++panelCounter}`;
}

/**
 * Bump the panel-id counter past serialized ids (e.g. `panel-1`) restored
 * from a saved layout, so any panel added afterwards gets a fresh id.
 */
export function bumpPanelCounter(max: number): void {
  panelCounter = Math.max(panelCounter, max);
}

/* ---------------------------------------------------------------------------
 * Sidebar refresh hooks.
 *
 * The sidebar's Running list mirrors the live dockview layout, so almost
 * every state change (title, indicator, panel lifecycle, session spawn/kill)
 * wants to re-render it. Rather than have those modules import the sidebar
 * (which would create a cycle — the sidebar itself imports session
 * functions), they call `refreshSidebarRunning()` / `scheduleWorkspaceRefresh()`
 * here, and init registers the sidebar's real implementations once.
 * ------------------------------------------------------------------------- */

let refreshRunningHook: () => void = () => {};
let scheduleWorkspaceRefreshHook: () => void = () => {};

/** Called by init once the sidebar exists. */
export function setSidebarHooks(hooks: {
  refreshRunning: () => void;
  scheduleWorkspaceRefresh: () => void;
}): void {
  refreshRunningHook = hooks.refreshRunning;
  scheduleWorkspaceRefreshHook = hooks.scheduleWorkspaceRefresh;
}

/** Re-render the sidebar's Running list (no-op until the sidebar is built). */
export function refreshSidebarRunning(): void {
  refreshRunningHook();
}

/** Debounce a re-fetch of git/workspace info shown in the sidebar. */
export function scheduleWorkspaceRefresh(): void {
  scheduleWorkspaceRefreshHook();
}
