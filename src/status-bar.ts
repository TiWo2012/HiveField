/**
 * Status bar shown below the terminal area while broadcast mode is engaged.
 *
 * Renders a "⤳ All panes" toggle button (Ctrl+Shift+B) plus the active
 * session's mode icon and title so the user always knows which panes are
 * receiving broadcast input. When broadcast is off the bar hides; toggling
 * on makes it visible.
 */

import { isKnownModeAll, modeIconAll, modeLabelAll } from "./agents";
import { customs, DEFAULT_MODE, type Mode } from "./modes";
import { isBroadcasting, onBroadcastChange, toggleBroadcast } from "./broadcast";
import { getSettings } from "./settings";
import { getApi, panelStatus } from "./state";

let barEl: HTMLElement | null = null;
let toggleBtn: HTMLButtonElement | null = null;
let sessionIcon: HTMLElement | null = null;
let sessionTitle: HTMLElement | null = null;
let hintEl: HTMLElement | null = null;

function updateToggle(): void {
  if (!toggleBtn) return;
  const on = isBroadcasting();
  toggleBtn.classList.toggle("active", on);
  toggleBtn.textContent = "";
  const icon = document.createElement("span");
  icon.className = "status-bar-toggle-icon";
  icon.textContent = on ? "⤳" : "⤳";
  toggleBtn.appendChild(icon);
  toggleBtn.appendChild(document.createTextNode(on ? "All panes" : "All panes"));
}

function updateSession(): void {
  if (!sessionIcon || !sessionTitle) return;
  const panel = getApi()?.activePanel;
  if (!panel) {
    sessionIcon.textContent = "";
    sessionTitle.textContent = "no session";
    return;
  }
  const params = panel.api.getParameters() as Record<string, unknown>;
  const mode: Mode =
    typeof params.mode === "string" &&
    isKnownModeAll(params.mode, customs())
      ? params.mode
      : DEFAULT_MODE;
  sessionIcon.textContent = modeIconAll(mode, customs());
  const st = panelStatus.get(panel.id);
  const title = st?.baseTitle ?? panel.title ?? modeLabelAll(mode, customs());
  sessionTitle.textContent = title.replace(/^[●✓] /, "");
}

function updateHint(): void {
  if (!hintEl) return;
  const kb = getSettings().keybinds.broadcastToggle || "Ctrl+Shift+B";
  hintEl.innerHTML = "";
  const kbd = document.createElement("kbd");
  kbd.textContent = kb;
  hintEl.appendChild(kbd);
  hintEl.appendChild(document.createTextNode(" to toggle"));
}

function setVisible(on: boolean): void {
  if (!barEl) return;
  barEl.classList.toggle("visible", on);
}

/**
 * Build the status bar and insert it into the DOM. Safe to call once during
 * init; returns the bar element so callers can reference it.
 */
export function initStatusBar(): HTMLElement {
  const existing = document.getElementById("status-bar");
  if (!existing) throw new Error("status-bar element not found in DOM");
  barEl = existing;

  // Toggle button: "⤳ All panes" — click toggles broadcast.
  toggleBtn = document.createElement("button");
  toggleBtn.className = "status-bar-toggle";
  toggleBtn.type = "button";
  toggleBtn.addEventListener("click", () => {
    toggleBroadcast();
  });
  barEl.appendChild(toggleBtn);

  // Separator.
  const sep = document.createElement("div");
  sep.className = "status-bar-separator";
  barEl.appendChild(sep);

  // Active session: mode icon + title.
  const sessionEl = document.createElement("div");
  sessionEl.className = "status-bar-session";
  sessionIcon = document.createElement("span");
  sessionIcon.className = "status-bar-session-icon";
  sessionTitle = document.createElement("span");
  sessionTitle.className = "status-bar-session-title";
  sessionEl.appendChild(sessionIcon);
  sessionEl.appendChild(sessionTitle);
  barEl.appendChild(sessionEl);

  // Shortcut hint (right-aligned).
  hintEl = document.createElement("span");
  hintEl.className = "status-bar-hint";
  barEl.appendChild(hintEl);

  // Initial render.
  updateToggle();
  updateSession();
  updateHint();

  // Keep the toggle button in sync with the broadcast state.
  onBroadcastChange((on) => {
    updateToggle();
    setVisible(on);
  });

  return barEl;
}

/** Refresh the active-session portion of the status bar (title changes, etc.). */
export function refreshStatusBar(): void {
  updateSession();
  updateToggle();
  updateHint();
}
