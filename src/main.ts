import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  createDockview,
  themeCatppuccinMocha,
  positionToDirection,
  type AddPanelPositionOptions,
  type CreateComponentOptions,
  type DockviewApi,
  type GroupNavigationDirection,
  type GroupPanelPartInitParameters,
  type IContentRenderer,
  type IDockviewPanel,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import {
  getSettings,
  loadSettings,
  subscribe,
  type AppSettings,
} from "./settings";
import { toggleSettings } from "./settings-ui";
import { initDictation } from "./dictation";
import { initSearch, isSearchOpen, rerunSearch } from "./search";
import { bindWorkspaceSave, restoreWorkspace } from "./workspace";
import "./styles.css";

/** What a session auto-runs: the opencode agent, or a plain shell. */
type Mode = "opencode" | "raw";

/** A git worktree of the repo the app was launched from. */
interface WorktreeInfo {
  path: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  current: boolean;
}

/** Response of the `git_worktrees` IPC command. */
interface WorktreesInfo {
  root: string | null;
  worktrees: WorktreeInfo[];
}

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
  theme: {
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    cursor: "#f5e0dc",
    black: "#45475a",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#cba6f7",
    cyan: "#94e2d5",
    white: "#bac2de",
    brightBlack: "#585b70",
    brightRed: "#f38ba8",
    brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af",
    brightBlue: "#89b4fa",
    brightMagenta: "#cba6f7",
    brightCyan: "#94e2d5",
    brightWhite: "#a6adc8",
  },
  // Font options are applied per-terminal from settings via applyTerminalSettings.
  cursorBlink: true,
  scrollback: 10000,
  allowProposedApi: true,
};

interface SessionEntry {
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  panel?: IDockviewPanel;
  /** Directory the session's shell was started in, when it wasn't the launch dir. */
  cwd?: string;
}

/** sessionId -> terminal entry. */
const sessions = new Map<number, SessionEntry>();
/** panel id -> sessionId (panel ids are no longer the session ids). */
const panelToSession = new Map<string, number>();
/** Output buffered before the terminal for a session was registered. */
const pendingOutputs = new Map<number, string[]>();

/** Last worktree listing from the backend, used to render the sidebar section. */
let worktreeInfo: WorktreesInfo = { root: null, worktrees: [] };
/** worktree path -> info, for turning a cwd into a short tab-title label. */
const worktreeByPath = new Map<string, WorktreeInfo>();

let api: DockviewApi;
let panelCounter = 0;

function nextPanelId(): string {
  return `panel-${++panelCounter}`;
}

