import { describe, expect, test } from "bun:test";
import {
  DEFAULT_KEYBINDS,
  KEYBIND_ACTIONS,
  formatKeybind,
  keyNeedsModifier,
  keybindEqual,
  keybindSearchMatches,
  matchesKeybind,
  normalizeKeyName,
  parseKeybind,
} from "./keybinds";

/** Minimal KeyboardEvent-shaped object; only the fields the helpers read. */
function keyEvent(partial: Record<string, unknown> = {}): KeyboardEvent {
  return {
    key: "",
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...partial,
  } as unknown as KeyboardEvent;
}

describe("keybind registry", () => {
  test("every action has a default binding and unique id", () => {
    const ids = KEYBIND_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of KEYBIND_ACTIONS) {
      expect(DEFAULT_KEYBINDS[def.id]).toBe(def.default);
      expect(def.default.length).toBeGreaterThan(0);
    }
  });

  test("DEFAULT_KEYBINDS keys are exactly the action ids", () => {
    expect(Object.keys(DEFAULT_KEYBINDS).sort()).toEqual([...KEYBIND_ACTIONS.map((a) => a.id)].sort());
  });

  test("tab cycling defaults are Ctrl+Tab / Ctrl+Shift+Tab", () => {
    expect(DEFAULT_KEYBINDS.nextTab).toBe("Ctrl+Tab");
    expect(DEFAULT_KEYBINDS.previousTab).toBe("Ctrl+Shift+Tab");
  });

  test("Ctrl+Tab / Ctrl+Shift+Tab match the tab-cycling bindings", () => {
    expect(matchesKeybind(DEFAULT_KEYBINDS.nextTab, keyEvent({ key: "Tab", ctrlKey: true }))).toBe(true);
    expect(
      matchesKeybind(DEFAULT_KEYBINDS.previousTab, keyEvent({ key: "Tab", ctrlKey: true, shiftKey: true }))
    ).toBe(true);
    // Missing or extra modifiers must not match.
    expect(matchesKeybind(DEFAULT_KEYBINDS.nextTab, keyEvent({ key: "Tab" }))).toBe(false);
    expect(
      matchesKeybind(DEFAULT_KEYBINDS.nextTab, keyEvent({ key: "Tab", ctrlKey: true, shiftKey: true }))
    ).toBe(false);
  });
});

describe("normalizeKeyName", () => {
  test("uppercases single letters", () => {
    expect(normalizeKeyName("t")).toBe("T");
    expect(normalizeKeyName("T")).toBe("T");
  });

  test("spells out Space", () => {
    expect(normalizeKeyName(" ")).toBe("Space");
  });

  test("keeps named keys and symbols as-is", () => {
    expect(normalizeKeyName("Enter")).toBe("Enter");
    expect(normalizeKeyName("ArrowUp")).toBe("ArrowUp");
    expect(normalizeKeyName("F5")).toBe("F5");
    expect(normalizeKeyName("+")).toBe("+");
    expect(normalizeKeyName("=")).toBe("=");
  });
});

describe("formatKeybind", () => {
  test("formats a chord in canonical modifier order", () => {
    expect(
      formatKeybind(keyEvent({ key: "t", ctrlKey: true, shiftKey: true }))
    ).toBe("Ctrl+Shift+T");
  });

  test("returns null for modifier-only, dead and IME keys", () => {
    expect(formatKeybind(keyEvent({ key: "Control", ctrlKey: true }))).toBeNull();
    expect(formatKeybind(keyEvent({ key: "Shift", shiftKey: true }))).toBeNull();
    expect(formatKeybind(keyEvent({ key: "Meta", metaKey: true }))).toBeNull();
    expect(formatKeybind(keyEvent({ key: "Dead" }))).toBeNull();
    expect(formatKeybind(keyEvent({ key: "Process" }))).toBeNull();
    expect(formatKeybind(keyEvent({ key: "Unidentified" }))).toBeNull();
  });

  test("handles the equals key on US layouts (e.key '+')", () => {
    expect(formatKeybind(keyEvent({ key: "+", ctrlKey: true, shiftKey: true }))).toBe(
      "Ctrl+Shift++"
    );
  });
});

