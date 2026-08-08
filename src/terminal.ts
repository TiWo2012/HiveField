/**
 * Terminal UI helpers: theme application, font loading for fit correctness.
 *
 * The actual terminal rendering is handled by GhosttyCanvas (frontend) and
 * GhosttyState (Rust). This module only handles chrome theming and font
 * readiness to ensure the canvas' fit() measures the real cell size.
 */

import { invoke } from "@tauri-apps/api/core";
import { getTheme } from "./themes";
import { getSettings, type AppSettings } from "./settings";
import { getApi } from "./state";

/** Convert a #rrggbb hex color to an rgba() string with the given alpha. */
export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Fonts already confirmed loaded, keyed by `size family`. */
const loadedFonts = new Set<string>();

function fontKey(family: string, size: number): string {
  return `${size}px ${family}`;
}

/**
 * Load the configured terminal font so xterm measures the real cell size.
 *
 * The FitAddon computes cols/rows from the renderer's cell dimensions. If the
 * configured font is still loading when fit() runs, the browser measures a
 * fallback font's metrics and the PTY gets resized to a bogus size — the
 * shell then renders startup output at the wrong width/height and the later
 * correction reflows the scrollback into garbage. Gate the first resize on
 * the font actually being loaded.
 *
 * Bounded to ~1.5 s so a stalled font API never blocks the terminal.
 */
export async function ensureTerminalFont(): Promise<void> {
  const s = getSettings();
  const key = fontKey(s.fontFamily, s.fontSize);
  if (loadedFonts.has(key)) return;
  try {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts?.load) {
      const timeout = new Promise<void>((r) => setTimeout(r, 1500));
      const load = fonts.load(`${s.fontSize}px "${s.fontFamily}"`)
        .then(() => fonts.ready);
      await Promise.race([load, timeout]);
    }
  } catch {
    // Font API unavailable or the family failed to load — fit with whatever
    // the browser provides rather than blocking startup.
  }
  loadedFonts.add(key);
}

/** Whether the configured font has been confirmed loaded (fit gating). */
export function terminalFontReady(): boolean {
  const s = getSettings();
  return loadedFonts.has(fontKey(s.fontFamily, s.fontSize));
}

/**
 * Push the active theme into the app chrome: the `--hf-*` CSS variables the
 * sidebar/modals/search bar read, the terminal background (with optional
 * alpha), the transparency flag, and the dockview theme.
 */
export function applyUiTheme(settings: AppSettings): void {
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

  const api = getApi();
  if (api) api.updateOptions({ theme: theme.dockview });
}
