import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  createDockview,
  positionToDirection,
  type AddPanelPositionOptions,
  type DockviewApi,
  type GroupNavigationDirection,
  type GroupPanelPartInitParameters,
  type IContentRenderer,
  type IDockviewPanel,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import { getTheme } from "./themes";
import {
  DEFAULT_SETTINGS,
  getSettings,
  loadSettings,
  subscribe,
  updateSettings,
  type AppSettings,
} from "./settings";
import { toggleSettings } from "./settings-ui";
import { initDictation } from "./dictation";
import { initSearch, isSearchOpen, openSearch, rerunSearch } from "./search";
import { initPalette, isPaletteOpen, type PaletteItem } from "./palette";
import {
  bindWorkspaceSave,
  getCurrentSlot,
  getWorkspaceSlots,
  renameWorkspace,
  restoreWorkspace,
  switchWorkspace,
} from "./workspace";
import { initFileDrop, registerTerminalRoot } from "./file-drop";
import {
  closeContextMenu,
  isContextMenuOpen,
  showContextMenu,
  type ContextMenuItem,
} from "./context-menu";
import { copyText, readClipboardText } from "./clipboard";
import "./styles.css";

/** What a session auto-runs: a coding agent (opencode / pi), or a plain shell. */
type Mode = "opencode" | "pi" | "raw";

/** Result of the `git_worktree_auto_create` IPC command. */
interface AutoWorktree {
  path: string;
  branch: string;
}

/** A session start request carried across a drag or passed to a panel. */
interface SessionDrag {
  mode: Mode;
  /** Directory the shell should start in (e.g. a worktree path). */
  cwd?: string;
}

/** Custom MIME type used to drag sidebar entries into the dockview layout. */
const DND_MIME = "application/x-hivefield-session";

/** Session modes the sidebar can start. */
const KNOWN_MODES: readonly Mode[] = ["opencode", "pi", "raw"];

/** Modes that auto-run a coding agent (vs. a plain shell). */
const AGENT_MODES: readonly Mode[] = ["opencode", "pi"];

/** Whether `mode` auto-runs a coding agent (and gets an isolated worktree). */
function isAgentMode(mode: Mode): boolean {
  return AGENT_MODES.includes(mode);
}

/** Serialize a session drag payload (JSON, so it carries the optional cwd). */
function serializeDrag(drag: SessionDrag): string {
  return JSON.stringify(drag);
}

/**
 * Read the requested session (mode + optional cwd) from a drag payload.
 * Tolerates platforms (WebKitGTK / Tauri on Linux) that only preserve the
 * `text/plain` target across a drag instead of our custom MIME type, and
 * falls back to a bare mode string for compatibility.
 */
function readDragPayload(dt: DataTransfer | null | undefined): SessionDrag | undefined {
  if (!dt) return undefined;
  let raw: string;
  try {
    raw = dt.getData(DND_MIME) || dt.getData("text/plain");
  } catch {
    // Some WebKitGTK builds throw on getData() for foreign MIME types;
    // the in-memory drag payload covers those cases.
    return undefined;
  }
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { mode?: unknown; cwd?: unknown };
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.mode === "string" &&
      (KNOWN_MODES as readonly string[]).includes(parsed.mode)
    ) {
      return {
        mode: parsed.mode as Mode,
        cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
      };
    }
  } catch {
    // Not JSON — fall through to the bare-mode legacy payload.
  }
  return (KNOWN_MODES as readonly string[]).includes(raw)
    ? { mode: raw as Mode }
    : undefined;
}

/** Safely read the MIME types a drag exposes (WebKitGTK can hide/null them). */
function dataTransferTypes(dt: DataTransfer | null | undefined): string[] {
  if (!dt || !dt.types) return [];
  try {
    return Array.from(dt.types);
  } catch {
    return [];
  }
}

/**
 * True while one of our sidebar sessions is being dragged over a drop
 * target. The module-level flag is authoritative (payloads are unreadable
 * during `dragover` on WebKitGTK); the dataTransfer checks are a fallback for
 * platforms that do expose the payload. dockview's own tab drags set
 * `text/plain` to `""`, so this never collides with its internal DnD.
 */
function isHiveFieldDrag(dt: DataTransfer | null | undefined): boolean {
  if (sidebarDragActive) return true;
  if (!dt) return false;
  const types = dataTransferTypes(dt);
  if (types.includes(DND_MIME)) return true;
  return types.includes("text/plain") && readDragPayload(dt) !== undefined;
}

/**
 * Resolve the session a drop carries: prefer the live dataTransfer payload
 * (reliable in `drop` events), falling back to the payload captured at
 * `dragstart` — but only while a sidebar drag is actually in flight, so a
 * stale payload is never applied to an unrelated drop.
 */
function resolveDragPayload(dt: DataTransfer | null | undefined): SessionDrag | undefined {
  const live = readDragPayload(dt);
  if (live) return live;

  // Fall back to the payload captured at `dragstart`: WebKitGTK strips the
  // transfer entirely (getData returns "" and `types` is empty), and it can
  // also deliver the `drop` *after* `dragend`. The in-memory copy stays
  // resolvable for a short grace window, refreshed while the drag hovers.
  if (Date.now() > pendingSessionExpiresAt) return undefined;
  if (!dt) return pendingSessionDrag;
  try {
    if (dt.getData(DND_MIME) || dt.getData("text/plain")) {
      // The transfer is readable but didn't parse as a session — a foreign
      // drag (external text, a file), not one of ours.
      return undefined;
    }
  } catch {
    // getData threw: treat like a stripped WebKitGTK transfer.
  }
  if (dataTransferTypes(dt).includes("Files")) return undefined;
  return pendingSessionDrag;
}

/** Small floating label used as the custom drag image for sidebar entries. */
function buildDragGhost(source: { icon: string; label: string }): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  const icon = document.createElement("span");
  icon.className = "drag-ghost-icon";
  icon.textContent = source.icon;
  ghost.appendChild(icon);
  ghost.appendChild(document.createTextNode(source.label));
  return ghost;
}

const TERM_OPTIONS: ConstructorParameters<typeof Terminal>[0] = {
  // Colors come from the active theme via applyTerminalSettings().
  cursorBlink: true,
  scrollback: 10000,
  allowProposedApi: true,
};

/** Tab-title prefixes used to signal background activity / command completion. */
const INDICATOR_ACTIVITY = "● ";
const INDICATOR_DONE = "✓ ";

/** Idle window (ms) after which a background tab's activity becomes "done". */
const ACTIVITY_IDLE_MS = 2000;

/** Quiet window (ms) before a finished background agent fires notifications. */
const NOTIFY_IDLE_MS = 8000;

/** OSC 133 shell-integration marker regex (ESC ] 133 ; A/B/C/D ; … BEL|ST). */
const OSC133_SRC = "\\x1b\\]133;([ABCD])(?:[^\\x07\\x1b]*)(?:\\x07|\\x1b\\\\)";
const OSC133_RE = new RegExp(OSC133_SRC, "g");

/**
 * Split a terminal output chunk into shell-integration markers (OSC 133) and
 * the remaining visible text. Only complete markers (with a BEL/ST terminator)
 * are stripped; a marker split across reads is left in the text so xterm can
 * buffer it like any other OSC instead of leaking its payload bytes.
 */
function analyzeOutput(data: string): { markers: string[]; text: string } {
  const markers: string[] = [];
  let text = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = OSC133_RE.exec(data)) !== null) {
    text += data.slice(last, m.index);
    markers.push(m[1]);
    last = m.index + m[0].length;
  }
  text += data.slice(last);
  return { markers, text };
}

