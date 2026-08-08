/**
 * Per-terminal concerns: creating an xterm instance, pushing the active
 * settings/theme into it, and the scroll-follow / cursor-focus bookkeeping
 * that keeps the viewport and the cursor honest across resize and
 * park/restore races.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { invoke } from "@tauri-apps/api/core";
import { getTheme } from "./themes";
import { getSettings, type AppSettings } from "./settings";
import {
  panelToSession,
  sessions,
  getApi,
} from "./state";
import { handleBell } from "./bell";

/** Number of scrollback lines each terminal keeps (xterm option). */
const SCROLLBACK_LINES = 10_000;

/** Max matches the search addon highlights at once (SearchAddon option). */
const SEARCH_HIGHLIGHT_LIMIT = 2000;

const TERM_OPTIONS: ConstructorParameters<typeof Terminal>[0] = {
  // Colors come from the active theme via applyTerminalSettings().
  cursorBlink: true,
  // Inactive panes get an outlined cursor; syncTerminalCursorFocus() keeps
  // xterm's own focus bookkeeping aligned with the active panel.
  cursorInactiveStyle: "outline",
  scrollback: SCROLLBACK_LINES,
  allowProposedApi: true,
};

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
 * the font actually being loaded (see `syncSize`).
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
      const winner = await Promise.race([
        load.then(() => "loaded" as const),
        timeout.then(() => "timeout" as const),
      ]);
      if (winner === "timeout") return;
    }
  } catch {
    // Font API unavailable or the family failed to load — fit with whatever
    // the browser provides rather than blocking startup.
    return;
  }
  loadedFonts.add(key);
}

/** Whether the configured font has been confirmed loaded (fit gating). */
export function terminalFontReady(): boolean {
  const s = getSettings();
  return loadedFonts.has(fontKey(s.fontFamily, s.fontSize));
}

/** Push the current settings into a terminal's xterm options and Unicode version. */
export function applyTerminalSettings(terminal: Terminal, settings: AppSettings): void {
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

/**
 * Toggle font ligatures. xterm's DOM renderer merges consecutive cells into
 * spans, so the browser applies ligatures when the `calt` OpenType feature is
 * enabled — this is what programming fonts (Fira Code, Maple Mono, JetBrains
 * Mono, ...) use for sequences like `->`, `=>` and `!=`.
 */
export function applyFontLigatures(terminal: Terminal, enabled: boolean): void {
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

export function createTerminal(): { terminal: Terminal; fitAddon: FitAddon; searchAddon: SearchAddon } {
  const terminal = new Terminal(TERM_OPTIONS);
  terminal.loadAddon(new Unicode11Addon());
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  const searchAddon = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT });
  terminal.loadAddon(searchAddon);
  setupLinks(terminal);
  // BEL (0x07): play a bell tone and notify when the session isn't visible.
  terminal.onBell(() => handleBell(terminal));
  applyTerminalSettings(terminal, getSettings());
  return { terminal, fitAddon, searchAddon };
}

/**
 * True when the terminal's viewport is fully scrolled down (following the
 * cursor). `viewportY` is the buffer line at the top of the viewport and
 * `baseY` the first line of the bottom page, so they coincide exactly when
 * there is no scrollback left below the viewport.
 */
export function isAtBottom(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active;
  return buffer.viewportY >= buffer.baseY;
}

/**
 * Per-terminal follow intent. Defaults to following output; the user leaves
 * follow mode by scrolling up (wheel/touch/PageUp) and re-enters it by
 * scrolling back down to the bottom or typing.
 *
 * This is the app's own copy of "is the user reading scrollback", because
 * xterm's internal equivalent (`bufferService.isUserScrolling`) gets stuck:
 * scrolling up once and then having the terminal resized (which reflows the
 * scrollback) can leave the flag set while the viewport is back at the
 * bottom, so from then on new output grows the buffer but not the viewport
 * offset — the display silently drifts up and freezes at a fixed point in
 * scrollback while the cursor advances below the fold. The app's flag is
 * driven by real user input, so a stuck xterm flag self-heals on the next
 * write instead of freezing the view forever.
 */
export const followState = new WeakMap<Terminal, boolean>();

export function isFollowing(terminal: Terminal): boolean {
  return followState.get(terminal) ?? true;
}

