/**
 * Tests for the theme registry (themes.ts): every built-in theme must satisfy
 * the invariants the rest of the app relies on (unique ids, a complete
 * terminal palette, a valid color scheme, correctly-prefixed dockview theme),
 * and getTheme must resolve ids with a sane fallback.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_THEME_ID,
  THEMES,
  getTheme,
  type ColorScheme,
} from "./themes";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
/** xterm's selectionBackground defaults to `${foreground}33` (alpha suffix). */
const HEX_OR_ALPHA_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

/** Keys xterm's ITheme requires (16 colors + background/foreground/cursor). */
const TERMINAL_KEYS = [
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

describe("theme registry invariants", () => {
  test("theme ids and names are unique and non-empty", () => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const t of THEMES) {
      expect(t.id.length).toBeGreaterThan(0);
      expect(t.name.length).toBeGreaterThan(0);
      expect(ids.has(t.id)).toBe(false);
      expect(names.has(t.name)).toBe(false);
      ids.add(t.id);
      names.add(t.name);
    }
  });

  test("every theme declares a valid color scheme", () => {
    for (const t of THEMES) {
      expect(["light", "dark"]).toContain(t.colorScheme);
    }
  });

  test("every terminal palette is complete and hex", () => {
    for (const t of THEMES) {
      for (const key of TERMINAL_KEYS) {
        const value = (t.terminal as Record<string, unknown>)[key];
        expect(typeof value, `${t.id}.${key} missing`).toBe("string");
        const re = key === "selectionBackground" ? HEX_OR_ALPHA_RE : HEX_RE;
        expect(re.test(value as string), `${t.id}.${key}=${value}`).toBe(true);
      }
      // The cursor accent must match the background (so the cursor inverts).
      expect(t.terminal.cursorAccent).toBe(t.terminal.background);
    }
  });

  test("every UI palette is complete and hex", () => {
    for (const t of THEMES) {
      for (const [key, value] of Object.entries(t.ui)) {
        expect(HEX_RE.test(value), `${t.id}.ui.${key}=${value}`).toBe(true);
      }
    }
  });

  test("dockview themes are prefixed and share the hivefield override class", () => {
    for (const t of THEMES) {
      expect(t.dockview.name.startsWith("hivefield-")).toBe(true);
      expect(t.dockview.className).toContain("dockview-theme-hivefield");
    }
  });

  test("the default theme is the first entry and is Catppuccin Mocha", () => {
    expect(DEFAULT_THEME_ID).toBe("catppuccin-mocha");
    expect(THEMES[0].id).toBe(DEFAULT_THEME_ID);
    expect(THEMES[0].colorScheme).toBe("dark" satisfies ColorScheme);
  });
});

describe("getTheme", () => {
  test("resolves every registered id to itself", () => {
    for (const t of THEMES) {
      expect(getTheme(t.id)).toBe(t);
    }
  });

  test("falls back to the default for unknown, null and undefined ids", () => {
    const fallback = getTheme(undefined);
    expect(fallback.id).toBe(DEFAULT_THEME_ID);
    expect(getTheme("no-such-theme")).toBe(fallback);
    expect(getTheme(null)).toBe(fallback);
    expect(getTheme("")).toBe(fallback);
  });
});
