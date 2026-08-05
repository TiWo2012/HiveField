import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const term = new Terminal({
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
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

term.open(document.getElementById("terminal")!);
fitAddon.fit();

function syncSize() {
  try {
    fitAddon.fit();
    invoke("pty_resize", { cols: term.cols, rows: term.rows }).catch(() => {});
  } catch {
    // ignore until the backend is ready
  }
}

window.addEventListener("resize", syncSize);
new ResizeObserver(syncSize).observe(document.getElementById("terminal")!);

term.onData((data) => {
  invoke("pty_write", { data }).catch(() => {});
});

async function init() {
  await listen("pty://output", (event) => {
    const { data } = event.payload as { data: string };
    term.write(data);
  });

  await listen("pty://exit", (event) => {
    const { code } = event.payload as { code: number };
    term.write(`\r\n[process exited with code ${code}]\r\n`);
  });
}

init().catch((err) => console.error("failed to set up Tauri event listeners", err));

setTimeout(syncSize, 150);