/** Push the current settings into a terminal's xterm options and Unicode version. */
function applyTerminalSettings(terminal: Terminal, settings: AppSettings): void {
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
 * Toggle font ligatures. xterm's DOM renderer merges consecutive cells into
 * spans, so the browser applies ligatures when the `calt` OpenType feature is
 * enabled — this is what programming fonts (Fira Code, Maple Mono, JetBrains
 * Mono, ...) use for sequences like `->`, `=>` and `!=`.
 */
function applyFontLigatures(terminal: Terminal, enabled: boolean): void {
  if (!terminal.element) return; // not attached to the DOM yet
  terminal.element.style.fontFeatureSettings = enabled ? '"calt" 1, "liga" 1, "clig" 1' : "normal";
}

function createTerminal(): { terminal: Terminal; fitAddon: FitAddon; searchAddon: SearchAddon } {
  const terminal = new Terminal(TERM_OPTIONS);
  terminal.loadAddon(new Unicode11Addon());
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  const searchAddon = new SearchAddon({ highlightLimit: 2000 });
  terminal.loadAddon(searchAddon);
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
      // running program's title win over the derived input-line one.
      terminal.onTitleChange((title) => {
        const sanitized = sanitizeTitle(title);
        if (!sanitized) return;
        oscTitleSeen = true;
        panelApi.setTitle(sanitized);
      });

      // Register input forwarding immediately so no early keystrokes are lost;
      // it no-ops until the session id is known.
      terminal.onData((data) => {
        if (sessionId !== undefined) {
          // Track the line being typed; when it is submitted (Enter) it
          // becomes this pane's title before being forwarded to the agent.
          inputState = trackInputLine(inputState, data, (line) => {
            if (mode === "opencode" && !oscTitleSeen) {
              const title = inputLineToTitle(line);
              if (title) panelApi.setTitle(title);
            }
          });
          invoke("pty_write", { sessionId, data }).catch(() => {});
        }
      });

      panelApi.onDidDimensionsChange(() => sync());
      panelApi.onDidActiveChange(({ isActive }) => {
        if (isActive) terminal?.focus();
      });

      // Ask the backend for a fresh session in the requested mode (and, for
      // worktree sessions, a specific start directory), then wire the
      // terminal to it once we know its id.
      invoke<number>("pty_spawn", { mode, ...(cwd ? { cwd } : {}) })
        .then((id) => {
          sessionId = id;
          const entry: SessionEntry = {
            terminal: terminal!,
            fitAddon: fitAddon!,
            searchAddon: searchAddon!,
            cwd,
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

/** Short tab-title label for a directory: branch name, else last path segment. */
function shortLabel(cwd: string): string {
  const wt = worktreeByPath.get(cwd);
  if (wt?.branch) return wt.branch;
  const last = cwd.split(/[\\/]/).filter(Boolean).pop();
  return last || cwd;
}

function addPanelWithMode(
  mode: Mode,
  position?: AddPanelPositionOptions,
  cwd?: string,
  titleOverride?: string
) {
  const base = mode === "opencode" ? "opencode" : "shell";
  const title = titleOverride ?? (cwd ? `${base}@${shortLabel(cwd)}` : base);
  const panel = api.addPanel({
    id: nextPanelId(),
    component: "terminal",
    title,
    params: { mode, cwd },
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

  // Worktree session: name it, get a throwaway worktree created in the
  // configured base dir, and open the agent there. Click-only (a name is
  // required first), so it is not draggable like the two mode entries above.
  const wtSession = document.createElement("div");
  wtSession.className = "drag-item worktree-session";
  wtSession.dataset.mode = "opencode";
  const wtIcon = document.createElement("span");
  wtIcon.className = "drag-icon";
  wtIcon.textContent = "⤴";
  wtSession.appendChild(wtIcon);
  wtSession.appendChild(document.createTextNode("worktree session"));
  wtSession.title =
    "Name a throwaway worktree in the base dir and open the agent there";
  wtSession.addEventListener("click", openWorktreeSessionModal);
  sidebar.appendChild(wtSession);

  // Worktrees section — populated asynchronously by refreshWorktrees() so a
  // non-git launch directory simply renders nothing here.
  const worktreeSection = document.createElement("div");
  worktreeSection.id = "worktrees-section";
  sidebar.appendChild(worktreeSection);

  const settingsBtn = document.createElement("button");
  settingsBtn.className = "sidebar-settings";
  settingsBtn.type = "button";
  settingsBtn.title = "Settings (Ctrl+,)";
  settingsBtn.textContent = "⚙";
  settingsBtn.addEventListener("click", toggleSettings);
  sidebar.appendChild(settingsBtn);
}

/* ---------------------------------------------------------------------------
 * Worktrees
 * ------------------------------------------------------------------------- */

/** Fetch the worktree listing from the backend and re-render the sidebar. */
async function refreshWorktrees(): Promise<void> {
  try {
    const info = await invoke<WorktreesInfo>("git_worktrees");
    worktreeInfo = info;
  } catch (err) {
    console.error("failed to list git worktrees", err);
    worktreeInfo = { root: null, worktrees: [] };
  }
  worktreeByPath.clear();
  for (const wt of worktreeInfo.worktrees) worktreeByPath.set(wt.path, wt);
  renderWorktreeSection();
}

/** Render the "Worktrees" sidebar section (no-op outside a git repository). */
function renderWorktreeSection(): void {
  const container = document.getElementById("worktrees-section");
  if (!container) return;
  container.replaceChildren();

  const wts = worktreeInfo.worktrees;
  if (wts.length === 0) return;

  const heading = document.createElement("div");
  heading.className = "worktree-heading";
  const headingTitle = document.createElement("span");
  headingTitle.className = "sidebar-title";
  headingTitle.textContent = "Worktrees";
  const addBtn = document.createElement("button");
  addBtn.className = "worktree-add";
  addBtn.type = "button";
  addBtn.textContent = "+";
  addBtn.title = "Create a worktree on a new branch";
  addBtn.addEventListener("click", openCreateWorktreeModal);
  heading.append(headingTitle, addBtn);
  container.appendChild(heading);

  for (const wt of wts) {
    const label =
      wt.branch ?? (wt.detached ? "(detached)" : wt.bare ? "(bare)" : "(no branch)");
    const item = document.createElement("div");
    item.className = "drag-item worktree-item" + (wt.current ? " current" : "");
    item.dataset.mode = "opencode";
    item.dataset.cwd = wt.path;
    item.draggable = true;
    item.title = [
      wt.current ? "Current worktree" : "Worktree",
      `${label} — ${wt.path}`,
      "Click: opencode · Shift+click: raw shell · Drag to split",
    ].join("\n");

    const icon = document.createElement("span");
    icon.className = "drag-icon";
    icon.textContent = "⤴";
    item.appendChild(icon);

    const labelEl = document.createElement("span");
    labelEl.className = "worktree-label";
    const branchEl = document.createElement("span");
    branchEl.className = "worktree-branch";
    branchEl.textContent = label;
    const pathEl = document.createElement("span");
    pathEl.className = "worktree-path";
    pathEl.textContent = wt.path;
    labelEl.append(branchEl, pathEl);
    item.appendChild(labelEl);

    item.addEventListener("dragstart", (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      const payload = serializeDrag({ mode: "opencode", cwd: wt.path });
      dt.setData(DND_MIME, payload);
      dt.setData("text/plain", payload);
      dt.effectAllowed = "copy";
      const ghost = buildDragGhost({ icon: "⤴", label });
      document.body.appendChild(ghost);
      dt.setDragImage(ghost, 8, 8);
      requestAnimationFrame(() => ghost.remove());
    });

    item.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".worktree-rm")) return;
      // Click opens an agent right in this worktree; Shift+click a raw shell.
      addPanelWithMode(e.shiftKey ? "raw" : "opencode", undefined, wt.path);
    });

    const rmBtn = document.createElement("button");
    rmBtn.className = "worktree-rm";
    rmBtn.type = "button";
    rmBtn.textContent = "✕";
    rmBtn.title = "Remove this worktree (fails while it has changes)";
    rmBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void removeWorktree(wt.path);
    });
    item.appendChild(rmBtn);

    container.appendChild(item);
  }
}

/** Small modal asking for a branch name, then creates the worktree. */
function openCreateWorktreeModal(): void {
  document.querySelector(".settings-backdrop")?.remove();

  const backdrop = document.createElement("div");
  backdrop.className = "settings-backdrop";

  const modal = document.createElement("div");
  modal.className = "settings-modal worktree-modal";

  const header = document.createElement("div");
  header.className = "settings-header";
  const title = document.createElement("h1");
  title.className = "settings-title";
  title.textContent = "New worktree";
  const closeBtn = document.createElement("button");
  closeBtn.className = "settings-close";
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => backdrop.remove());
  header.append(title, closeBtn);
  modal.appendChild(header);

  const body = document.createElement("div");
  body.className = "settings-body";
  const label = document.createElement("label");
  label.className = "settings-label";
  label.textContent = "Branch name";
  body.appendChild(label);
  const input = document.createElement("input");
  input.className = "settings-text";
  input.placeholder = "feature/xyz";
  input.autocomplete = "off";
  body.appendChild(input);
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  hint.textContent = `Creates a sibling directory next to ${worktreeInfo.root ?? "this repo"} named <repo>-<branch>.`;
  body.appendChild(hint);
  modal.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "settings-footer";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "settings-reset";
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => backdrop.remove());
  const createBtn = document.createElement("button");
  createBtn.className = "settings-done";
  createBtn.type = "button";
  createBtn.textContent = "Create";
  createBtn.addEventListener("click", async () => {
    const branch = input.value.trim();
    if (!branch) return;
    createBtn.disabled = true;
    try {
      const path = await invoke<string>("git_worktree_create", { branch });
      backdrop.remove();
      await refreshWorktrees();
      // Drop the user straight into the new checkout.
      addPanelWithMode("opencode", undefined, path);
    } catch (err) {
      console.error("failed to create worktree", err);
      showToast(`Could not create worktree: ${err}`);
      createBtn.disabled = false;
    }
  });
  footer.append(cancelBtn, createBtn);
  modal.appendChild(footer);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  input.focus();

  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") createBtn.click();
    if (e.key === "Escape") backdrop.remove();
  });
}

