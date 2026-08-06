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

/** Custom MIME type used to drag sidebar entries into the dockview layout. */
const DND_MIME = "application/x-hivefield-mode";

/** Session modes the sidebar can start. */
const KNOWN_MODES: readonly Mode[] = ["opencode", "raw"];

/**
 * Read the requested session mode from a drag payload. Tolerates platforms
 * (WebKitGTK / Tauri on Linux) that only preserve the `text/plain` target
 * across a drag instead of our custom MIME type.
 */
function readDragMode(dt: DataTransfer | null | undefined): Mode | undefined {
  if (!dt) return undefined;
  const payload = dt.getData(DND_MIME) || dt.getData("text/plain");
  return (KNOWN_MODES as readonly string[]).includes(payload)
    ? (payload as Mode)
    : undefined;
}

/**
 * True while one of our sidebar sessions is being dragged over a drop
 * target. Requires a known mode value: dockview's own tab drags set
 * `text/plain` to `""`, so this never collides with its internal DnD.
 */
function isHiveFieldDrag(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  const types = Array.from(dt.types);
  if (types.includes(DND_MIME)) return true;
  return types.includes("text/plain") && readDragMode(dt) !== undefined;
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
}

/** sessionId -> terminal entry. */
const sessions = new Map<number, SessionEntry>();
/** panel id -> sessionId (panel ids are no longer the session ids). */
const panelToSession = new Map<string, number>();
/** Output buffered before the terminal for a session was registered. */
const pendingOutputs = new Map<number, string[]>();

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

      const created = createTerminal();
      terminal = created.terminal;
      fitAddon = created.fitAddon;
      searchAddon = created.searchAddon;
      terminal.open(element);

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

      // Ask the backend for a fresh session in the requested mode, then wire
      // the terminal to it once we know its id.
      invoke<number>("pty_spawn", { mode })
        .then((id) => {
          sessionId = id;
          const entry: SessionEntry = {
            terminal: terminal!,
            fitAddon: fitAddon!,
            searchAddon: searchAddon!,
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

function addPanelWithMode(mode: Mode, position?: AddPanelPositionOptions) {
  const panel = api.addPanel({
    id: nextPanelId(),
    component: "terminal",
    title: mode === "opencode" ? "opencode" : "shell",
    params: { mode },
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
      // Advertise the mode under our own MIME type *and* as plain text: some
      // WebKitGTK builds only surface the text/plain target across a drag.
      dt.setData(DND_MIME, source.mode);
      dt.setData("text/plain", source.mode);
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
    const mode = readDragMode((event.nativeEvent as DragEvent).dataTransfer);
    if (!mode) return;

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

    addPanelWithMode(mode, position);
  });

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
