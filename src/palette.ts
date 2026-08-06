import { fuzzyMatch, type FuzzyResult } from "./fuzzy";
import { closeSearch, isSearchOpen } from "./search";
import { closeContextMenu } from "./context-menu";
import { matchesKeybind } from "./keybinds";

/**
 * Command palette: a fuzzy finder over open panes and app actions.
 *
 * Opened with Ctrl+Shift+P, the palette shows every open pane (tab) plus a
 * list of commands. Typing filters the entries with fuzzy subsequence matching
 * (see fuzzy.ts); `↑`/`↓` or Ctrl+P / Ctrl+N move the selection, `Enter` jumps
 * to the pane or runs the command, and `Esc` closes the overlay.
 *
 * The palette is deliberately decoupled from the app: main.ts supplies the
 * items (panes built from the dockview API, commands wiring the app actions)
 * through a `PaletteContext`, so this module has no knowledge of terminals,
 * sessions, or dockview.
 */

export interface PaletteItem {
  /** Stable unique id (used for list rendering / keys). */
  id: string;
  /** Primary label the fuzzy query is matched against. */
  label: string;
  /** Optional right-aligned detail (group, cwd, shortcut…). */
  detail?: string;
  /** Leading icon glyph shown next to the label. */
  icon?: string;
  /** Group header this item is listed under (e.g. "Panes", "Actions"). */
  group: string;
  /** Called when the item is activated. */
  run: () => void;
}

export interface PaletteContext {
  /** Fetch the items to show every time the palette opens. */
  getItems: () => PaletteItem[];
  /** Called after the palette closes (to restore focus to the terminal). */
  onClose?: () => void;
  /** Resolve the current palette-toggle keybinding (Settings → Keybinds). */
  toggleKeybind?: () => string;
}

/** Keyboard shortcut that toggles the palette (configurable, default Ctrl+Shift+P). */
const TOGGLE_KEY = (e: KeyboardEvent): boolean =>
  matchesKeybind(context?.toggleKeybind?.() ?? "Ctrl+Shift+P", e);

let context: PaletteContext | null = null;

let backdrop: HTMLElement;
let input: HTMLInputElement;
let list: HTMLElement;

let items: PaletteItem[] = [];
/** The items currently rendered, in list order (aligned with the DOM rows). */
let rendered: PaletteItem[] = [];
let activeIndex = 0;
let open = false;

/**
 * Transient item source for a scoped sub-picker (e.g. the "Insert prompt…"
 * snippet list). When set, the next `openPalette()` uses it instead of the
 * app-level `context.getItems()` and shows a custom placeholder. Cleared when
 * the palette closes so a later Ctrl+Shift+P returns to the full list.
 */
let transientItems: (() => PaletteItem[]) | null = null;
let transientPlaceholder: string | null = null;

const DEFAULT_PLACEHOLDER = "Search panes and commands…";

/** Escape the given text for use as innerHTML content. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Wrap the characters of `label` that matched the query in `<mark>`, so the
 * fuzzy hits are highlighted in the list.
 */
function highlightLabel(label: string, indices: number[]): string {
  const set = new Set(indices);
  let html = "";
  for (let i = 0; i < label.length; i++) {
    const ch = label[i];
    if (set.has(i)) html += `<mark>${escapeHtml(ch)}</mark>`;
    else html += escapeHtml(ch);
  }
  return html;
}

function setActive(index: number): void {
  const rows = list.querySelectorAll<HTMLElement>(".palette-item");
  activeIndex = Math.max(0, Math.min(index, rows.length - 1));
  rows.forEach((row, i) => row.classList.toggle("active", i === activeIndex));
  list.querySelector<HTMLElement>(".palette-item.active")?.scrollIntoView({ block: "nearest" });
}

/** Filter + rank the current items against the query and re-render the list. */
function render(): void {
  const query = input.value;
  const scored: Array<{ item: PaletteItem; match: FuzzyResult }> = [];
  for (const item of items) {
    const match = fuzzyMatch(query, item.label);
    if (match !== null) scored.push({ item, match });
  }

  // Group by header in first-seen order; rank matches within each group.
  const groups = new Map<string, Array<{ item: PaletteItem; match: FuzzyResult }>>();
  for (const r of scored) {
    const bucket = groups.get(r.item.group) ?? [];
    bucket.push(r);
    groups.set(r.item.group, bucket);
  }

  list.textContent = "";
  rendered = [];
  for (const [groupName, entries] of groups) {
    entries.sort((a, b) => b.match.score - a.match.score);
    const header = document.createElement("div");
    header.className = "palette-group";
    header.textContent = groupName;
    list.appendChild(header);
    for (const { item, match } of entries) {
      const row = document.createElement("div");
      row.className = "palette-item";
      row.setAttribute("role", "option");
      if (item.icon) {
        const icon = document.createElement("span");
        icon.className = "palette-item-icon";
        icon.textContent = item.icon;
        row.appendChild(icon);
      }
      const label = document.createElement("span");
      label.className = "palette-item-label";
      label.innerHTML = highlightLabel(item.label, match.indices);
      row.appendChild(label);
      if (item.detail) {
        const detail = document.createElement("span");
        detail.className = "palette-item-detail";
        detail.textContent = item.detail;
        row.appendChild(detail);
      }
      // Capture this row's index now: `rendered.length` only reflects the
      // final total once the render loop finishes, not the row's position.
      const index = rendered.length;
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        runItem(index);
      });
      row.addEventListener("mouseenter", () => setActive(index));
      list.appendChild(row);
      rendered.push(item);
    }
  }

  if (rendered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "palette-empty";
    empty.textContent = "No matches";
    list.appendChild(empty);
    activeIndex = -1;
    return;
  }
  if (activeIndex >= rendered.length) activeIndex = rendered.length - 1;
  setActive(activeIndex);
}

