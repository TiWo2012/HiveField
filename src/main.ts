import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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
  type GroupPanelPartInitParameters,
  type IContentRenderer,
  type IDockviewPanel,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import "./styles.css";

/** What a session auto-runs: the opencode agent, or a plain shell. */
type Mode = "opencode" | "raw";

/** Custom MIME type used to drag sidebar entries into the dockview layout. */
const DND_MIME = "application/x-hivefield-mode";

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
  fontFamily: "monospace",
  fontSize: 14,
  cursorBlink: true,
  scrollback: 10000,
  allowProposedApi: false,
};

interface SessionEntry {
  terminal: Terminal;
  fitAddon: FitAddon;
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

function createTerminal(): { terminal: Terminal; fitAddon: FitAddon } {
  const terminal = new Terminal(TERM_OPTIONS);
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  return { terminal, fitAddon };
}

function syncSize(sessionId: number, fitAddon: FitAddon, terminal: Terminal) {
  try {
    fitAddon.fit();
    invoke("pty_resize", { sessionId, cols: terminal.cols, rows: terminal.rows }).catch(() => {});
  } catch {
    // ignore until the backend is ready
  }
}

function createTerminalComponent(): IContentRenderer {
  const element = document.createElement("div");
  element.classList.add("terminal-panel");

  // Populated when the async spawn resolves; sync() no-ops until then.
  let sessionId: number | undefined;
  let terminal: Terminal | null = null;
  let fitAddon: FitAddon | null = null;

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
      terminal.open(element);

      // Register input forwarding immediately so no early keystrokes are lost;
      // it no-ops until the session id is known.
      terminal.onData((data) => {
        if (sessionId !== undefined) {
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
          const entry: SessionEntry = { terminal: terminal!, fitAddon: fitAddon! };
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
      e.dataTransfer!.setData(DND_MIME, source.mode);
      e.dataTransfer!.effectAllowed = "copy";
    });

    sidebar.appendChild(item);
  }
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
  await registerGlobalListeners();

  buildSidebar();

  api = createDockview(document.getElementById("terminal")!, {
    createComponent: createTerminalComponent,
    disableFloatingGroups: true,
    theme: themeCatppuccinMocha,
  });

  // Accept our sidebar drags so dockview shows the drop-target overlay.
  api.onUnhandledDragOver((event) => {
    const dt = (event.nativeEvent as DragEvent).dataTransfer;
    if (dt?.types.includes(DND_MIME)) {
      event.accept();
    }
  });

  // Create a new session where the sidebar entry was dropped.
  api.onDidDrop((event) => {
    const dt = (event.nativeEvent as DragEvent).dataTransfer;
    const mode = dt?.getData(DND_MIME) as Mode | undefined;
    if (mode !== "opencode" && mode !== "raw") return;

    const direction = positionToDirection(event.position);
    let position: AddPanelPositionOptions | undefined;
    if (event.panel) {
      position = { direction, referencePanel: event.panel };
    } else if (event.group) {
      position = { direction, referenceGroup: event.group };
    } else if (direction !== "within") {
      position = { direction };
    }
    // else: no reference and a 'within' drop on empty space -> let dockview
    // decide (new group or active group)

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

  addPanelWithMode("opencode");
}

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.shiftKey && (e.key === "T" || e.key === "t")) {
    e.preventDefault();
    addPanelWithMode("opencode");
  }
  if (e.ctrlKey && e.shiftKey && (e.key === "W" || e.key === "w")) {
    e.preventDefault();
    api.activePanel?.api.close();
  }
});

init().catch((err) => console.error("failed to initialize terminal layout", err));