/** Prompt for a session name, auto-create the worktree, and open the agent. */
function openWorktreeSessionModal(): void {
  document.querySelector(".settings-backdrop")?.remove();

  const backdrop = document.createElement("div");
  backdrop.className = "settings-backdrop";

  const modal = document.createElement("div");
  modal.className = "settings-modal worktree-modal";

  const header = document.createElement("div");
  header.className = "settings-header";
  const title = document.createElement("h1");
  title.className = "settings-title";
  title.textContent = "Worktree session";
  const closeBtn = document.createElement("button");
  closeBtn.className = "settings-close";
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => backdrop.remove());
  header.append(title, closeBtn);
  modal.appendChild(header);

  const body = document.createElement("div");
  body.className = "settings-body";
  const label = document.createElement("label");
  label.className = "settings-label";
  label.textContent = "Session name";
  body.appendChild(label);
  const input = document.createElement("input");
  input.className = "settings-text";
  input.placeholder = "e.g. fix-login";
  input.autocomplete = "off";
  body.appendChild(input);
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  const baseDir = getSettings().worktreeBaseDir.trim() || "/tmp";
  hint.textContent = `Creates a worktree under ${baseDir} (change in Settings) and opens the agent there.`;
  body.appendChild(hint);
  modal.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "settings-footer";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "settings-reset";
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => backdrop.remove());
  const openBtn = document.createElement("button");
  openBtn.className = "settings-done";
  openBtn.type = "button";
  openBtn.textContent = "Open";
  openBtn.addEventListener("click", async () => {
    const name = input.value.trim();
    if (!name) return;
    openBtn.disabled = true;
    try {
      const created = await invoke<AutoWorktree>("git_worktree_auto_create", {
        name,
        baseDir: getSettings().worktreeBaseDir.trim() || "/tmp",
      });
      backdrop.remove();
      await refreshWorktrees();
      addPanelWithMode("opencode", undefined, created.path, name);
    } catch (err) {
      console.error("failed to create worktree session", err);
      showToast(`Could not create worktree session: ${err}`);
      openBtn.disabled = false;
    }
  });
  footer.append(cancelBtn, openBtn);
  modal.appendChild(footer);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  input.focus();

  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") openBtn.click();
    if (e.key === "Escape") backdrop.remove();
  });
}

