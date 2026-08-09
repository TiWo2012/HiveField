/**
 * Tests for the settings schema versioning: the document keeps its own
 * `schemaVersion` (a newer doc loaded by an older app is not downgraded),
 * and unknown fields from a newer app survive a round-trip through this
 * version (the backend stores the document verbatim, so dropping them would
 * corrupt newer settings).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  CONTRAST_RATIO_MAX,
  CONTRAST_RATIO_MIN,
  DEFAULT_SETTINGS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LETTER_SPACING_MAX,
  LETTER_SPACING_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  OPACITY_MAX,
  OPACITY_MIN,
  SETTINGS_SCHEMA_VERSION,
  getPersistError,
  getSettings,
  subscribePersistError,
  updateSettings,
} from "./settings";

beforeEach(async () => {
  // Every test starts from a clean document.
  await updateSettings({ ...DEFAULT_SETTINGS });
});

describe("settings schema versioning", () => {
  test("the default document is stamped with the current schema version", () => {
    expect(DEFAULT_SETTINGS.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(getSettings().schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
  });

  test("a normal update keeps the current version", async () => {
    await updateSettings({ fontSize: 16 });
    expect(getSettings().schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(getSettings().fontSize).toBe(16);
  });

  test("a newer document keeps its own version and unknown fields", async () => {
    await updateSettings({
      schemaVersion: 3,
      futureField: "keep me",
    } as unknown as Partial<typeof DEFAULT_SETTINGS>);
    expect(getSettings().schemaVersion).toBe(3);
    // Unknown keys written by a newer app survive the round-trip.
    expect(
      (getSettings() as unknown as Record<string, unknown>).futureField
    ).toBe("keep me");
  });

  test("a bogus version falls back to the current one", async () => {
    await updateSettings({
      schemaVersion: -5,
    } as unknown as Partial<typeof DEFAULT_SETTINGS>);
    expect(getSettings().schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
  });

  test("restore defaults resets the version stamp", async () => {
    await updateSettings({ ...DEFAULT_SETTINGS });
    expect(getSettings().schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
  });
});

describe("settings normalization", () => {
  test("numeric values are clamped to their bounds", async () => {
    await updateSettings({
      fontSize: 999,
      lineHeight: 99,
      letterSpacing: -99,
      minimumContrastRatio: 99,
      backgroundOpacity: 99,
    } as never);
    const s = getSettings();
    expect(s.fontSize).toBe(FONT_SIZE_MAX);
    expect(s.lineHeight).toBe(LINE_HEIGHT_MAX);
    expect(s.letterSpacing).toBe(LETTER_SPACING_MIN);
    expect(s.minimumContrastRatio).toBe(CONTRAST_RATIO_MAX);
    expect(s.backgroundOpacity).toBe(OPACITY_MAX);

    await updateSettings({
      fontSize: -5,
      lineHeight: 0.1,
      letterSpacing: 99,
      minimumContrastRatio: -1,
      backgroundOpacity: 0.01,
    } as never);
    const s2 = getSettings();
    expect(s2.fontSize).toBe(FONT_SIZE_MIN);
    expect(s2.lineHeight).toBe(LINE_HEIGHT_MIN);
    expect(s2.letterSpacing).toBe(LETTER_SPACING_MAX);
    expect(s2.minimumContrastRatio).toBe(CONTRAST_RATIO_MIN);
    expect(s2.backgroundOpacity).toBe(OPACITY_MIN);
  });

  test("wrong-typed values fall back to defaults", async () => {
    await updateSettings({
      fontSize: "huge",
      cursorBlink: "yes",
      theme: 42,
      fontFamily: "",
      dictationEngine: "off",
    } as never);
    const s = getSettings();
    expect(s.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    expect(s.cursorBlink).toBe(DEFAULT_SETTINGS.cursorBlink);
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(s.fontFamily).toBe(DEFAULT_SETTINGS.fontFamily);
    expect(s.dictationEngine).toBe("whisper");
  });

  test("an unknown theme id falls back to the default theme", async () => {
    await updateSettings({ theme: "no-such-theme" } as never);
    expect(getSettings().theme).toBe(DEFAULT_SETTINGS.theme);
  });

  test("visibleAgents drops ids that are no longer in the registry", async () => {
    await updateSettings({ visibleAgents: ["stale-agent", "codex"] } as never);
    const s = getSettings();
    expect(s.visibleAgents).toContain("codex");
    expect(s.visibleAgents).not.toContain("stale-agent");
  });

  test("an explicit empty visibleAgents hides every agent", async () => {
    await updateSettings({ visibleAgents: [] } as never);
    expect(getSettings().visibleAgents).toEqual([]);
  });

  test("invalid custom agents are dropped, valid ones are kept", async () => {
    await updateSettings({
      customAgents: [
        { id: "ok", label: "OK", command: "echo hi" },
        { id: "", label: "No id", command: "echo hi" },
        { id: "nolabel", label: "  ", command: "echo hi" },
        { id: "nocmd", label: "No cmd", command: "  " },
        // Collides with a built-in agent id → dropped.
        { id: "codex", label: "Collides", command: "echo hi" },
        { id: "dup", label: "Dup A", command: "echo a" },
        { id: "dup", label: "Dup B", command: "echo b" },
      ] as never,
    });
    const customs = getSettings().customAgents;
    expect(customs.map((a) => a.id)).toEqual(["ok", "dup"]);
    expect(customs[0].icon).toBe("✦");
  });

  test("custom agents show up in visibleAgents fallback", async () => {
    await updateSettings({
      customAgents: [{ id: "custom-1", label: "Custom", command: "echo hi" }],
    } as never);
    // Missing visibleAgents key (older doc) → all built-ins + customs.
    const { visibleAgents, ...legacy } = getSettings();
    await updateSettings({ ...legacy, visibleAgents: undefined } as never);
    expect(getSettings().visibleAgents).toContain("custom-1");
  });

  test("invalid keybind values fall back to their defaults", async () => {
    await updateSettings({
      keybinds: { newTab: 42, copy: "" } as never,
    });
    const kb = getSettings().keybinds;
    // A non-string value is not a binding → the default stays.
    expect(kb.newTab).toBe(DEFAULT_SETTINGS.keybinds.newTab);
    // Empty string is a valid "unbound" value.
    expect(kb.copy).toBe("");
  });

  test("promptSnippets keeps valid entries and drops non-objects", async () => {
    await updateSettings({
      promptSnippets: [
        { name: "A", content: "a" },
        null,
        "string",
        { name: "B" },
        { content: "c" },
      ] as never,
    });
    expect(getSettings().promptSnippets).toEqual([
      { name: "A", content: "a" },
      { name: "B", content: "" },
      { name: "", content: "c" },
    ]);
  });
});

describe("settings persistence fallback", () => {
  test("a failed backend write surfaces via getPersistError", async () => {
    // In the test environment the backend IPC is unavailable, so every
    // updateSettings hits the fallback path (exactly what happens in a
    // real webview without the Tauri runtime).
    const errors: (string | undefined)[] = [];
    const unsub = subscribePersistError((err) => errors.push(err));
    await updateSettings({ fontSize: 15 });
    unsub();
    expect(errors.length).toBeGreaterThan(0);
    expect(getPersistError()).toBeDefined();
  });
});
