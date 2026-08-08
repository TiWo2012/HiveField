/**
 * Canvas-based terminal renderer backed by Ghostty VT emulation (Rust side).
 *
 * Receives `ghostty://cells` events from the backend — each payload contains
 * the full screen grid of cells with colors and attributes — and renders
 * them to an HTML canvas. Handles keyboard input forwarding to the PTY and
 * resize requests.
 *
 * Replaces xterm.js, FitAddon, SearchAddon, Unicode11Addon and all the
 * scroll-follow / cursor-focus machinery in terminal.ts.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getTheme } from "./themes";
import { getSettings, type AppSettings } from "./settings";

/** A single cell in the ghostty://cells payload. */
export interface GCell {
  row: number;
  col: number;
  ch: string;
  fg: number;
  bg: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

export interface GCellsPayload {
  sessionId: number;
  cols: number;
  rows: number;
  cursorRow: number;
  cursorCol: number;
  cells: GCell[];
}

/**
 * Map a ghostty VT color word to an actual CSS color string using the
 * active theme's terminal palette.
 *
 * Color encoding:
 *   bit24=0, bit25=0 → default (use theme foreground/background)
 *   bit24=1, bit25=0 → RGB (bits 0-23) or indexed (bits 0-7)
 *   bit24=1, bit25=1 → ANSI 16-color (bits 0-3)
 */
function resolveColor(v: number, theme: ReturnType<typeof getTheme>["terminal"], isBg: boolean): string {
  if (v === 0) {
    // Default
    return isBg ? (theme.background ?? "#000") : (theme.foreground ?? "#fff");
  }
  if (v & 0x200_0000) {
    // ANSI 16-color (bit25 set)
    const idx = v & 0xF;
    const colors = [
      theme.black, theme.red, theme.green, theme.yellow,
      theme.blue, theme.magenta, theme.cyan, theme.white,
      theme.brightBlack, theme.brightRed, theme.brightGreen,
      theme.brightYellow, theme.brightBlue, theme.brightMagenta,
      theme.brightCyan, theme.brightWhite,
    ] as (string | undefined)[];
    return colors[idx] ?? (isBg ? "#000" : "#fff");
  }
  if (v & 0x100_0000) {
    // RGB or indexed
    const lo = v & 0xFF;
    if ((v >> 16) & 0xFF) {
      // RGB: r=(v>>16)&0xFF, g=(v>>8)&0xFF, b=v&0xFF
      const r = (v >> 16) & 0xFF;
      const g = (v >> 8) & 0xFF;
      const b = v & 0xFF;
      return `rgb(${r},${g},${b})`;
    }
    // Indexed (256-color): lo is the index — approximate with greyscale or cube
    if (lo < 16) {
      // System colors (same as ANSI above)
      const colors = [
        theme.black, theme.red, theme.green, theme.yellow,
        theme.blue, theme.magenta, theme.cyan, theme.white,
        theme.brightBlack, theme.brightRed, theme.brightGreen,
        theme.brightYellow, theme.brightBlue, theme.brightMagenta,
        theme.brightCyan, theme.brightWhite,
      ] as (string | undefined)[];
      return colors[lo] ?? (isBg ? "#000" : "#fff");
    }
    if (lo < 232) {
      // 216-color cube
      const idx = lo - 16;
      const r = Math.floor(idx / 36) * 51;
      const g = Math.floor((idx % 36) / 6) * 51;
      const b = (idx % 6) * 51;
      return `rgb(${r},${g},${b})`;
    }
    // Greyscale ramp
    const gs = (lo - 232) * 10 + 8;
    return `rgb(${gs},${gs},${gs})`;
  }
  return isBg ? (theme.background ?? "#000") : (theme.foreground ?? "#fff");
}

/** Convert a u32 color pair (fg/bg) to CSS colors using the active theme. */
function cellColors(
  fg: number, bg: number,
  theme: ReturnType<typeof getTheme>["terminal"],
  attrs: { bold: boolean; inverse: boolean }
): { fgStyle: string; bgStyle: string } {
  let f = fg;
  let b = bg;
  if (attrs.inverse) [f, b] = [b, f];
  let fgColor = resolveColor(f, theme, false);
  let bgColor = resolveColor(b, theme, true);
  return { fgStyle: fgColor, bgStyle: bgColor };
}

export class GhosttyCanvas {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly element: HTMLDivElement;
  private cols = 80;
  private rows = 24;
  private cursorRow = 0;
  private cursorCol = 0;
  private cellW = 8.4;
  private cellH = 17;
  private cursorBlink = true;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  private cursorVisible = true;