function runItem(index: number): void {
  const item = rendered[index];
  if (!item) return;
  closePalette();
  item.run();
}

function onKeydown(e: KeyboardEvent): void {
  // The window-level toggle may close the palette in the capture phase before
  // this input handler runs for the same key (e.g. Ctrl+Shift+P to close).
  if (!open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closePalette();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    if (activeIndex >= 0) runItem(activeIndex);
    return;
  }
  const down =
    e.key === "ArrowDown" ||
    e.key === "Tab" ||
    (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === "n" || e.key === "N")) ||
    (e.ctrlKey && (e.key === "j" || e.key === "J"));
  const up =
    e.key === "ArrowUp" ||
    (e.ctrlKey && (e.key === "p" || e.key === "P")) ||
    (e.ctrlKey && (e.key === "k" || e.key === "K"));
  if (down || up) {
    e.preventDefault();
    e.stopPropagation();
    if (rendered.length === 0) return;
    const delta = down ? 1 : -1;
    setActive((activeIndex + delta + rendered.length) % rendered.length);
    return;
  }
  if (e.key === "Home") {
    e.preventDefault();
    if (rendered.length > 0) setActive(0);
  } else if (e.key === "End") {
    e.preventDefault();
    if (rendered.length > 0) setActive(rendered.length - 1);
  }
}

export function initPalette(ctx: PaletteContext): void {
  context = ctx;

  backdrop = document.createElement("div");
  backdrop.className = "palette-backdrop";
  backdrop.hidden = true;

  const palette = document.createElement("div");
  palette.className = "palette";

  const inputRow = document.createElement("div");
  inputRow.className = "palette-input-row";

  const icon = document.createElement("span");
  icon.className = "palette-icon";
  icon.textContent = "⌕";

  input = document.createElement("input");
  input.className = "palette-input";
  input.placeholder = DEFAULT_PLACEHOLDER;
  input.spellcheck = false;
  input.autocomplete = "off";
  input.autocapitalize = "off";

  const hint = document.createElement("span");
  hint.className = "palette-hint";
  hint.textContent = "↑↓ navigate · ↵ run · esc close";

  inputRow.append(icon, input, hint);
  palette.appendChild(inputRow);

  list = document.createElement("div");
  list.className = "palette-list";
  palette.appendChild(list);

  backdrop.appendChild(palette);
  document.body.appendChild(backdrop);

  // Live re-filter as the query is typed.
  input.addEventListener("input", () => {
    if (activeIndex < 0) activeIndex = 0;
    render();
  });
  input.addEventListener("keydown", onKeydown);

  // Clicking the dimmed backdrop closes the palette.
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) closePalette();
  });

  // Ctrl+Shift+P toggles the palette. Capture phase + stopPropagation so xterm
  // never sees the key while the palette is up.
  window.addEventListener(
    "keydown",
    (e) => {
      if (!TOGGLE_KEY(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (open) closePalette();
      else openPalette();
    },
    true
  );
}

/** Open the palette with a fresh item list and focus the input. */
export function openPalette(): void {
  // Never pop the palette over the settings modal.
  if (document.querySelector(".settings-backdrop")) return;
  if (!context) return;
  // Give the palette full keyboard focus: dismiss any open context menu and
  // close the search bar if it's up.
  closeContextMenu();
  if (isSearchOpen()) closeSearch();
  items = transientItems ? transientItems() : context.getItems();
  input.placeholder = transientPlaceholder ?? DEFAULT_PLACEHOLDER;
  rendered = [];
  activeIndex = 0;
  input.value = "";
  open = true;
  backdrop.hidden = false;
  render();
  input.focus();
}

/**
 * Open the palette scoped to a custom item source and placeholder — used for
 * sub-pickers like "Insert prompt…" that list a different kind of entry. The
 * override applies to this opening only; the next plain `openPalette()` shows
 * the full app item list again.
 */
export function openPaletteWith(
  getItems: () => PaletteItem[],
  placeholder?: string
): void {
  transientItems = getItems;
  transientPlaceholder = placeholder ?? null;
  openPalette();
}

export function closePalette(): void {
  if (!open) return;
  open = false;
  backdrop.hidden = true;
  transientItems = null;
  transientPlaceholder = null;
  input.placeholder = DEFAULT_PLACEHOLDER;
  context?.onClose?.();
}

/** Whether the palette is currently open (used to guard global shortcuts). */
export function isPaletteOpen(): boolean {
  return open;
}

export function togglePalette(): void {
  if (open) closePalette();
  else openPalette();
}
