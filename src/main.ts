import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
import { bindWorkspaceSave, restoreWorkspace } from "./workspace";
import "./styles.css";

/** What a session auto-runs: the opencode agent, or a plain shell. */
type Mode = "opencode" | "raw";

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
const KNOWN_MODES: readonly Mode[] = ["opencode", "raw"];

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
  const raw = dt.getData(DND_MIME) || dt.getData("text/plain");
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

/**
 * True while one of our sidebar sessions is being dragged over a drop
 * target. Requires a known session payload: dockview's own tab drags set
 * `text/plain` to `""`, so this never collides with its internal DnD.
 */
function isHiveFieldDrag(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  const types = Array.from(dt.types);
  if (types.includes(DND_MIME)) return true;
  return types.includes("text/plain") && readDragPayload(dt) !== undefined;
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
  /** What this session auto-runs ("opencode" agent or "raw" shell). */
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

let api: DockviewApi;
let panelCounter = 0;

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

function syncSize(sessionId: number, fitAddon: FitAddon, terminal: Terminal) {
  try {
    fitAddon.fit();
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
  };
  panelStatus.set(panelId, st);
  return st;
}

function renderTitle(panelId: string): void {
  const st = panelStatus.get(panelId);
  const panel = api?.getPanel(panelId);
  if (st && panel) panel.api.setTitle(st.indicator + st.baseTitle);
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
  if (!st) return;
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

/* ---------------------------------------------------------------------------
 * Auto-worktrees: every opencode session gets its own throwaway worktree so
 * parallel agents never share a checkout. Raw sessions and non-git launch
 * directories keep the launch-dir behavior.
 * ------------------------------------------------------------------------- */

/**
 * Resolve the directory an opencode session should spawn in. When no cwd is
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
  if (mode !== "opencode") return { cwd, created: false };
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

      const created = createTerminal();
      terminal = created.terminal;
      fitAddon = created.fitAddon;
      searchAddon = created.searchAddon;
      terminal.open(element);
      // terminal.element is only created by open(); re-apply settings so
      // element-dependent options (font ligatures) take effect.
      applyTerminalSettings(terminal, getSettings());

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
            if (mode === "opencode" && !oscTitleSeen && !st.userTitle) {
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

      // Resolve the session: opencode sessions auto-create a throwaway
      // worktree (unless restored with an existing cwd), then ask the backend
      // for a fresh PTY in the requested mode and directory, and wire the
      // terminal to it once we know its id.
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

          const pending = pendingOutputs.get(id);
          if (pending) {
            for (const chunk of pending) terminal?.write(chunk);
            pendingOutputs.delete(id);
          }

          // The panel is registered into its group only after this content
          // component is initialized, so backfill the reference next tick.
          setTimeout(() => {
            const panel = containerApi.getPanel(panelApi.id);
            if (panel && sessions.has(id)) entry.panel = panel;
          }, 0);

          // A fresh opencode session's tab takes the worktree's codename.
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
  // A fresh opencode session without a pinned cwd gets a codename (the tab
  // title and the auto-created worktree's branch are both derived from it).
  const name = mode === "opencode" && !cwd ? titleOverride ?? generateSessionName() : undefined;
  const base = mode === "opencode" ? (name ?? "opencode") : "shell";
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
 * WebKitGTK workaround: dockview's own drop targets sometimes lose the final
 * `drop` near the top/bottom edges of a pane (the preview overlay still shows
 * while hovering — only the release is dropped on the floor). This catches the
 * `drop` at the document level and, when dockview did not already open a
 * session, computes the target pane and split direction from the pointer
 * position and opens it here instead.
 */
function setupDropFallback() {
  const terminalEl = document.getElementById("terminal")!;
  // Same edge-zone ratio as the dropOverlayModel above (30%).
  const EDGE = 0.3;
  // dockview's outer-layout edge overlay activates within this many px.
  const OUTER_EDGE_PX = 10;

  const complete = (clientX: number, clientY: number, drag: SessionDrag, before: number) => {
    // dockview handles drops synchronously inside the same event dispatch, so
    // when a session already opened by the time this runs, it handled the drop.
    setTimeout(() => {
      if (api.panels.length > before) return;

      const rect = terminalEl.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;

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

      if (position) addPanelWithMode(drag.mode, position, drag.cwd);
    }, 0);
  };

  // Capture phase: this runs before dockview's own handlers and only acts if
  // they ended up not opening a session.
  document.addEventListener(
    "drop",
    (e) => {
      const drag = readDragPayload(e.dataTransfer);
      if (!drag) return;
      e.preventDefault(); // don't let the webview insert/paste the payload
      complete(e.clientX, e.clientY, drag, api.panels.length);
    },
    true
  );
}

function buildSidebar() {
  const sidebar = document.getElementById("sidebar")!;

  const title = document.createElement("div");
  title.className = "sidebar-title";
  title.textContent = "New session";
  sidebar.appendChild(title);

  const sources: Array<{ mode: Mode; label: string; icon: string }> = [
    { mode: "opencode", label: "opencode", icon: "✦" },
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
      // Advertise the session under our own MIME type *and* as plain text:
      // some WebKitGTK builds only surface the text/plain target across a
      // drag. JSON carries the mode plus an optional worktree cwd.
      const payload = serializeDrag({ mode: source.mode });
      dt.setData(DND_MIME, payload);
      dt.setData("text/plain", payload);
      dt.effectAllowed = "copy";

      // Custom ghost so the drag reads as a session, not a text blob.
      const ghost = buildDragGhost(source);
      document.body.appendChild(ghost);
      dt.setDragImage(ghost, 8, 8);
      requestAnimationFrame(() => ghost.remove());
    });

    sidebar.appendChild(item);
  }

  const settingsBtn = document.createElement("button");
  settingsBtn.className = "sidebar-settings";
  settingsBtn.type = "button";
  settingsBtn.title = "Settings (Ctrl+,)";
  settingsBtn.textContent = "⚙";
  settingsBtn.addEventListener("click", toggleSettings);
  sidebar.appendChild(settingsBtn);
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

/** Backend event wiring: PTY output/exit, plus the tab activity indicator. */
async function registerGlobalListeners() {
  await listen<{ sessionId: number; data: string }>("pty://output", (event) => {
    const { sessionId, data } = event.payload;
    const entry = sessions.get(sessionId);
    if (entry) {
      // Shell-integration markers drive the tab completion indicator; any
      // remaining text is written to the terminal.
      const { markers, text } = analyzeOutput(data);
      if (text) entry.terminal.write(text);
      const panel = entry.panel;
      if (panel && panelStatus.has(panel.id) && !isPanelActive(panel.id)) {
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
      entry.terminal.write(`\r\n[process exited with code ${code}]\r\n`);
    }
  });
}

async function init() {
  await loadSettings();

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
    const drag = readDragPayload((event.nativeEvent as DragEvent).dataTransfer);
    if (!drag) return;

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
  });

  // WebKitGTK can drop the final `drop` near pane top/bottom edges; make sure a
  // released session still opens even when dockview misses it.
  setupDropFallback();

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
    panelStatus.delete(panel.id);
    // If the searched terminal just went away, move the highlights onto
    // whatever is active now (or clear them if nothing is).
    if (isSearchOpen()) rerunSearch();
  });

  setupKeyboard();

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

  // If the user switches panels while searching, move the highlights to the
  // newly active terminal instead of leaving them stale on the old one, and
  // clear any activity/completion indicator on the newly focused tab.
  api.onDidActivePanelChange(() => {
    if (isSearchOpen()) rerunSearch();
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
function buildPaletteItems(): PaletteItem[] {
  const items: PaletteItem[] = [];

  for (const panel of api.panels) {
    const params = panel.api.getParameters() as Record<string, unknown>;
    const mode: Mode = params.mode === "raw" ? "raw" : "opencode";
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
      icon: mode === "opencode" ? "✦" : "$",
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
  return items;
}

function setupKeyboard() {
  const settingsOpen = () => document.querySelector(".settings-backdrop") !== null;
  // While the search bar or command palette is up, keystrokes belong to their
  // inputs, so the global shortcuts below must not fire.
  const uiOpen = () => settingsOpen() || isSearchOpen() || isPaletteOpen();

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
  });

  // Ctrl+H/J/K/L vim-style pane movement, plus font-size zoom (Ctrl+= / - / 0).
  // Registered in the CAPTURE phase so the keys are intercepted before xterm
  // sees them (otherwise Ctrl+H is backspace, Ctrl+J newline, Ctrl+K kill-line,
  // Ctrl+L clear-screen). If there is no adjacent pane in that direction the
  // key falls through to the terminal.
  window.addEventListener(
    "keydown",
    (e) => {
      if (uiOpen()) return;
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
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
        if (e.key === "0") {
          e.preventDefault();
          e.stopPropagation();
          zoomBy(0);
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