/** Remove a worktree and close any sessions that were running inside it. */
async function removeWorktree(path: string): Promise<void> {
  try {
    await invoke("git_worktree_remove", { path });
  } catch (err) {
    console.error("failed to remove worktree", err);
    showToast(`Could not remove worktree: ${err}`);
    return;
  }
  // Sessions started inside the removed worktree can no longer run — close
  // their panels (which kills the shell). Fall back to pty_kill when the panel
  // reference isn't wired up yet.
  for (const [id, entry] of sessions) {
    if (entry.cwd === path) {
      if (entry.panel) entry.panel.api.close();
      else invoke("pty_kill", { sessionId: id }).catch(() => {});
    }
  }
  await refreshWorktrees();
}

/** Transient status toast for operation failures. */
function showToast(message: string): void {
  const toast = document.createElement("div");
  toast.className = "hivefield-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

async function registerGlobalListeners() {
  await listen<{ sessionId: number; data: string }>("pty://output", (event) => {
    const { sessionId, data } = event.payload;
    const entry = sessions.get(sessionId);
    if (entry) {
      entry.terminal.write(data);
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
  // use the chosen font family (sidebar, tabs, settings page).
  subscribe((settings) => {
    for (const [id, entry] of sessions) {
      applyTerminalSettings(entry.terminal, settings);
      syncSize(id, entry.fitAddon, entry.terminal);
    }
    document.documentElement.style.setProperty(
      "--hivefield-font",
      `"${settings.fontFamily}", monospace`
    );
  });

  await registerGlobalListeners();

  buildSidebar();
  void refreshWorktrees();

  api = createDockview(document.getElementById("terminal")!, {
    createComponent: createTerminalComponent,
    disableFloatingGroups: true,
    theme: themeCatppuccinMocha,
    dropOverlayModel: ({ location }) => {
      // Wider edge zones on the terminal content so dropping a session as a
      // split in a chosen direction is easy to hit (default is 20%).
      if (location !== "content") return undefined;
      return { activationSize: { value: 30, type: "percentage" } };
    },
  });

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
      entry.terminal.dispose();
    }
    sessions.delete(sessionId);
    panelToSession.delete(panel.id);
    pendingOutputs.delete(sessionId);
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

  // If the user switches panels while searching, move the highlights to the
  // newly active terminal instead of leaving them stale on the old one.
  api.onDidActivePanelChange(() => {
    if (isSearchOpen()) rerunSearch();
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

function setupKeyboard() {
  const settingsOpen = () => document.querySelector(".settings-backdrop") !== null;
  // While the search bar is up, keystrokes belong to its input, so the global
  // shortcuts below must not fire.
  const uiOpen = () => settingsOpen() || isSearchOpen();

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
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === ",") {
      e.preventDefault();
      toggleSettings();
    }
  });

  // Ctrl+H/J/K/L vim-style pane movement. Registered in the CAPTURE phase so
  // the keys are intercepted before xterm sees them (otherwise Ctrl+H is
  // backspace, Ctrl+J newline, Ctrl+K kill-line, Ctrl+L clear-screen). If
  // there is no adjacent pane in that direction the key falls through to the
  // terminal.
  window.addEventListener(
    "keydown",
    (e) => {
      if (uiOpen()) return;
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        const direction = MOVEMENT_KEYS[e.key.toLowerCase()];
        if (direction) {
          const group = api.activePanel?.group;
          if (group) {
            const adjacent = api.adjacentGroupInDirection(group, direction);
            if (adjacent) {
              e.preventDefault();
              e.stopPropagation();
              // Activate the group via its active panel; our component's
              // onDidActiveChange handler then focuses the terminal there.
              adjacent.activePanel?.api.setActive();
            }
          }
        }
      }
    },
    true
  );
}

init().catch((err) => console.error("failed to initialize terminal layout", err));
