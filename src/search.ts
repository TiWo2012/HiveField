import { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { matchesKeybind } from "./keybinds";
import { getSettings } from "./settings";
import { getTheme } from "./themes";

/**
 * A terminal that can be searched. Every session terminal loads a SearchAddon
 * alongside its FitAddon, so searching always targets the addon of the active
 * session.
 */
export interface SearchableTerminal {
  terminal: Terminal;
  searchAddon: SearchAddon;
}

export interface SearchContext {
  /** Element the floating search bar is attached to (the terminal workspace). */
  container: HTMLElement;
  /** Resolve the terminal the search applies to — normally the active panel. */
  getActive: () => SearchableTerminal | undefined;
  /** Resolve the current "find" keybinding (Settings → Keybinds). */
  toggleKeybind?: () => string;
}

/**
 * Search match highlight colors derived from the active theme. xterm's
 * decoration API only accepts `#RRGGBB` (no alpha / no CSS variables), so
 * we sample the theme's UI palette at search time. A theme change while the
 * search bar is open re-runs the search via the settings subscriber in
 * main.ts, which picks up the new colors.
 */
function matchDecorations() {
  const ui = getTheme(getSettings().theme).ui;
  return {
    matchBackground: ui.surface1,
    matchBorder: ui.overlay0,
    matchOverviewRuler: ui.surface1,
    activeMatchBackground: ui.accent,
    activeMatchBorder: ui.accent,
    activeMatchColorOverviewRuler: ui.yellow,
  };
}

/** Cap on simultaneously highlighted matches (the addon defaults to 1000). */
const HIGHLIGHT_LIMIT = 2000;

let context: SearchContext | null = null;
let bar: HTMLElement;
let input: HTMLInputElement;
let count: HTMLElement;
let caseBtn: HTMLButtonElement;

let open = false;
let caseSensitive = false;
/** Addon of the last terminal we highlighted, so we can clear it on close/switch. */
let lastSearched: SearchAddon | undefined;
/** Addons that already got an `onDidChangeResults` listener. */
const listeners = new WeakSet<SearchAddon>();

function updateCount(resultIndex: number, resultCount: number): void {
  if (resultCount === 0) {
    count.textContent = "0/0";
    count.classList.add("no-match");
  } else if (resultIndex === -1) {
    // Above the highlight limit: the addon only reports the active result.
    count.textContent = `${resultCount}+`;
    count.classList.remove("no-match");
  } else {
    count.textContent = `${resultIndex + 1}/${resultCount}`;
    count.classList.remove("no-match");
  }
}

/** Attach the match-counter listener once per addon. */
function attachResultListener(addon: SearchAddon): void {
  if (listeners.has(addon)) return;
  listeners.add(addon);
  addon.onDidChangeResults((e) => updateCount(e.resultIndex, e.resultCount));
}

function searchOptions(incremental: boolean) {
  return { caseSensitive, incremental, decorations: matchDecorations() };
}

function runSearch(direction: "next" | "prev"): void {
  const active = context?.getActive();
  const query = input.value;
  if (!active || !query) {
    count.textContent = "";
    lastSearched?.clearDecorations();
    lastSearched = undefined;
    return;
  }
  attachResultListener(active.searchAddon);
  if (lastSearched !== active.searchAddon) {
    lastSearched?.clearDecorations();
    lastSearched = active.searchAddon;
  }
  if (direction === "next") {
    active.searchAddon.findNext(query, searchOptions(true));
  } else {
    active.searchAddon.findPrevious(query, searchOptions(false));
  }
}

function toggleCase(): void {
  caseSensitive = !caseSensitive;
  caseBtn.classList.toggle("active", caseSensitive);
  runSearch("next");
}

export function openSearch(): void {
  // Never pop the bar over the settings modal or the command palette.
  if (document.querySelector(".settings-backdrop")) return;
  const palette = document.querySelector<HTMLElement>(".palette-backdrop");
  if (palette && !palette.hidden) return;
  open = true;
  bar.hidden = false;
  input.focus();
  input.select();
  if (input.value) runSearch("next");
}

export function closeSearch(): void {
  if (!open) return;
  open = false;
  bar.hidden = true;
  count.textContent = "";
  lastSearched?.clearDecorations();
  lastSearched = undefined;
  context?.getActive()?.terminal.focus();
}

/** Whether the search bar is currently open (used to guard global shortcuts). */
export function isSearchOpen(): boolean {
  return open;
}

/**
 * Re-run the search against the current active terminal. Called when the active
 * panel changes while the bar is open so highlights follow the focus.
 */
export function rerunSearch(): void {
  if (!open || !input?.value) return;
  lastSearched?.clearDecorations();
  lastSearched = undefined;
  runSearch("next");
}

function buildButton(
  label: string,
  title: string,
  className: string,
  onClick: () => void
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.title = title;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

export function initSearch(ctx: SearchContext): void {
  context = ctx;

  bar = document.createElement("div");
  bar.id = "search-bar";
  bar.className = "search-bar";
  bar.setAttribute("role", "search");
  bar.hidden = true;

  const icon = document.createElement("span");
  icon.className = "search-bar-icon";
  icon.textContent = "⌕";
  bar.appendChild(icon);

  input = document.createElement("input");
  input.type = "text";
  input.className = "search-bar-input";
  input.placeholder = "Find…";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.autocapitalize = "off";
  bar.appendChild(input);

  count = document.createElement("span");
  count.className = "search-bar-count";
  bar.appendChild(count);

  bar.appendChild(
    buildButton("↑", "Previous match (Shift+Enter)", "search-bar-btn", () => runSearch("prev"))
  );
  bar.appendChild(
    buildButton("↓", "Next match (Enter)", "search-bar-btn", () => runSearch("next"))
  );

  caseBtn = buildButton("Aa", "Match case (Alt+C)", "search-bar-btn search-bar-case", toggleCase);
  bar.appendChild(caseBtn);

  bar.appendChild(
    buildButton("✕", "Close search (Esc)", "search-bar-btn search-bar-close", closeSearch)
  );

  ctx.container.appendChild(bar);

  // Live incremental search as the query is typed.
  input.addEventListener("input", () => runSearch("next"));

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runSearch(e.shiftKey ? "prev" : "next");
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeSearch();
    } else if (e.altKey && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      toggleCase();
    }
  });

  // The configured find binding toggles the bar; Esc closes it. Capture phase
  // so xterm never sees these keys while the bar is up.
  window.addEventListener(
    "keydown",
    (e) => {
      const isFind = matchesKeybind(ctx.toggleKeybind?.() ?? "Ctrl+Shift+F", e);
      if (isFind) {
        e.preventDefault();
        e.stopPropagation();
        if (open) {
          input.focus();
          input.select();
        } else {
          openSearch();
        }
        return;
      }
      if (open && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeSearch();
      }
    },
    true
  );
}
