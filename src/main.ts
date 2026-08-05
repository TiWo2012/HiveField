import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  createDockview,
  themeCatppuccinMocha,
  type CreateComponentOptions,
  type DockviewApi,
  type GroupPanelPartInitParameters,
  type IContentRenderer,
  type IDockviewPanel,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import "./styles.css";

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

const sessions = new Map<number, SessionEntry>();
const pendingOutputs = new Map<number, string[]>();

let api: DockviewApi;

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

function createTerminalComponent(options: CreateComponentOptions): IContentRenderer {
  const element = document.createElement("div");
  element.classList.add("terminal-panel");

  let sessionId = -1;
  let terminal: Terminal | null = null;
  let fitAddon: FitAddon | null = null;

  function sync() {
    if (sessionId < 0 || !terminal || !fitAddon) return;
    syncSize(sessionId, fitAddon, terminal);
  }

  return {
    element,
    init({ api: panelApi, containerApi, params }: GroupPanelPartInitParameters) {
      sessionId = params.sessionId as number;

      const created = createTerminal();
      terminal = created.terminal;
      fitAddon = created.fitAddon;
      terminal.open(element);

      const entry: SessionEntry = { terminal, fitAddon };
      sessions.set(sessionId, entry);

      // The panel is registered into its group only after this content
      // component is initialized, so backfill the reference on the next tick.
      setTimeout(() => {
        const panel = containerApi.getPanel(String(sessionId));
        if (panel && sessions.has(sessionId)) {
          entry.panel = panel;
        }
      }, 0);

      const pending = pendingOutputs.get(sessionId);
      if (pending) {
        for (const chunk of pending) terminal.write(chunk);
        pendingOutputs.delete(sessionId);
      }

      terminal.onData((data) => {
        invoke("pty_write", { sessionId, data }).catch(() => {});
      });

      panelApi.onDidDimensionsChange(() => sync());
      panelApi.onDidActiveChange(({ isActive }) => {
        if (isActive) terminal?.focus();
      });

      setTimeout(sync, 0);
      setTimeout(sync, 50);
      terminal.focus();
    },
    onShow() {
      sync();
    },
  };
}

async function addTab() {
  const sessionId = await invoke<number>("pty_spawn");
  const panel = api.addPanel({
    id: String(sessionId),
    component: "terminal",
    title: "shell",
    params: { sessionId },
  });
  panel.api.setActive();
}

async function init() {
  await registerGlobalListeners();

  api = createDockview(document.getElementById("terminal")!, {
    createComponent: createTerminalComponent,
    disableFloatingGroups: true,
    theme: themeCatppuccinMocha,
  });

  api.onDidRemovePanel((panel: IDockviewPanel) => {
    const sessionId = Number(panel.id);
    const entry = sessions.get(sessionId);
    if (entry) {
      invoke("pty_kill", { sessionId }).catch(() => {});
      entry.terminal.dispose();
      sessions.delete(sessionId);
      pendingOutputs.delete(sessionId);
    }
  });

  await addTab();
}

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.shiftKey && (e.key === "T" || e.key === "t")) {
    e.preventDefault();
    addTab().catch((err) => console.error("failed to spawn new terminal", err));
  }
  if (e.ctrlKey && e.shiftKey && (e.key === "W" || e.key === "w")) {
    e.preventDefault();
    api.activePanel?.api.close();
  }
});

init().catch((err) => console.error("failed to initialize terminal layout", err));
