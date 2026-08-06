/**
 * OS file drag & drop into terminals.
 *
 * Files/folders dragged from the system file manager onto a terminal are
 * converted to shell-quoted paths and written straight into that pane's PTY,
 * exactly as if they had been typed at the shell's cursor. The pane under the
 * pointer gets a highlight while the drag hovers over it; drops anywhere else
 * in the window fall back to the active session.
 *
 * Paths come from Tauri's built-in drag-drop interception (`tauri://drag-*`
 * events on the webview), which is the reliable way to get file paths on
 * WebKitGTK — the DOM `File` objects expose no path there.
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/**
 * Registry of terminal panel root elements → getters for their live session
 * id. The getter indirection lets a root be registered before its session
 * spawns; the WeakMap means disposed panels are reclaimed with their element.
 */
const rootToSessionId = new WeakMap<HTMLElement, () => number | undefined>();

/**
 * Register a terminal panel's root element so OS file drops over it can be
 * written to its PTY. Call once per panel, from its content component init.
 */
export function registerTerminalRoot(
  root: HTMLElement,
  getSessionId: () => number | undefined
): void {
  rootToSessionId.set(root, getSessionId);
}

/** Hover highlight applied to the terminal panel under a pending file drop. */
const TARGET_CLASS = "file-drop-target";

/** Hover tooltip label shown on the drop target. */
const HINT_TEXT = "Release to insert path";

/**
 * Quote a single path for the shell: plain safe paths pass through untouched;
 * everything else is wrapped in single quotes with embedded quotes escaped the
 * POSIX way (`'\''`). Relative paths that look like options are quoted too.
 */
function shellQuote(path: string): string {
  if (/^[A-Za-z0-9_\-./+@%,:=]+$/.test(path) && !path.startsWith("-")) {
    return path;
  }
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Convert a list of dropped paths into a single shell-typed string. */
function quotedPaths(paths: string[]): string {
  return paths.filter((p) => p.length > 0).map(shellQuote).join(" ");
}

/** Convert a physical (device-pixel) position to CSS pixels. */
function cssPoint(x: number, y: number): { x: number; y: number } {
  const dpr = window.devicePixelRatio || 1;
  return { x: x / dpr, y: y / dpr };
}

/** The registered terminal root element under a client point, if any. */
function terminalRootAt(clientX: number, clientY: number): HTMLElement | undefined {
  const el = document.elementFromPoint(clientX, clientY);
  return el?.closest<HTMLElement>(".terminal-panel") ?? undefined;
}

let hintEl: HTMLDivElement | null = null;

/** Position the "release to insert" hint over a target root (or hide it). */
function showHint(root: HTMLElement | undefined): void {
  if (!root) {
    hintEl?.remove();
    hintEl = null;
    return;
  }
  if (!hintEl) {
    hintEl = document.createElement("div");
    hintEl.className = "file-drop-hint";
    hintEl.textContent = HINT_TEXT;
    document.body.appendChild(hintEl);
  }
  const rect = root.getBoundingClientRect();
  hintEl.style.left = `${rect.left + rect.width / 2}px`;
  hintEl.style.top = `${rect.top + 16}px`;
}

/** Move the highlight (and hint) onto the root under the pointer, or clear. */
function highlightTarget(clientX: number, clientY: number): void {
  const root = terminalRootAt(clientX, clientY);
  document
    .querySelectorAll(`.${TARGET_CLASS}`)
    .forEach((el) => el.classList.remove(TARGET_CLASS));
  root?.classList.add(TARGET_CLASS);
  showHint(root);
}

/**
 * Start listening for OS file drags. `fallback` returns the session id to
 * write to when the drop lands outside any terminal pane (e.g. on the
 * sidebar) — normally the active session. Returns an unlisten function.
 */
export async function initFileDrop(
  fallback: () => number | undefined
): Promise<() => void> {
  return getCurrentWebview().onDragDropEvent((event) => {
    const { type } = event.payload;
    // Our own sidebar session drags are pure DOM drags and never reach here.

    if (type === "enter" || type === "over") {
      // `over` carries no `paths` in the API, but we only need the position
      // to move the highlight across panes as the drag travels.
      highlightTarget(event.payload.position.x, event.payload.position.y);
      return;
    }
    if (type === "leave") {
      highlightTarget(-1, -1); // clears the highlight and hint
      return;
    }

    // type === "drop"
    highlightTarget(-1, -1);
    const { paths, position } = event.payload;
    // Non-file drags (text/URLs from other apps) carry no paths; ignore them.
    if (paths.length === 0) return;
    const { x, y } = cssPoint(position.x, position.y);
    const root = terminalRootAt(x, y);
    const getSessionId = root ? rootToSessionId.get(root) : undefined;
    const sessionId = getSessionId?.() ?? fallback();
    if (sessionId === undefined) return;
    const data = quotedPaths(paths);
    if (!data) return;
    // Write raw, like typed input: the shell's line discipline places it
    // at the cursor. Paths are already quoted, so no shell metacharacters
    // survive unescaped.
    invoke("pty_write", { sessionId, data }).catch((err) =>
      console.error("failed to write dropped file paths", err)
    );
  });
}