  /** sessionId → this canvas (set externally by sessions.ts). */
  sessionId?: number;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "ghostty-canvas-container";
    this.element.style.cssText = "width:100%;height:100%;overflow:hidden;position:relative;";
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "position:absolute;top:0;left:0;";
    this.element.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.setupBlink();
    this.applyFont();
  }

  /** Apply font settings from the app settings. */
  applyFont(s?: AppSettings) {
    const settings = s ?? getSettings();
    const font = `"${settings.fontFamily}", monospace`;
    this.ctx.font = `${settings.fontWeight} ${settings.fontSize}px ${font}`;
    // Measure cell
    const m = this.ctx.measureText("W");
    this.cellW = m.width;
    this.cellH = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
    if (this.cellH < settings.fontSize) this.cellH = settings.fontSize * 1.2;
    this.cursorBlink = settings.cursorBlink;
    this.setupBlink();
  }

  private setupBlink() {
    if (this.blinkTimer) { clearInterval(this.blinkTimer); this.blinkTimer = null; }
    if (this.cursorBlink) {
      this.blinkTimer = setInterval(() => {
        this.cursorVisible = !this.cursorVisible;
        this.drawCursor();
      }, 530);
    } else {
      this.cursorVisible = true;
    }
  }

  /** Apply theme colors to cursor and background. */
  applyTheme() {
    this.redraw();
  }

