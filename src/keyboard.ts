/**
 * Global keyboard shortcuts: app actions dispatch from the configured keybinds
 * (Settings → Keybinds), including vim-style pane movement, workspace
 * switching (1…10), font-size zoom, clipboard paste/copy, and the font zoom
 * helper.
 */

import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { matchesKeybind, type KeybindAction } from "./keybinds";
import { getSettings, updateSettings, FONT_SIZE_MAX, FONT_SIZE_MIN } from "./settings";
import { toggleSettings } from "./settings-ui";
import { activeSessionEntry, addPanelWithMode, movePaneFocus } from "./sessions";
import { renamePanel } from "./titles";
import { openSearch, isSearchOpen } from "./search";
import { isPaletteOpen } from "./palette";
import { isContextMenuOpen } from "./context-menu";
import { switchToWorkspace } from "./sidebar";
import { openNewWindow } from "./windows";
import { DEFAULT_MODE } from "./modes";
import { getApi } from "./state";

/** Bump the global terminal font size by `delta` (persisted in settings). */
export function zoomBy(delta: number): void {
  const s = getSettings();
  const next = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, s.fontSize + delta));
  void updateSettings({ fontSize: next });
}

export function setupKeyboard() {
  const settingsOpen = () => document.querySelector(".settings-backdrop") !== null;
  // While the search bar or command palette is up, keystrokes belong to their
  // inputs, so the global shortcuts below must not fire.
  const uiOpen = () =>
    settingsOpen() || isSearchOpen() || isPaletteOpen() || isContextMenuOpen();

  // All app shortcuts dispatch from the configured keybinds (Settings →
  // Keybinds). Bubble phase is fine for these combos: they are not printable
  // terminal keys by default, and even a rebound printable combo is caught
  // here because xterm only sees events that reach its own element.
  window.addEventListener("keydown", (e) => {
    if (uiOpen()) return;
    const kb = getSettings().keybinds;
    if (matchesKeybind(kb.newTab, e)) {
      e.preventDefault();
      addPanelWithMode(DEFAULT_MODE);
    }
    // Open a new app window (see openNewWindow).
    if (matchesKeybind(kb.newWindow, e)) {
      e.preventDefault();
      openNewWindow();
    }
    if (matchesKeybind(kb.closePanel, e)) {
      e.preventDefault();
      getApi().activePanel?.api.close();
    }
    // Rename the active tab.
    if (matchesKeybind(kb.renameTab, e)) {
      e.preventDefault();
      const panel = getApi().activePanel;
      if (panel) void renamePanel(panel);
    }
    if (matchesKeybind(kb.settings, e)) {
      e.preventDefault();
      toggleSettings();
    }
    // Paste the system clipboard into the active terminal / copy its
    // selection. WebViews don't bind these combos natively (Ctrl+V/C are the
    // browser defaults, and Ctrl+C is SIGINT in the shell), so they would
    // otherwise fall through as no-ops.
    if (matchesKeybind(kb.paste, e)) {
      e.preventDefault();
      const entry = activeSessionEntry();
      if (entry) {
        void readText()
          .then((text) => entry.canvas.write(text))
          .catch((err) => console.error("clipboard read failed", err));
      }
    }
    if (matchesKeybind(kb.copy, e)) {
      const selection = ""; // canvas selection not yet implemented
      if (selection) {
        e.preventDefault();
        void writeText(selection).catch((err) =>
          console.error("clipboard write failed", err)
        );
      }
      // Without a selection the key is left alone and falls through to the
      // shell, matching other terminals.
    }
  });

  // Vim-style pane movement (focus left/down/up/right), workspace switching
  // (1…10) and font-size zoom. Registered in the CAPTURE phase so the keys
  // are intercepted before xterm sees them (otherwise a rebound Ctrl+H is
  // backspace, Ctrl+J newline, Ctrl+K kill-line, Ctrl+L clear-screen). If
  // there is no adjacent pane in that direction the key falls through to the
  // terminal.
  window.addEventListener(
    "keydown",
    (e) => {
      if (uiOpen()) return;
      const kb = getSettings().keybinds;
      // Workspace slots 1…10 (rebindable). Switching to an empty slot starts
      // a fresh workspace there.
      for (let slot = 1; slot <= 10; slot++) {
        if (matchesKeybind(kb[`workspace${slot}` as KeybindAction], e)) {
          e.preventDefault();
          e.stopPropagation();
          switchToWorkspace(slot);
          return;
        }
      }
      // Font-size zoom.
      if (matchesKeybind(kb.zoomIn, e)) {
        e.preventDefault();
        e.stopPropagation();
        void zoomBy(1);
        return;
      }
      if (matchesKeybind(kb.zoomOut, e)) {
        e.preventDefault();
        e.stopPropagation();
        void zoomBy(-1);
        return;
      }
      // Pane movement: only intercept when there actually is an adjacent pane.
      for (const [id, direction] of [
        ["focusLeft", "left"],
        ["focusDown", "down"],
        ["focusUp", "up"],
        ["focusRight", "right"],
      ] as const) {
        if (matchesKeybind(kb[id], e) && movePaneFocus(direction)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    },
    true
  );
}