/** Convert a #rrggbb hex color to an rgba() string with the given alpha. */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Whether the given panel id is the currently focused/active panel. */
function isPanelActive(panelId: string): boolean {
  return api?.activePanel?.id === panelId;
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
function generateSessionName(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a}-${n}`;
}

interface SessionEntry {
  /** What this session auto-runs: a coding agent ("opencode"/"pi") or "raw" shell. */
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
 * Per-panel tab-title state: the base title (OSC / input-line / user-renamed)
 * plus an activity/completion indicator prefix, and whether the user pinned a
 * custom name that overrides automatic titles.
 */
interface PanelStatus {
  baseTitle: string;
  indicator: string;
  userTitle: boolean;
  /** True once a finished agent session has been reported to the user. */
  notified: boolean;
}

/** sessionId -> terminal entry. */
const sessions = new Map<number, SessionEntry>();
/** panel id -> sessionId (panel ids are no longer the session ids). */
const panelToSession = new Map<string, number>();
/** Output buffered before the terminal for a session was registered. */
const pendingOutputs = new Map<number, string[]>();
/** panel id -> title/indicator state. */
const panelStatus = new Map<string, PanelStatus>();
/** panel id -> idle timer id (activity → "done" after inactivity). */
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** panel id -> notification timer id (agent done after a quiet window). */
const notifyTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Whether the OS window currently has focus (false while the user is elsewhere). */
let windowFocused = true;

let api: DockviewApi;
let panelCounter = 0;

/** Sidebar live sections (populated by buildSidebar). */
let sidebarRunningEl: HTMLElement | null = null;
let sidebarWorkspaceEl: HTMLElement | null = null;

/** Sidebar workspace-slot switcher strip (Ctrl+1…Ctrl+0). */
let sidebarWorkspacesEl: HTMLElement | null = null;

/** Cached workspace info shown in the sidebar's Workspace section. */
let launchCwd: string | undefined;
let gitRoot: string | undefined;
let gitBranch: string | undefined;
let gitWorktreeCount = 0;

/**
 * True while one of our sidebar sessions is being dragged. WebKitGTK does not
 * expose drag payloads through `dataTransfer.getData()` during `dragover`
 * (only `drop` can read them), so dockview's acceptance gate cannot rely on
 * the payload being readable. Set on `dragstart`, cleared on `dragend`.
 */
let sidebarDragActive = false;

/**
 * The payload of the in-flight sidebar drag, kept in memory so the drop
 * handlers still resolve a session even when the webview strips our custom
 * MIME types (and `text/plain`) from the transfer.
 */
let pendingSessionDrag: SessionDrag | undefined;

/**
 * The payload above stays resolvable until this timestamp. WebKitGTK can
 * deliver the final `drop` after `dragend` (or never deliver it at all), so
 * the in-memory payload lives a short grace window past the drag instead of
 * dying at `dragend`. Refreshed on every `dragover` so long drags never
 * expire mid-flight.
 */
let pendingSessionExpiresAt = 0;
const DRAG_GRACE_MS = 1000;

/** True once a `drop` for this drag was delivered anywhere in the app. */
let dragSawDrop = false;

/** True once a session was actually opened for this drag. */
let dragOpenedSession = false;

/**
 * Most recent pointer position (client coords) while the sidebar drag hovered
 * inside the terminal workspace; undefined when it never entered it (or left
 * again). WebKitGTK occasionally swallows the final `drop` entirely after
 * showing the drop overlay, so this is the position used to open the session
 * from the sidebar's `dragend` instead.
 */
let lastSidebarDragOver: { clientX: number; clientY: number } | undefined;

function nextPanelId(): string {
  return `panel-${++panelCounter}`;
}

/** Push the current settings into a terminal's xterm options and Unicode version. */
function applyTerminalSettings(terminal: Terminal, settings: AppSettings): void {
  const theme = getTheme(settings.theme);
  const themeCopy = { ...theme.terminal };
  // When transparency is enabled, the terminal background carries the alpha.
  if (settings.backgroundOpacity < 1 && themeCopy.background) {
    themeCopy.background = hexToRgba(themeCopy.background, settings.backgroundOpacity);
  }
  terminal.options.theme = themeCopy;
  terminal.options.fontFamily = settings.fontFamily;
  terminal.options.fontSize = settings.fontSize;
  terminal.options.lineHeight = settings.lineHeight;
  terminal.options.letterSpacing = settings.letterSpacing;
  terminal.options.fontWeight = settings.fontWeight;
  terminal.options.fontWeightBold = settings.fontWeightBold;
  terminal.options.minimumContrastRatio = settings.minimumContrastRatio;
  terminal.options.cursorBlink = settings.cursorBlink;
  terminal.unicode.activeVersion = settings.unicodeVersion;
  applyFontLigatures(terminal, settings.fontLigatures);
}

/**
 * Push the active theme into the app chrome: the `--hf-*` CSS variables the
 * sidebar/modals/search bar read, the terminal background (with optional
 * alpha), the transparency flag, and the dockview theme.
 */
function applyUiTheme(settings: AppSettings): void {
  const theme = getTheme(settings.theme);
  const ui = theme.ui;
  const root = document.documentElement;
  root.style.setProperty("--hf-base", ui.base);
  root.style.setProperty("--hf-mantle", ui.mantle);
  root.style.setProperty("--hf-crust", ui.crust);
  root.style.setProperty("--hf-surface0", ui.surface0);
  root.style.setProperty("--hf-surface1", ui.surface1);
  root.style.setProperty("--hf-surface2", ui.surface2);
  root.style.setProperty("--hf-text", ui.text);
  root.style.setProperty("--hf-subtext1", ui.subtext1);
  root.style.setProperty("--hf-subtext0", ui.subtext0);
  root.style.setProperty("--hf-overlay0", ui.overlay0);
  root.style.setProperty("--hf-accent", ui.accent);
  root.style.setProperty("--hf-accent-fg", ui.accentFg);
  root.style.setProperty("--hf-green", ui.green);
  root.style.setProperty("--hf-red", ui.red);
  root.style.setProperty("--hf-yellow", ui.yellow);
  root.style.setProperty("--hf-teal", ui.teal);
  root.style.setProperty("--hf-backdrop", hexToRgba(ui.crust, 0.72));
  const alpha = settings.backgroundOpacity;
  const termBg = alpha >= 1 ? (theme.terminal.background ?? ui.base) : hexToRgba(theme.terminal.background ?? ui.base, alpha);
  root.style.setProperty("--hf-terminal-bg", termBg);

  root.dataset.theme = theme.id;
  if (alpha < 1) root.dataset.transparent = "true";
  else delete root.dataset.transparent;

  if (api) api.updateOptions({ theme: theme.dockview });
}

/**
 * Toggle font ligatures. xterm's DOM renderer merges consecutive cells into
 * spans, so the browser applies ligatures when the `calt` OpenType feature is
 * enabled — this is what programming fonts (Fira Code, Maple Mono, JetBrains
 * Mono, ...) use for sequences like `->`, `=>` and `!=`.
 */
function applyFontLigatures(terminal: Terminal, enabled: boolean): void {
  if (!terminal.element) return; // not attached to the DOM yet
  terminal.element.style.fontFeatureSettings = enabled ? '"calt" 1, "liga" 1, "clig" 1' : "normal";
}

/**
 * Ctrl+click (or Cmd+click) opens URL links in the system browser. Hovering
 * shows a small hint tooltip. Links render underlined by xterm's built-in
 * URL detection.
 */
function setupLinks(terminal: Terminal): void {
  let tooltip: HTMLElement | null = null;
  terminal.options.linkHandler = {
    activate: (event, text) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      invoke("open_url", { url: text }).catch((err) =>
        console.error("open_url failed", err)
      );
    },
    hover: (_event, text) => {
      if (!terminal.element) return;
      tooltip?.remove();
      tooltip = document.createElement("div");
      tooltip.className = "xterm-hover";
      tooltip.textContent = text.startsWith("mailto:")
        ? "Ctrl+click to compose"
        : "Ctrl+click to open";
      terminal.element.appendChild(tooltip);
    },
    leave: () => {
      tooltip?.remove();
      tooltip = null;
    },
  };
}

function createTerminal(): { terminal: Terminal; fitAddon: FitAddon; searchAddon: SearchAddon } {
  const terminal = new Terminal(TERM_OPTIONS);
  terminal.loadAddon(new Unicode11Addon());
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  const searchAddon = new SearchAddon({ highlightLimit: 2000 });
  terminal.loadAddon(searchAddon);
  setupLinks(terminal);
  applyTerminalSettings(terminal, getSettings());
  return { terminal, fitAddon, searchAddon };
}

/**
 * True when the terminal's viewport is fully scrolled down (following the
 * cursor). `viewportY` is the buffer line at the top of the viewport and
 * `baseY` the first line of the bottom page, so they coincide exactly when
 * there is no scrollback left below the viewport.
 */
function isAtBottom(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active;
  return buffer.viewportY >= buffer.baseY;
}

/**
 * Write data to a terminal, keeping the viewport pinned to the bottom when it
 * was already there.
 *
 * Guards against an xterm quirk where the internal "user is scrolling" flag
 * gets stuck: scrolling up once, and then having the terminal resized (which
 * reflows the scrollback), can leave the flag set while the viewport is
 * visually back at the bottom. From then on every new output line grows the
 * buffer but not the viewport offset, so the display silently drifts up into
 * scrollback while the cursor keeps advancing below the fold. Re-asserting
 * the bottom position after the chunk is parsed is a no-op when the viewport
 * really is at the bottom, but it clears the stuck flag so subsequent output
 * keeps following.
 */
function writeToTerminal(terminal: Terminal, data: string): void {
  // xterm parses writes asynchronously (its internal write buffer drains on a
  // later tick), so the follow-up must run once this chunk has been parsed.
  const follow = isAtBottom(terminal);
  terminal.write(data, () => {
    if (follow) terminal.scrollToBottom();
  });
}

function syncSize(sessionId: number, fitAddon: FitAddon, terminal: Terminal) {
  try {
    // Resizing reflows the scrollback; like writes, it can leave the viewport
    // (and xterm's scroll-tracking flag) off the bottom. Snap back when the
    // user was following output.
    const follow = isAtBottom(terminal);
    fitAddon.fit();
    if (follow) terminal.scrollToBottom();
    invoke("pty_resize", { sessionId, cols: terminal.cols, rows: terminal.rows }).catch(() => {});
  } catch {
    // ignore until the backend is ready
  }
}

/* ---------------------------------------------------------------------------
 * Panel tab titles: automatic (OSC / input line), user-renamed, and the
 * activity / completion indicator prefixes shown on background tabs.
 * ------------------------------------------------------------------------- */

function ensurePanelStatus(panelId: string, initialTitle: string, userTitle?: string): PanelStatus {
  let st = panelStatus.get(panelId);
  if (st) return st;
  // A restored title may carry a stale indicator prefix — strip it.
  const clean = initialTitle.replace(/^[●✓] /, "");
  st = {
    baseTitle: userTitle ?? clean,
    indicator: "",
    userTitle: typeof userTitle === "string" && userTitle.length > 0,
    notified: false,
  };
  panelStatus.set(panelId, st);
  return st;
}

function renderTitle(panelId: string): void {
  const st = panelStatus.get(panelId);
  const panel = api?.getPanel(panelId);
  if (st && panel) panel.api.setTitle(st.indicator + st.baseTitle);
  // The sidebar's Running list mirrors tab titles/indicators live.
  refreshSidebarRunning();
}

/** Update the base (indicator-free) title, keeping the indicator prefix. */
function setBaseTitle(panelId: string, title: string): void {
  const st = panelStatus.get(panelId);
  if (!st) return;
  st.baseTitle = title;
  renderTitle(panelId);
}

function setIndicator(panelId: string, indicator: string): void {
  const st = panelStatus.get(panelId);
  // Skip redundant updates: output arrives in bursts, and every background
  // chunk would otherwise re-render the sidebar list for no visible change.
  if (!st || st.indicator === indicator) return;
  st.indicator = indicator;
  renderTitle(panelId);
}

function clearIndicator(panelId: string): void {
  clearIdle(panelId);
  setIndicator(panelId, "");
}

/** After activity, mark the tab "done" once it stays quiet for a while. */
function armIdle(panelId: string): void {
  clearIdle(panelId);
  idleTimers.set(
    panelId,
    setTimeout(() => {
      idleTimers.delete(panelId);
      setIndicator(panelId, INDICATOR_DONE);
    }, ACTIVITY_IDLE_MS)
  );
}

function clearIdle(panelId: string): void {
  const t = idleTimers.get(panelId);
  if (t !== undefined) {
    clearTimeout(t);
    idleTimers.delete(panelId);
  }
}

/** Cancel any pending agent-done notification timer for a panel. */
function clearNotify(panelId: string): void {
  const t = notifyTimers.get(panelId);
  if (t !== undefined) {
    clearTimeout(t);
    notifyTimers.delete(panelId);
  }
}

/**
 * Report a finished agent session to the user: a native desktop notification
 * and/or an ntfy push, per the settings. Only fires for agent sessions
 * (opencode / pi), once per completion episode, and skips when the user is
 * actively watching the panel (window focused + panel active).
 */
function notifyAgentDone(panelId: string, entry: SessionEntry): void {
  if (!isAgentMode(entry.mode)) return;
  // The user is looking at this very panel: interrupting them is pointless.
  if (windowFocused && isPanelActive(panelId)) return;
  const st = panelStatus.get(panelId);
  if (!st || st.notified) return;
  st.notified = true;

  const settings = getSettings();
  const label = entry.mode === "pi" ? "pi agent" : "opencode";
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
function armNotify(panelId: string, entry: SessionEntry): void {
  clearNotify(panelId);
  notifyTimers.set(
    panelId,
    setTimeout(() => {
      notifyTimers.delete(panelId);
      notifyAgentDone(panelId, entry);
    }, NOTIFY_IDLE_MS)
  );
}

/* ---------------------------------------------------------------------------
 * Auto-worktrees: every agent session (opencode / pi) gets its own throwaway
 * worktree so parallel agents never share a checkout. Raw sessions and
 * non-git launch directories keep the launch-dir behavior.
 * ------------------------------------------------------------------------- */

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
  if (!isAgentMode(mode)) return { cwd, created: false };
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

/** Maximum length of a pane title derived from a submitted input line. */
const MAX_PANE_TITLE_LEN = 60;

/**
 * Normalize a raw pane title: strip control characters, collapse whitespace,
 * trim, and truncate.
 */
function sanitizeTitle(raw: string): string {
  let title = raw
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length > MAX_PANE_TITLE_LEN) {
    title = `${title.slice(0, MAX_PANE_TITLE_LEN - 1)}…`;
  }
  return title;
}

/**
 * Turn a submitted input line into a tab title.
 */
function inputLineToTitle(line: string): string {
  return sanitizeTitle(line);
}

/** Escape-sequence state needed to tell typed chars from CSI/SS3/OSC sequences. */
interface InputLineState {
  line: string;
  /** 0 = normal, 1 = just saw ESC, 2 = inside a CSI/SS3/OSC sequence. */
  escape: 0 | 1 | 2;
}

/**
 * Update the pending input line from incoming keystrokes. `onSubmit` fires
 * with the buffered line when it is submitted (Enter), then the buffer resets.
 */
function trackInputLine(
  state: InputLineState,
  data: string,
  onSubmit: (line: string) => void
): InputLineState {
  const chars = Array.from(data);
  let { line, escape } = state;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const code = ch.codePointAt(0)!;

    if (escape === 1) {
      // Just saw ESC: only CSI/OSC/SS3/DCS/APC/PM introducers continue.
      escape = [0x5b, 0x5d, 0x50, 0x5e, 0x5f, 0x4f].includes(code) ? 2 : 0;
      continue;
    }
    if (escape === 2) {
      // Inside a sequence: a final byte (0x40-0x7e) or BEL ends it.
      if (code === 0x07 || (code >= 0x40 && code <= 0x7e)) escape = 0;
      else if (code === 0x1b) escape = 1; // possible ST (ESC \)
      continue;
    }

    if (ch === "\x1b") {
      escape = 1;
    } else if (ch === "\r" || ch === "\n") {
      onSubmit(line);
      line = "";
    } else if (ch === "\x7f" || ch === "\x08") {
      // Backspace: drop the last code point (surrogate-safe).
      line = Array.from(line).slice(0, -1).join("");
    } else if (ch === "\x15") {
      // Ctrl+U: clear the whole line.
      line = "";
    } else if (ch === "\x17") {
      // Ctrl+W: delete the last word.
      line = line.replace(/\s*\S+\s*$/, "");
    } else if (ch < " ") {
      // Other control characters: not part of the input line.
    } else {
      line += ch;
    }
  }

  return { line, escape };
}

function createTerminalComponent(): IContentRenderer {
  const element = document.createElement("div");
  element.classList.add("terminal-panel");

  // Populated when the async spawn resolves; sync() no-ops until then.
  let sessionId: number | undefined;
  let terminal: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let searchAddon: SearchAddon | null = null;

  function sync() {
    if (sessionId === undefined || !terminal || !fitAddon) return;
    syncSize(sessionId, fitAddon, terminal);
  }

  return {
    element,
    init({ api: panelApi, containerApi, params }: GroupPanelPartInitParameters) {
      const mode = (params.mode as Mode) ?? "opencode";
      const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
      const requestedName =
        typeof params.name === "string" ? params.name : undefined;
      const userTitle =
        typeof params.userTitle === "string" ? params.userTitle : undefined;

      // Track this panel's tab title (OSC / input-line / user override).
      const st = ensurePanelStatus(panelApi.id, panelApi.title ?? "", userTitle);
      // Let right-click handlers map a terminal back to its panel cheaply.
      element.dataset.panelId = panelApi.id;

      const created = createTerminal();
      terminal = created.terminal;
      fitAddon = created.fitAddon;
      searchAddon = created.searchAddon;
      terminal.open(element);
      // terminal.element is only created by open(); re-apply settings so
      // element-dependent options (font ligatures) take effect.
      applyTerminalSettings(terminal, getSettings());

      // OS file drops over this pane write the quoted path(s) into its PTY.
      registerTerminalRoot(element, () => sessionId);

      // Buffer of the input line currently being typed, used to title the
      // pane once the line is submitted to the agent.
      let inputState: InputLineState = { line: "", escape: 0 };

      // Once a program reports an OSC 0/2 title it owns this pane's tab, so
      // input-line titles no longer override it.
      let oscTitleSeen = false;

      // xterm parses OSC 0/1/2 and exposes the parsed title here; let the
      // running program's title win over the derived input-line one — but a
      // user-renamed tab is never overridden.
      terminal.onTitleChange((title) => {
        const sanitized = sanitizeTitle(title);
        if (!sanitized) return;
        oscTitleSeen = true;
        if (!st.userTitle) setBaseTitle(panelApi.id, sanitized);
      });

      // Register input forwarding immediately so no early keystrokes are lost;
      // it no-ops until the session id is known.
      terminal.onData((data) => {
        if (sessionId !== undefined) {
          // Track the line being typed; when it is submitted (Enter) it
          // becomes this pane's title before being forwarded to the agent.
          inputState = trackInputLine(inputState, data, (line) => {
            if (isAgentMode(mode) && !oscTitleSeen && !st.userTitle) {
              const title = inputLineToTitle(line);
              if (title) setBaseTitle(panelApi.id, title);
            }
          });
          invoke("pty_write", { sessionId, data }).catch(() => {});
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
            id = await invoke<number>("pty_spawn", {
              mode,
              ...(resolved.cwd ? { cwd: resolved.cwd } : {}),
            });
          } catch (err) {
            console.error("failed to spawn session", err);
            return;
          }
          sessionId = id;
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

          sync(); // first pty_resize -> backend flushes the buffered prompt
          terminal?.focus();
        })
        .catch((err) => console.error("failed to spawn session", err));
    },
    onShow() {
      sync();
    },
  };
}

/** Short tab-title label for a directory: last path segment. */
function shortLabel(cwd: string): string {
  const last = cwd.split(/[\\/]/).filter(Boolean).pop();
  return last || cwd;
}

function addPanelWithMode(
  mode: Mode,
  position?: AddPanelPositionOptions,
  cwd?: string,
  titleOverride?: string
) {
  // A fresh agent session without a pinned cwd gets a codename (the tab
  // title and the auto-created worktree's branch are both derived from it).
  const name = isAgentMode(mode) && !cwd ? titleOverride ?? generateSessionName() : undefined;
  const base = isAgentMode(mode) ? (name ?? mode) : "shell";
  const title = cwd ? `${base}@${shortLabel(cwd)}` : base;
  const panel = api.addPanel({
    id: nextPanelId(),
    component: "terminal",
    title,
    params: { mode, cwd, ...(name ? { name } : {}) },
    ...(position ? { position } : {}),
  });
  panel.api.setActive();
}

/** The terminal entry backing the currently focused panel, if any. */
function activeSessionEntry(): SessionEntry | undefined {
  const panel = api.activePanel;
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
function movePaneFocus(direction: GroupNavigationDirection): boolean {
  const group = api.activePanel?.group;
  if (!group) return false;
  const adjacent = api.adjacentGroupInDirection(group, direction);
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
function openSessionAtPoint(
  clientX: number,
  clientY: number,
  drag: SessionDrag
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
    ? api.groups.find(
        (g) => (g as unknown as { element: HTMLElement }).element === groupEl
      )
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
    const active = api.activePanel;
    addPanelWithMode(
      drag.mode,
      active ? { direction: "right", referencePanel: active } : undefined,
      drag.cwd
    );
  }
  return true;
}

/**
 * Remove any drop-target overlay dockview left behind. WebKitGTK can swallow
 * the `drop`/`dragleave` that would normally clear it, leaving a grey
 * highlight stuck on the workspace after the mouse is released.
 */
function clearStuckDropOverlay(): void {
  for (const dropzone of document.querySelectorAll<HTMLElement>(
    ".dv-drop-target-dropzone"
  )) {
    dropzone.parentElement?.classList.remove("dv-drop-target");
    dropzone.remove();
  }
}

/**
 * WebKitGTK workaround: dockview's own drop targets sometimes lose the final
 * `drop` (the preview overlay still shows while hovering — only the release
 * is dropped on the floor) or deliver it late. This layer makes the sidebar
 * drag resilient:
 *
 * - `dragover` records the last hovered workspace position and preventDefaults
 *   so WebKitGTK reliably fires the `drop`, and keeps the in-memory payload
 *   fresh for long drags;
 * - a capture-phase `drop` opens the session itself when dockview did not
 *   already (its overlay state can be missing at the release point);
 * - `dragend` on the sidebar recovers a swallowed `drop` by opening the
 *   session at the last hovered position;
 * - a `mouseup` net covers the worst case where even `dragend` never fires.
 */
function setupSidebarDndFallback() {
  const terminalEl = document.getElementById("terminal")!;
  const inTerminal = (clientX: number, clientY: number) => {
    const r = terminalEl.getBoundingClientRect();
    return (
      clientX >= r.left && clientX <= r.right &&
      clientY >= r.top && clientY <= r.bottom
    );
  };

  // Track where a sidebar drag hovers so a swallowed `drop` can still open
  // the session from `dragend`. Cleared when the pointer leaves the workspace
  // so a release over the sidebar stays a cancel.
  document.addEventListener(
    "dragover",
    (e) => {
      if (!isHiveFieldDrag(e.dataTransfer)) return;
      // Keep the in-memory payload fresh for arbitrarily long drags.
      pendingSessionExpiresAt = Date.now() + DRAG_GRACE_MS;
      if (inTerminal(e.clientX, e.clientY)) {
        // preventDefault so WebKitGTK reliably delivers the final `drop`.
        e.preventDefault();
        lastSidebarDragOver = { clientX: e.clientX, clientY: e.clientY };
      } else {
        lastSidebarDragOver = undefined;
      }
    },
    true
  );

  // Worst-case recovery: if a sidebar drag produced neither a `drop` nor a
  // `dragend` (WebKitGTK can lose the drag state machine after showing the
  // overlay), the first `mouseup` is the release — open the session at the
  // last hovered position.
  document.addEventListener(
    "mouseup",
    () => {
      if (!sidebarDragActive || dragOpenedSession) return;
      if (!lastSidebarDragOver || !pendingSessionDrag) return;
      const { clientX, clientY } = lastSidebarDragOver;
      if (openSessionAtPoint(clientX, clientY, pendingSessionDrag)) {
        dragOpenedSession = true;
      }
      clearStuckDropOverlay();
      sidebarDragActive = false;
      lastSidebarDragOver = undefined;
    },
    true
  );

  // Capture phase: this runs before dockview's own handlers and only acts if
  // they ended up not opening a session.
  document.addEventListener(
    "drop",
    (e) => {
      const drag = resolveDragPayload(e.dataTransfer);
      if (!drag) return;
      dragSawDrop = true;
      e.preventDefault(); // don't let the webview insert/paste the payload
      const before = api.panels.length;
      // dockview handles drops synchronously inside the same event dispatch, so
      // when a session already opened by the time this runs, it handled the drop.
      setTimeout(() => {
        if (api.panels.length > before) return;
        if (openSessionAtPoint(e.clientX, e.clientY, drag)) {
          dragOpenedSession = true;
        }
      }, 0);
    },
    true
  );
}

/* ---------------------------------------------------------------------------
 * Sidebar live sections: running sessions + workspace info. The Running list
 * mirrors the dockview layout (titles, indicators, active panel); Workspace
 * shows the launch directory, git branch/worktrees, and session count.
 * ------------------------------------------------------------------------- */

/** Short uppercase section header ("RUNNING", "WORKSPACE"). */
function sidebarSectionTitle(text: string): HTMLElement {
  const t = document.createElement("div");
  t.className = "sidebar-section-title";
  t.textContent = text;
  return t;
}

/** Status glyph for a sidebar session row (active / busy / done). */
function sessionStatusGlyph(panelId: string): { glyph: string; cls: string } {
  const st = panelStatus.get(panelId);
  const indicator = st?.indicator ?? "";
  if (isPanelActive(panelId)) return { glyph: "▮", cls: "active" };
  if (indicator === INDICATOR_ACTIVITY) return { glyph: "●", cls: "activity" };
  if (indicator === INDICATOR_DONE) return { glyph: "✓", cls: "done" };
  return { glyph: "", cls: "" };
}

/**
 * Rebuild the "Running" sidebar list from the live dockview layout. The list
 * is small, so it's fine to re-render on every title/indicator/active-panel
 * change (renderTitle/setIndicator and the panel lifecycle hooks keep it in
 * sync). Newest session first.
 */
function refreshSidebarRunning(): void {
  if (!sidebarRunningEl) return;
  sidebarRunningEl.replaceChildren();

  const panels = api?.panels ?? [];
  if (panels.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No sessions — drag one in above";
    sidebarRunningEl.appendChild(empty);
    return;
  }

  for (const panel of [...panels].reverse()) {
    const params = panel.api.getParameters() as Record<string, unknown>;
    const mode: Mode =
      params.mode === "pi" ? "pi" : params.mode === "raw" ? "raw" : "opencode";
    const sessionId = panelToSession.get(panel.id);
    const entry = sessionId !== undefined ? sessions.get(sessionId) : undefined;
    const cwd =
      entry?.cwd ?? (typeof params.cwd === "string" ? params.cwd : undefined);
    const { glyph, cls } = sessionStatusGlyph(panel.id);

    const item = document.createElement("div");
    item.className = "sidebar-session";
    item.dataset.mode = mode;
    if (cls === "active") item.classList.add("active");
    item.title = (panel.title ?? "") + (cwd ? ` — ${cwd}` : "");

    const icon = document.createElement("span");
    icon.className = "sidebar-session-icon";
    icon.textContent = modeIcon(mode);
    item.appendChild(icon);

    const body = document.createElement("div");
    body.className = "sidebar-session-body";

    // The tab title carries the ●/✓ indicator prefix; our own status glyph
    // shows it, so strip it here to avoid double-indicating.
    const label = document.createElement("div");
    label.className = "sidebar-session-title";
    label.textContent = (panel.title ?? "").replace(/^[●✓] /, "");
    body.appendChild(label);

    if (cwd) {
      const dir = document.createElement("div");
      dir.className = "sidebar-session-cwd";
      dir.textContent = shortLabel(cwd);
      dir.title = cwd;
      body.appendChild(dir);
    }
    item.appendChild(body);

    const status = document.createElement("span");
    status.className = `sidebar-session-status${cls ? ` ${cls}` : ""}`;
    status.textContent = glyph;
    status.title =
      cls === "active"
        ? "Active session"
        : cls === "activity"
          ? "Producing output"
          : cls === "done"
            ? "Output finished"
            : "";
    item.appendChild(status);

    // Click focuses the pane and its terminal.
    item.addEventListener("click", () => {
      panel.api.setActive();
      const sid = panelToSession.get(panel.id);
      const e = sid !== undefined ? sessions.get(sid) : undefined;
      e?.terminal.focus();
    });

    // Hover-only ✕ closes the session (same as Ctrl+Shift+W on its tab).
    const close = document.createElement("button");
    close.className = "sidebar-session-close";
    close.type = "button";
    close.textContent = "×";
    close.title = "Close session";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      panel.api.close();
    });
    item.appendChild(close);

    sidebarRunningEl.appendChild(item);
  }
}

/** Debounce re-fetching git/workspace info when several sessions change at once. */
let workspaceRefreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleWorkspaceRefresh(): void {
  if (workspaceRefreshTimer !== undefined) clearTimeout(workspaceRefreshTimer);
  workspaceRefreshTimer = setTimeout(() => {
    workspaceRefreshTimer = undefined;
    void refreshWorkspaceInfo();
  }, 250);
}

/**
 * Fetch the launch directory + git worktree info and re-render the Workspace
 * section. Best-effort: on backend errors the section keeps its placeholders.
 */
async function refreshWorkspaceInfo(): Promise<void> {
  try {
    if (launchCwd === undefined) {
      launchCwd = await invoke<string>("workspace_cwd");
    }
    const info = await invoke<{
      root: string | null;
      worktrees: Array<{ branch: string | null; current: boolean }>;
    }>("git_worktrees");
    gitRoot = info.root ?? undefined;
    gitBranch = info.worktrees.find((w) => w.current)?.branch ?? undefined;
    gitWorktreeCount = info.worktrees.length;
  } catch {
    // Backend unavailable — keep whatever we rendered before.
  }
  renderWorkspaceSection();
}

/** Re-render the cached workspace info into the sidebar. */
function renderWorkspaceSection(): void {
  if (!sidebarWorkspaceEl) return;
  sidebarWorkspaceEl.replaceChildren();

  const addRow = (label: string, value: string | undefined, title?: string) => {
    const row = document.createElement("div");
    row.className = "workspace-row";
    const lab = document.createElement("span");
    lab.className = "workspace-row-label";
    lab.textContent = label;
    const val = document.createElement("span");
    val.className = "workspace-row-value";
    val.textContent = value ?? "—";
    if (title) val.title = title;
    row.append(lab, val);
    sidebarWorkspaceEl!.appendChild(row);
  };

  addRow("Directory", launchCwd ? shortLabel(launchCwd) : "…", launchCwd);
  // "—" while the fetch is pending or when the launch dir isn't a git repo.
  addRow("Branch", gitRoot === undefined ? undefined : gitBranch ?? "detached");
  if (gitRoot !== undefined) addRow("Worktrees", String(gitWorktreeCount));
  addRow("Sessions", String(api?.panels.length ?? 0));
}

function buildSidebar() {
  const sidebar = document.getElementById("sidebar")!;

  const title = document.createElement("div");
  title.className = "sidebar-title";
  title.textContent = "New session";
  sidebar.appendChild(title);

  const sources: Array<{ mode: Mode; label: string; icon: string }> = [
    { mode: "opencode", label: "opencode", icon: "✦" },
    { mode: "pi", label: "pi agent", icon: "π" },
    { mode: "raw", label: "raw term", icon: "$" },
  ];

  for (const source of sources) {
    const item = document.createElement("div");
    item.className = "drag-item";
    item.dataset.mode = source.mode;
    item.draggable = true;

    const icon = document.createElement("span");
    icon.className = "drag-icon";
    icon.textContent = source.icon;
    item.appendChild(icon);
    item.appendChild(document.createTextNode(source.label));

    item.addEventListener("dragstart", (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      // Remember the drag in module state: WebKitGTK only surfaces the
      // payload to `drop` handlers, never to `dragover`, and sometimes
      // strips our custom MIME type entirely. The flag drives dockview's
      // drop-overlay acceptance; the stored payload survives any MIME loss.
      const drag: SessionDrag = { mode: source.mode };
      sidebarDragActive = true;
      pendingSessionDrag = drag;
      pendingSessionExpiresAt = Date.now() + DRAG_GRACE_MS;
      dragSawDrop = false;
      dragOpenedSession = false;
      lastSidebarDragOver = undefined;
      // Advertise the session under our own MIME type *and* as plain text:
      // some WebKitGTK builds only surface the text/plain target across a
      // drag. JSON carries the mode plus an optional worktree cwd.
      const payload = serializeDrag(drag);
      dt.setData(DND_MIME, payload);
      dt.setData("text/plain", payload);
      dt.effectAllowed = "copy";

      // Custom ghost so the drag reads as a session, not a text blob.
      const ghost = buildDragGhost(source);
      document.body.appendChild(ghost);
      dt.setDragImage(ghost, 8, 8);
      requestAnimationFrame(() => ghost.remove());
    });

    // `dragend` fires whether the drag was dropped or cancelled. WebKitGTK
    // sometimes swallows the final `drop` (the overlay was shown, the release
    // did nothing): if no drop was delivered and no session opened, release
    // the session at the last hovered workspace position instead. The
    // in-memory payload stays resolvable for a grace window so a `drop` that
    // arrives after `dragend` still opens its session.
    item.addEventListener("dragend", () => {
      sidebarDragActive = false;
      if (
        !dragOpenedSession &&
        !dragSawDrop &&
        lastSidebarDragOver &&
        pendingSessionDrag
      ) {
        const { clientX, clientY } = lastSidebarDragOver;
        if (openSessionAtPoint(clientX, clientY, pendingSessionDrag)) {
          dragOpenedSession = true;
        }
      }
      // Clear any drop overlay dockview never got a chance to remove.
      clearStuckDropOverlay();
      lastSidebarDragOver = undefined;
    });

    sidebar.appendChild(item);
  }

  // Live list of running sessions (rebuilds as panes come and go).
  const runningSection = document.createElement("div");
  runningSection.className = "sidebar-section running";
  runningSection.appendChild(sidebarSectionTitle("Running"));
  const runningList = document.createElement("div");
  runningList.className = "sidebar-running-list";
  runningSection.appendChild(runningList);
  sidebarRunningEl = runningList;
  sidebar.appendChild(runningSection);

  // Workspace switcher: ten slots, Ctrl+1…Ctrl+0 to jump. Click a row to
  // switch (empty slots start a fresh workspace), double-click to rename.
  const wsStripSection = document.createElement("div");
  wsStripSection.className = "sidebar-section workspaces";
  wsStripSection.appendChild(sidebarSectionTitle("Workspaces"));
  const wsStrip = document.createElement("div");
  wsStrip.className = "sidebar-workspace-strip";
  wsStripSection.appendChild(wsStrip);
  sidebar.appendChild(wsStripSection);
  sidebarWorkspacesEl = wsStrip;
  renderWorkspaceStrip();

  // Workspace info: launch dir, git branch/worktrees, session count.
  const wsSection = document.createElement("div");
  wsSection.className = "sidebar-section workspace";
  wsSection.appendChild(sidebarSectionTitle("Workspace"));
  const wsBody = document.createElement("div");
  wsBody.className = "sidebar-workspace-body";
  wsSection.appendChild(wsBody);
  sidebarWorkspaceEl = wsBody;
  sidebar.appendChild(wsSection);

  // Handy shortcut reminders.
  const shortcuts = document.createElement("div");
  shortcuts.className = "sidebar-shortcuts";
  for (const [keys, label] of [
    ["Ctrl+Shift+T", "new tab"],
    ["Ctrl+Shift+P", "palette"],
    ["Ctrl+Shift+F", "find"],
    ["Ctrl+1-0", "workspaces"],
  ] as const) {
    const row = document.createElement("div");
    const kbd = document.createElement("kbd");
    kbd.textContent = keys;
    row.appendChild(kbd);
    row.appendChild(document.createTextNode(` ${label}`));
    shortcuts.appendChild(row);
  }
  sidebar.appendChild(shortcuts);

  const settingsBtn = document.createElement("button");
  settingsBtn.className = "sidebar-settings";
  settingsBtn.type = "button";
  settingsBtn.title = "Settings (Ctrl+,)";
  settingsBtn.textContent = "⚙";
  settingsBtn.addEventListener("click", toggleSettings);
  sidebar.appendChild(settingsBtn);
}

/* ---------------------------------------------------------------------------
 * Workspace switching (Ctrl+1…Ctrl+0) + sidebar slot strip
 * --------------------------------------------------------------------------- */

/**
 * Jump to a workspace slot: save the current layout, restore the target
 * (closing live panels and respawning their sessions from the saved layout),
 * seed empty slots with a fresh opencode panel, and refresh the strip.
 */
function switchToWorkspace(slot: number): void {
  void switchWorkspace(api, slot).then((restored) => {
    // Restored panels carry serialized ids like `panel-1`, so bump the
    // counter past them before any new panel is added (avoids duplicates).
    for (const panel of api.panels) {
      const m = /^panel-(\d+)$/.exec(panel.id);
      if (m) panelCounter = Math.max(panelCounter, parseInt(m[1], 10));
    }
    if (!restored) addPanelWithMode("opencode");
    renderWorkspaceStrip();
  });
}

/** Re-render the sidebar workspace-slot strip from the workspace module. */
function renderWorkspaceStrip(): void {
  if (!sidebarWorkspacesEl) return;
  sidebarWorkspacesEl.replaceChildren();
  const current = getCurrentSlot();
  for (const ws of getWorkspaceSlots()) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "workspace-slot";
    if (ws.slot === current) row.classList.add("active");

    const num = document.createElement("span");
    num.className = "workspace-slot-num";
    num.textContent = String(ws.slot);

    const label = document.createElement("span");
    label.className = "workspace-slot-label";
    label.textContent =
      ws.name ?? (ws.hasLayout ? `workspace ${ws.slot}` : "empty");

    const dot = document.createElement("span");
    dot.className = "workspace-slot-dot";
    if (ws.hasLayout) dot.classList.add("filled");

    const shortcut = ws.slot === 10 ? "Ctrl+0" : `Ctrl+${ws.slot}`;
    row.title =
      `Workspace ${ws.slot}${ws.name ? ` (${ws.name})` : ""} — ${shortcut}` +
      (ws.slot === current ? " (current)" : "") +
      ". Click to switch, double-click to rename.";
    row.append(num, label, dot);
    row.addEventListener("click", () => switchToWorkspace(ws.slot));
    row.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      void renameWorkspacePrompt(ws.slot);
    });
    sidebarWorkspacesEl!.appendChild(row);
  }
}

/** Prompt for a workspace slot's name (double-click a strip row). */
async function renameWorkspacePrompt(slot: number): Promise<void> {
  const ws = getWorkspaceSlots().find((w) => w.slot === slot);
  const name = await openPromptModal({
    title: `Rename workspace ${slot}`,
    label: "Workspace name",
    placeholder: "e.g. docs, backend, agents",
    hint: "Leave empty to clear the name. Ctrl+1…Ctrl+0 switches workspaces.",
    value: ws?.name ?? "",
    confirmText: "Save",
  });
  if (name === null) return;
  await renameWorkspace(slot, name);
  renderWorkspaceStrip();
}

/* ---------------------------------------------------------------------------
 * Prompt modal + tab rename
 * ------------------------------------------------------------------------- */

interface PromptModalOptions {
  title: string;
  label: string;
  placeholder?: string;
  hint?: string;
  value?: string;
  confirmText?: string;
}

/**
 * A small single-input modal. Resolves with the trimmed input on confirm
 * (possibly empty), or `null` when cancelled.
 */
function openPromptModal(opts: PromptModalOptions): Promise<string | null> {
  document.querySelector(".settings-backdrop")?.remove();

  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "settings-backdrop";

    const modal = document.createElement("div");
    modal.className = "settings-modal prompt-modal";

    const header = document.createElement("div");
    header.className = "settings-header";
    const title = document.createElement("h1");
    title.className = "settings-title";
    title.textContent = opts.title;
    const closeBtn = document.createElement("button");
    closeBtn.className = "settings-close";
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => {
      backdrop.remove();
      resolve(null);
    });
    header.append(title, closeBtn);
    modal.appendChild(header);

    const body = document.createElement("div");
    body.className = "settings-body";
    const label = document.createElement("label");
    label.className = "settings-label";
    label.textContent = opts.label;
    body.appendChild(label);
    const input = document.createElement("input");
    input.className = "settings-text";
    input.placeholder = opts.placeholder ?? "";
    input.autocomplete = "off";
    input.value = opts.value ?? "";
    body.appendChild(input);
    if (opts.hint) {
      const hint = document.createElement("div");
      hint.className = "settings-hint";
      hint.textContent = opts.hint;
      body.appendChild(hint);
    }
    modal.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "settings-footer";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "settings-reset";
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      backdrop.remove();
      resolve(null);
    });
    const doneBtn = document.createElement("button");
    doneBtn.className = "settings-done";
    doneBtn.type = "button";
    doneBtn.textContent = opts.confirmText ?? "OK";
    doneBtn.addEventListener("click", () => {
      backdrop.remove();
      resolve(input.value.trim());
    });
    footer.append(cancelBtn, doneBtn);
    modal.appendChild(footer);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    input.focus();
    input.select();

    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) {
        backdrop.remove();
        resolve(null);
      }
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doneBtn.click();
      if (e.key === "Escape") {
        backdrop.remove();
        resolve(null);
      }
    });
  });
}

/** Map a dockview tab DOM element back to its panel (for double-click rename). */
function panelForTabElement(tabEl: HTMLElement): IDockviewPanel | undefined {
  const groupEl = tabEl.closest(".dv-groupview");
  if (!groupEl) return undefined;
  const group = api.groups.find(
    (g) => (g as unknown as { element: HTMLElement }).element === groupEl
  );
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
async function renamePanel(panel: IDockviewPanel): Promise<void> {
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
    status.baseTitle = value;
    panel.api.updateParameters({ userTitle: value });
    renderTitle(panel.id);
  } else {
    // Revert: next OSC / input-line title wins again.
    status.baseTitle = status.baseTitle;
    panel.api.updateParameters({ userTitle: null });
    renderTitle(panel.id);
  }
}

/* ---------------------------------------------------------------------------
 * Right-click context menu: new sessions / splits, copy & paste, and
 * per-panel actions (find, rename, close).
 * ------------------------------------------------------------------------- */

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

/** Session modes offered by the context menu. */
const MENU_MODES: Array<{ mode: Mode; label: string; icon: string }> = [
  { mode: "opencode", label: "opencode", icon: "✦" },
  { mode: "pi", label: "pi agent", icon: "π" },
  { mode: "raw", label: "raw term", icon: "$" },
];

/**
 * The "New split" submenu: one entry per session mode, each with the four
 * split directions. The new session opens adjacent to `referencePanel`.
 */
function newSplitMenuItems(referencePanel: IDockviewPanel): ContextMenuItem[] {
  return MENU_MODES.map(({ mode, label, icon }) => ({
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

/** Context menu for a right-clicked terminal pane. */
function buildPaneContextMenu(panel: IDockviewPanel): ContextMenuItem[] {
  const sessionId = panelToSession.get(panel.id);
  const entry = sessionId !== undefined ? sessions.get(sessionId) : undefined;
  const hasSelection = entry?.terminal.hasSelection() ?? false;

  return [
    ...MENU_MODES.map(({ mode, label, icon }) => ({
      label: `New ${label} tab`,
      icon,
      run: () => addPanelWithMode(mode),
    })),
    { separator: true },
    { label: "New split", icon: "▣", submenu: newSplitMenuItems(panel) },
    { separator: true },
    {
      label: "Copy",
      icon: "⧉",
      disabled: !hasSelection,
      run: () => copyTerminalSelection(panel),
    },
    { label: "Paste", icon: "⎘", run: () => pasteIntoTerminal(panel) },
    { separator: true },
    {
      label: "Find",
      icon: "⌕",
      shortcut: "Ctrl+Shift+F",
      run: () => openSearch(),
    },
    {
      label: "Rename tab",
      icon: "✎",
      shortcut: "Ctrl+Shift+R",
      run: () => void renamePanel(panel),
    },
    { separator: true },
    {
      label: "Close panel",
      icon: "✕",
      shortcut: "Ctrl+Shift+W",
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
      shortcut: "Ctrl+Shift+R",
      run: () => void renamePanel(panel),
    },
    {
      label: "Close tab",
      icon: "✕",
      shortcut: "Ctrl+Shift+W",
      danger: true,
      run: () => panel.api.close(),
    },
  ];
}

/** Map a dockview tab element back to its panel (for right-click menus). */
function panelForGroupElement(groupEl: HTMLElement): IDockviewPanel | undefined {
  const group = api.groups.find(
    (g) => (g as unknown as { element: HTMLElement }).element === groupEl
  );
  return group?.activePanel ?? group?.panels[0];
}

/**
 * Right-click handling across the terminal workspace (capture phase, before
 * xterm or dockview see the event): terminal panes, tabs, and split gutters
 * each get their own menu; anything else keeps the default behavior.
 */
function setupContextMenu(): void {
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
        const panel = id ? api.getPanel(id) : undefined;
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

/** Backend event wiring: PTY output/exit, plus the tab activity indicator. */
async function registerGlobalListeners() {
  await listen<{ sessionId: number; data: string }>("pty://output", (event) => {
    const { sessionId, data } = event.payload;
    const entry = sessions.get(sessionId);
    if (entry) {
      // Shell-integration markers drive the tab completion indicator; any
      // remaining text is written to the terminal.
      const { markers, text } = analyzeOutput(data);
      if (text) writeToTerminal(entry.terminal, text);
      const panel = entry.panel;
      if (panel && panelStatus.has(panel.id)) {
        // Agent-done notifications run for every panel (active or not): a
        // completion signal (OSC 133;D or a quiet window after output)
        // reports "done"; notifyAgentDone decides whether the user is
        // actually watching and skips if so.
        const st = panelStatus.get(panel.id);
        if (st && isAgentMode(entry.mode)) {
          if (markers.includes("D")) {
            clearNotify(panel.id);
            notifyAgentDone(panel.id, entry);
          } else if (markers.includes("C") || text.length > 0) {
            // New command started / visible output: a fresh completion
            // episode, so the next "done" may notify again.
            st.notified = false;
            if (text.length > 0) armNotify(panel.id, entry);
          }
        }
        // The tab activity/completion indicator only applies to background
        // tabs; the active one is already in view.
        if (!isPanelActive(panel.id)) {
          if (markers.includes("D")) {
            // Command finished (OSC 133;D): mark the tab done immediately.
            clearIdle(panel.id);
            setIndicator(panel.id, INDICATOR_DONE);
          } else if (markers.includes("C")) {
            // Command started: nothing to show yet.
          } else if (text.length > 0) {
            // Visible output in a background tab: activity, then "done" once
            // the tab stays quiet.
            setIndicator(panel.id, INDICATOR_ACTIVITY);
            armIdle(panel.id);
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
      writeToTerminal(entry.terminal, `\r\n[process exited with code ${code}]\r\n`);
    }
  });
}

async function init() {
  await loadSettings();

  // Track OS window focus so agent-done notifications still fire while the
  // user is in another application (even when the agent's panel is active).
  const win = getCurrentWindow();
  windowFocused = await win.isFocused().catch(() => true);
  win.onFocusChanged(({ payload }) => {
    windowFocused = payload;
  });

  // Keep every open terminal in sync with the settings, and let the whole UI
  // use the chosen font family + theme (sidebar, tabs, settings page).
  subscribe((settings) => {
    for (const [id, entry] of sessions) {
      applyTerminalSettings(entry.terminal, settings);
      syncSize(id, entry.fitAddon, entry.terminal);
    }
    document.documentElement.style.setProperty(
      "--hivefield-font",
      `"${settings.fontFamily}", monospace`
    );
    applyUiTheme(settings);
  });

  await registerGlobalListeners();

  buildSidebar();
  refreshSidebarRunning();
  void refreshWorkspaceInfo();

  api = createDockview(document.getElementById("terminal")!, {
    createComponent: createTerminalComponent,
    disableFloatingGroups: true,
    theme: getTheme(getSettings().theme).dockview,
    dropOverlayModel: ({ location }) => {
      // Wider edge zones on the terminal content so dropping a session as a
      // split in a chosen direction is easy to hit (default is 20%).
      if (location !== "content") return undefined;
      return { activationSize: { value: 30, type: "percentage" } };
    },
  });
  applyUiTheme(getSettings());

  // Accept our sidebar drags so dockview shows the drop-target overlay.
  api.onUnhandledDragOver((event) => {
    if (isHiveFieldDrag((event.nativeEvent as DragEvent).dataTransfer)) {
      event.accept();
    }
  });

  // Create a new session where the sidebar entry was dropped. Session drops
  // always open as a *split*, never as a tab: dropping in the middle of a
  // pane splits to the right (kitty-style default) so users don't have to
  // hit a thin edge or drag a tab out afterwards. Ctrl+Shift+T is still the
  // way to open a session as a tab.
  api.onDidDrop((event) => {
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
      dragOpenedSession = true;
    } catch (err) {
      // A bad position must not swallow the drop: the document-level
      // fallback opens the session at the pointer instead.
      console.error("drop failed to open session", err);
    }
  });

  // WebKitGTK can drop the final `drop` near pane top/bottom edges, deliver
  // it late, or swallow it entirely; make sure a released session still opens.
  setupSidebarDndFallback();

  api.onDidRemovePanel((panel: IDockviewPanel) => {
    const sessionId = panelToSession.get(panel.id);
    if (sessionId === undefined) return;
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
    sessions.delete(sessionId);
    panelToSession.delete(panel.id);
    pendingOutputs.delete(sessionId);
    clearIdle(panel.id);
    clearNotify(panel.id);
    panelStatus.delete(panel.id);
    refreshSidebarRunning();
    scheduleWorkspaceRefresh();
    renderWorkspaceStrip();
    // If the searched terminal just went away, move the highlights onto
    // whatever is active now (or clear them if nothing is).
    if (isSearchOpen()) rerunSearch();
  });

  setupKeyboard();
  setupContextMenu();

  initDictation(() => {
    const panel = api.activePanel;
    if (!panel) return undefined;
    return panelToSession.get(panel.id);
  });

  // Floating search bar (Ctrl+Shift+F) over the terminal workspace.
  initSearch({
    container: document.getElementById("terminal")!,
    getActive: () => activeSessionEntry(),
  });

  // Command palette (Ctrl+Shift+P): fuzzy finder over panes and actions.
  initPalette({
    getItems: buildPaletteItems,
    onClose: () => activeSessionEntry()?.terminal.focus(),
  });

  // OS file drops: insert shell-quoted paths into the pane under the pointer,
  // falling back to the active session when the drop misses every pane.
  initFileDrop(() => {
    const panel = api.activePanel;
    if (!panel) return undefined;
    return panelToSession.get(panel.id);
  }).catch((err) => console.error("failed to init file drop", err));

  // If the user switches panels while searching, move the highlights to the
  // newly active terminal instead of leaving them stale on the old one, and
  // clear any activity/completion indicator on the newly focused tab.
  api.onDidActivePanelChange(() => {
    if (isSearchOpen()) rerunSearch();
    refreshSidebarRunning();
    const panel = api.activePanel;
    if (panel) clearIndicator(panel.id);
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

  // Restore the saved per-cwd layout (no-op when nothing was saved). Restored
  // panels carry serialized ids like `panel-1`, so bump the counter past them
  // before any new panel is added to avoid duplicate ids.
  const restored = await restoreWorkspace(api);
  if (restored) {
    for (const panel of api.panels) {
      const m = /^panel-(\d+)$/.exec(panel.id);
      if (m) panelCounter = Math.max(panelCounter, parseInt(m[1], 10));
    }
  } else {
    addPanelWithMode("opencode");
  }

  // Persist subsequent layout changes for this launch directory.
  bindWorkspaceSave(api);

  // Keep the sidebar workspace strip in sync with the live layout (a new tab
  // or split marks the current slot as having a layout immediately).
  api.onDidLayoutChange(() => renderWorkspaceStrip());
  renderWorkspaceStrip();
}

/** Ctrl+H/J/K/L move focus between panes (vim-style). */
const MOVEMENT_KEYS: Record<string, GroupNavigationDirection> = {
  h: "left",
  j: "down",
  k: "up",
  l: "right",
};

/**
 * Build the command palette's item list: every open pane (with its rendered
 * title, mode icon, and cwd detail) followed by the available actions. Called
 * fresh every time the palette opens so the list reflects the live layout.
 */

/** Sidebar / palette icon for a session mode. */
function modeIcon(mode: Mode): string {
  if (mode === "pi") return "π";
  return mode === "opencode" ? "✦" : "$";
}

function buildPaletteItems(): PaletteItem[] {
  const items: PaletteItem[] = [];

  for (const panel of api.panels) {
    const params = panel.api.getParameters() as Record<string, unknown>;
    const mode: Mode =
      params.mode === "pi" ? "pi" : params.mode === "raw" ? "raw" : "opencode";
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
      icon: modeIcon(mode),
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
    {
      label: "New opencode tab",
      detail: "Ctrl+Shift+T",
      icon: "✦",
      run: () => addPanelWithMode("opencode"),
    },
    {
      label: "New pi agent tab",
      icon: "π",
      run: () => addPanelWithMode("pi"),
    },
    {
      label: "New raw term tab",
      icon: "$",
      run: () => addPanelWithMode("raw"),
    },
    {
      label: "New opencode split",
      icon: "✦",
      run: () => addPanelWithMode("opencode", { direction: "right" }),
    },
    {
      label: "New pi agent split",
      icon: "π",
      run: () => addPanelWithMode("pi", { direction: "right" }),
    },
    {
      label: "New raw term split",
      icon: "$",
      run: () => addPanelWithMode("raw", { direction: "right" }),
    },
    {
      label: "Find in terminal",
      detail: "Ctrl+Shift+F",
      icon: "⌕",
      run: () => openSearch(),
    },
    {
      label: "Focus pane left",
      detail: "Ctrl+H",
      run: () => movePaneFocus("left"),
    },
    {
      label: "Focus pane right",
      detail: "Ctrl+L",
      run: () => movePaneFocus("right"),
    },
    {
      label: "Focus pane up",
      detail: "Ctrl+K",
      run: () => movePaneFocus("up"),
    },
    {
      label: "Focus pane down",
      detail: "Ctrl+J",
      run: () => movePaneFocus("down"),
    },
    {
      label: "Rename active tab",
      detail: "Ctrl+Shift+R",
      run: () => {
        const panel = api.activePanel;
        if (panel) void renamePanel(panel);
      },
    },
    {
      label: "Close active panel",
      detail: "Ctrl+Shift+W",
      run: () => api.activePanel?.api.close(),
    },
    {
      label: "Settings",
      detail: "Ctrl+,",
      icon: "⚙",
      run: () => toggleSettings(),
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
          ? `Ctrl+${ws.slot === 10 ? "0" : ws.slot}`
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

function setupKeyboard() {
  const settingsOpen = () => document.querySelector(".settings-backdrop") !== null;
  // While the search bar or command palette is up, keystrokes belong to their
  // inputs, so the global shortcuts below must not fire.
  const uiOpen = () =>
    settingsOpen() || isSearchOpen() || isPaletteOpen() || isContextMenuOpen();

  // Ctrl+Shift+T spawns an opencode tab, Ctrl+Shift+W closes the active panel.
  // Bubble phase is fine here: these combos are not printable terminal keys.
  window.addEventListener("keydown", (e) => {
    if (uiOpen()) return;
    if (e.ctrlKey && e.shiftKey && (e.key === "T" || e.key === "t")) {
      e.preventDefault();
      addPanelWithMode("opencode");
    }
    if (e.ctrlKey && e.shiftKey && (e.key === "W" || e.key === "w")) {
      e.preventDefault();
      api.activePanel?.api.close();
    }
    // Ctrl+Shift+R renames the active tab.
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === "R" || e.key === "r")) {
      e.preventDefault();
      const panel = api.activePanel;
      if (panel) void renamePanel(panel);
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === ",") {
      e.preventDefault();
      toggleSettings();
    }
    // Ctrl+Shift+V pastes the system clipboard into the active terminal;
    // Ctrl+Shift+C copies its selection. WebViews don't bind these combos
    // natively (Ctrl+V/C are the browser defaults, and Ctrl+C is SIGINT in
    // the shell), so they would otherwise fall through as no-ops.
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === "V" || e.key === "v")) {
      e.preventDefault();
      const entry = activeSessionEntry();
      if (entry) {
        void readText()
          .then((text) => entry.terminal.paste(text))
          .catch((err) => console.error("clipboard read failed", err));
      }
    }
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === "C" || e.key === "c")) {
      const selection = activeSessionEntry()?.terminal.getSelection() ?? "";
      if (selection) {
        e.preventDefault();
        void writeText(selection).catch((err) => console.error("clipboard write failed", err));
      }
      // Without a selection the key is left alone and falls through to the
      // shell, matching other terminals.
    }
  });

  // Ctrl+H/J/K/L vim-style pane movement, Ctrl+1…Ctrl+0 workspace switching,
  // plus font-size zoom (Ctrl+= / -). Registered in the CAPTURE phase so the
  // keys are intercepted before xterm sees them (otherwise Ctrl+H is
  // backspace, Ctrl+J newline, Ctrl+K kill-line, Ctrl+L clear-screen). If
  // there is no adjacent pane in that direction the key falls through to the
  // terminal.
  window.addEventListener(
    "keydown",
    (e) => {
      if (uiOpen()) return;
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        // Ctrl+1…Ctrl+9 / Ctrl+0 jump to workspace slots 1…10. Switching to
        // an empty slot starts a fresh workspace there.
        const workspaceSlot =
          e.key >= "1" && e.key <= "9"
            ? parseInt(e.key, 10)
            : e.key === "0"
              ? 10
              : undefined;
        if (workspaceSlot !== undefined) {
          e.preventDefault();
          e.stopPropagation();
          switchToWorkspace(workspaceSlot);
          return;
        }
        // Font-size zoom.
        const zoomBy = (delta: number) => {
          const s = getSettings();
          const next =
            delta === 0
              ? DEFAULT_SETTINGS.fontSize
              : Math.max(6, Math.min(48, s.fontSize + delta));
          void updateSettings({ fontSize: next });
        };
        if (e.key === "=") {
          e.preventDefault();
          e.stopPropagation();
          zoomBy(1);
          return;
        }
        if (e.key === "-") {
          e.preventDefault();
          e.stopPropagation();
          zoomBy(-1);
          return;
        }
        const direction = MOVEMENT_KEYS[e.key.toLowerCase()];
        if (direction && movePaneFocus(direction)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    },
    true
  );
}

init().catch((err) => console.error("failed to initialize terminal layout", err));