  /** Feed a full screen of cells from the backend. */
  update(payload: GCellsPayload) {
    this.cols = payload.cols;
    this.rows = payload.rows;
    this.cursorRow = payload.cursorRow;
    this.cursorCol = payload.cursorCol;
    this.cursorVisible = true; // reset blink phase on new data

    const w = this.cols * this.cellW;
    const h = this.rows * this.cellH;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.ceil(w * dpr);
    this.canvas.height = Math.ceil(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const theme = getTheme(getSettings().theme).terminal;

    // Clear background
    this.ctx.fillStyle = theme.background ?? "#000";
    this.ctx.fillRect(0, 0, w, h);

    // Draw cells
    for (const c of payload.cells) {
      const x = c.col * this.cellW;
      const y = c.row * this.cellH;

      const { fgStyle, bgStyle } = cellColors(c.fg, c.bg, theme, c);

      // Background
      const bgDefault = c.bg === 0;
      if (!bgDefault || c.inverse) {
        this.ctx.fillStyle = bgStyle;
        this.ctx.fillRect(x, y, this.cellW, this.cellH);
      }

      // Text
      if (c.ch !== " " || bgDefault === false) {
        this.ctx.fillStyle = fgStyle;
        if (c.bold) this.ctx.font = this.ctx.font.replace(/^[\d.]+px/, (m) => `bold ${m}`);
        if (c.italic) this.ctx.font = this.ctx.font.replace(/^bold /, "bold italic ").replace(/^\d/, (m) => `italic ${m}`);
        this.ctx.fillText(c.ch, x, y + this.cellH * 0.8);

        // Underline
        if (c.underline) {
          this.ctx.fillStyle = fgStyle;
          this.ctx.fillRect(x, y + this.cellH * 0.85, this.cellW, 1);
        }

        // Reset font
        this.applyFont();
      }
    }

    this.drawCursor();
  }

  private drawCursor() {
    if (this.cursorRow >= this.rows || this.cursorCol >= this.cols) return;
    const x = this.cursorCol * this.cellW;
    const y = this.cursorRow * this.cellH;
    if (!this.cursorVisible && this.cursorBlink) return;

    this.ctx.strokeStyle = getTheme(getSettings().theme).terminal.cursor ?? "#fff";
    this.ctx.lineWidth = 1.5;
    this.ctx.strokeRect(x + 0.5, y + 0.5, this.cellW - 1, this.cellH - 1);
  }

  /** Redraw everything from our cached payload. Call on theme change. */
  redraw() {
    // Redraw needs the last payload — stored externally by the session.
    // The session will call update() again after receiving a new
    // ghostty://cells event.
  }

  /** Return the current terminal dimensions in cells. */
  size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  /** Send input to the PTY. */
  write(data: string) {
    if (this.sessionId === undefined) return;
    invoke("pty_write", { sessionId: this.sessionId, data }).catch(() => {});
  }

  /** Request a PTY resize. */
  resizePty(sessionId: number) {
    invoke("pty_resize", {
      sessionId,
      cols: this.cols,
      rows: this.rows,
    }).catch(() => {});
  }

  focus() {
    this.canvas.focus();
    // Listen for keyboard events on the canvas.
    this.canvas.addEventListener("keydown", this._onKeyDown);
  }

  blur() {
    this.canvas.removeEventListener("keydown", this._onKeyDown);
  }

  dispose() {
    if (this.blinkTimer) clearInterval(this.blinkTimer);
    this.blur();
    this.element.remove();
  }

  private _onKeyDown = (e: KeyboardEvent) => {
    // Simple key-to-char mapping for common keys.
    // Full VT input handling would need a proper keyboard handler
    // (the ghostty VT backend would process input and return responses).
    if (e.ctrlKey && e.key === "c") {
      this.write("\x03");
      e.preventDefault();
      return;
    }
    if (e.key === "Enter") { this.write("\r"); e.preventDefault(); return; }
    if (e.key === "Backspace") { this.write("\x7f"); e.preventDefault(); return; }
    if (e.key === "Tab") { this.write("\t"); e.preventDefault(); return; }
    if (e.key === "Escape") { this.write("\x1b"); e.preventDefault(); return; }
    if (e.key === "ArrowUp") { this.write("\x1b[A"); e.preventDefault(); return; }
    if (e.key === "ArrowDown") { this.write("\x1b[B"); e.preventDefault(); return; }
    if (e.key === "ArrowRight") { this.write("\x1b[C"); e.preventDefault(); return; }
    if (e.key === "ArrowLeft") { this.write("\x1b[D"); e.preventDefault(); return; }
    if (e.key === "Home") { this.write("\x1b[H"); e.preventDefault(); return; }
    if (e.key === "End") { this.write("\x1b[F"); e.preventDefault(); return; }
    if (e.key === "Delete") { this.write("\x1b[3~"); e.preventDefault(); return; }
    if (e.key === "PageUp") { this.write("\x1b[5~"); e.preventDefault(); return; }
    if (e.key === "PageDown") { this.write("\x1b[6~"); e.preventDefault(); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      this.write(e.key);
      e.preventDefault();
    }
  };

  /** Resize the canvas to fit the container. Must be called on layout changes. */
  fit() {
    const rect = this.element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    this.cols = Math.max(2, Math.floor(rect.width / this.cellW));
    this.rows = Math.max(1, Math.floor(rect.height / this.cellH));
    if (this.sessionId !== undefined) this.resizePty(this.sessionId);
  }

  /** Check if viewport is at the bottom (scrollback tracking). */
  isAtBottom(): boolean {
    // Canvas renderer doesn't have scrollback — always at bottom.
    return true;
  }
}

/** Global listener for ghostty://cells events, dispatches to the right canvas. */
const canvases = new Map<number, GhosttyCanvas>();

export function registerGhosttyCanvas(sessionId: number, canvas: GhosttyCanvas) {
  canvas.sessionId = sessionId;
  canvases.set(sessionId, canvas);
}

export function unregisterGhosttyCanvas(sessionId: number) {
  canvases.delete(sessionId);
}

let ghosttyListenerRegistered = false;

export async function initGhosttyListener() {
  if (ghosttyListenerRegistered) return;
  ghosttyListenerRegistered = true;
  await listen<GCellsPayload>("ghostty://cells", (event) => {
    const { sessionId } = event.payload;
    const canvas = canvases.get(sessionId);
    if (canvas) canvas.update(event.payload);
  });
}