export function setFollowing(terminal: Terminal, following: boolean): void {
  followState.set(terminal, following);
}

/**
 * Write data to a terminal, keeping the viewport pinned to the bottom.
 *
 * Pins when the user is following output OR the viewport is already at the
 * bottom. The first condition recovers from xterm's stuck scroll flag (see
 * `followState`): even if the viewport has already drifted into scrollback,
 * an output chunk re-asserts the bottom position, which clears the stuck flag
 * and lets output follow again. The second keeps the old behavior of snapping
 * back when the viewport visually sits at the bottom without ever yanking a
 * user who is genuinely reading scrollback.
 *
 * xterm parses writes asynchronously (its internal write buffer drains on a
 * later tick), so the checks re-run inside the callback instead of capturing
 * before the write: a resize (fit) can reflow the scrollback between write
 * and callback, which would make a pre-write `isAtBottom` stale.
 */
export function writeToTerminal(terminal: Terminal, data: string): void {
  terminal.write(data, () => {
    if (isFollowing(terminal) || isAtBottom(terminal)) terminal.scrollToBottom();
  });
}

export function syncSize(
  sessionId: number,
  fitAddon: FitAddon,
  terminal: Terminal
): boolean {
  try {
    // Never fit a detached or zero-size xterm. FitAddon otherwise clamps the
    // terminal to its minimum 2x1 grid, and xterm can reflow already-buffered
    // startup output against that bogus grid. The later resize then leaves
    // stale/garbled cells in the scrollback (especially in the DOM renderer).
    const element = terminal.element;
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    // Don't fit/resize until the configured font is loaded: fit() measures
    // the cell with whatever font is currently active, and a fallback font's
    // metrics would compute a bogus cols/rows, resize the PTY wrong, and
    // garble the shell's startup output in the scrollback. Callers retry
    // once the font is ready (see ensureTerminalFont / fonts.ready refit).
    if (!terminalFontReady()) return false;

    // Resizing reflows the scrollback; like writes, it can leave the viewport
    // (and xterm's scroll-tracking flag) off the bottom. Snap back when the
    // user was following output or the viewport is at the bottom; never yank
    // a user who scrolled up to read.
    const follow = isAtBottom(terminal) || isFollowing(terminal);
    fitAddon.fit();
    if (terminal.cols <= 2 || terminal.rows <= 1) return false;
    if (follow) terminal.scrollToBottom();
    invoke("pty_resize", { sessionId, cols: terminal.cols, rows: terminal.rows }).catch(() => {});
    return true;
  } catch {
    // ignore until the backend is ready
    return false;
  }
}

/**
 * The terminal that was last focused by syncTerminalCursorFocus(). Tracked so
 * we only blur the previously-active terminal instead of touching every panel
 * on each active-panel change.
 */
let previousActiveTerminal: Terminal | undefined;

/**
 * Reconcile xterm's per-terminal cursor state with the app's active panel so
 * the cursor renders filled only in the focused pane and outlined everywhere
 * else.
 *
 * xterm picks block vs. outline from the focus state of its hidden textarea,
 * and WebKitGTK never fires a blur when a focused terminal is detached while
 * its workspace is parked — so a restored terminal can stay "focused" forever
 * and keep painting a filled cursor in an inactive pane.
 *
 * Each terminal is initialized to the outlined (blurred) state at creation
 * time (see terminal.open in sessions.ts), so this function only needs to
 * blur the previously-active terminal and focus the new one — O(1) regardless
 * of panel count.
 */
export function syncTerminalCursorFocus(): void {
  const api = getApi();
  const activeId = api?.activePanel?.id;
  let activeTerm: Terminal | undefined;

  if (activeId) {
    const sessionId = panelToSession.get(activeId);
    if (sessionId !== undefined) {
      activeTerm = sessions.get(sessionId)?.terminal;
    }
  }

  // No change — nothing to do.
  if (previousActiveTerminal === activeTerm) return;

  // Blur the previously active terminal so its cursor goes to outline.
  if (previousActiveTerminal) {
    previousActiveTerminal.blur();
  }

  // Focus the new active terminal so its cursor renders filled.
  if (activeTerm) {
    activeTerm.focus();
  }

  previousActiveTerminal = activeTerm;
}