describe("parseKeybind", () => {
  test("parses a canonical chord", () => {
    expect(parseKeybind("Ctrl+Shift+T")).toEqual({
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
      key: "T",
    });
  });

  test("accepts lowercase keys and alternate modifier spellings", () => {
    expect(parseKeybind("ctrl+shift+t")).toEqual({
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
      key: "T",
    });
    expect(parseKeybind("Cmd+T")?.meta).toBe(true);
    expect(parseKeybind("Super+T")?.meta).toBe(true);
    expect(parseKeybind("Win+T")?.meta).toBe(true);
  });

  test("the key may itself contain '+'", () => {
    expect(parseKeybind("Ctrl+Shift++")?.key).toBe("+");
  });

  test("returns null for empty or whitespace-only input", () => {
    expect(parseKeybind("")).toBeNull();
    expect(parseKeybind("   ")).toBeNull();
  });
});

describe("matchesKeybind", () => {
  test("matches when modifiers and key align", () => {
    expect(
      matchesKeybind("Ctrl+Shift+T", keyEvent({ key: "T", ctrlKey: true, shiftKey: true }))
    ).toBe(true);
  });

  test("fails on modifier or key mismatch", () => {
    expect(matchesKeybind("Ctrl+Shift+T", keyEvent({ key: "T", ctrlKey: true }))).toBe(false);
    expect(
      matchesKeybind("Ctrl+Shift+T", keyEvent({ key: "X", ctrlKey: true, shiftKey: true }))
    ).toBe(false);
  });

  test("unbound or invalid bindings never match", () => {
    expect(matchesKeybind("", keyEvent({ key: "T", ctrlKey: true }))).toBe(false);
    expect(matchesKeybind(undefined, keyEvent({ key: "T" }))).toBe(false);
    expect(matchesKeybind("not-a-binding", keyEvent({ key: "T" }))).toBe(false);
  });
});

describe("keybindEqual", () => {
  test("is case-insensitive on the key and modifier-sensitive", () => {
    expect(keybindEqual("Ctrl+Shift+T", "Ctrl+Shift+t")).toBe(true);
    expect(keybindEqual("Ctrl+Shift+T", "Ctrl+Shift+X")).toBe(false);
    expect(keybindEqual("Ctrl+T", "Ctrl+Shift+T")).toBe(false);
  });
});

describe("keyNeedsModifier", () => {
  test("bare printable keys need a modifier", () => {
    expect(keyNeedsModifier("a")).toBe(true);
    expect(keyNeedsModifier("1")).toBe(true);
    expect(keyNeedsModifier("+")).toBe(true);
  });

  test("named keys and modifier keys do not", () => {
    expect(keyNeedsModifier("Enter")).toBe(false);
    expect(keyNeedsModifier("F1")).toBe(false);
    expect(keyNeedsModifier("Control")).toBe(false);
  });
});

describe("keybindSearchMatches", () => {
  const newTab = KEYBIND_ACTIONS.find((a) => a.id === "newTab")!;
  const binding = DEFAULT_KEYBINDS.newTab; // "Ctrl+Shift+T", group "Sessions", label "New agent tab"

  test("empty or whitespace query matches everything", () => {
    expect(keybindSearchMatches(newTab, binding, "")).toBe(true);
    expect(keybindSearchMatches(newTab, binding, "   ")).toBe(true);
  });

  test("matches by action label", () => {
    expect(keybindSearchMatches(newTab, binding, "agent")).toBe(true);
    expect(keybindSearchMatches(newTab, binding, "new tab")).toBe(true);
  });

  test("matches by group", () => {
    expect(keybindSearchMatches(newTab, binding, "session")).toBe(true);
  });

  test("matches by binding string", () => {
    expect(keybindSearchMatches(newTab, binding, "ctrl+shift+t")).toBe(true);
    // Tokens may span the binding's '+' separators.
    expect(keybindSearchMatches(newTab, binding, "ctrl t")).toBe(true);
    expect(keybindSearchMatches(newTab, binding, "SHIFT+T")).toBe(true);
  });

  test("unbound entries match by label or group only", () => {
    expect(keybindSearchMatches(newTab, "", "agent tab")).toBe(true);
    expect(keybindSearchMatches(newTab, "", "ctrl")).toBe(false);
  });

  test("every token must match somewhere", () => {
    expect(keybindSearchMatches(newTab, binding, "agent sessions")).toBe(true);
    expect(keybindSearchMatches(newTab, binding, "agent worktree")).toBe(false);
  });

  test("no match returns false", () => {
    expect(keybindSearchMatches(newTab, binding, "zzz")).toBe(false);
  });
});
