/**
 * Tests for the shared session-mode catalog extracted from main.ts
 * (modes.ts) and the state module's pure helpers (state.ts).
 */

import { describe, expect, test } from "bun:test";
import { AGENTS, RAW_MODE } from "./agents";
import { customs, defaultMode, DEFAULT_MODE, sessionModes } from "./modes";
import { updateSettings } from "./settings";
import {
  bumpPanelCounter,
  isWindowFocused,
  nextPanelId,
  parkedKeyFor,
  setWindowFocused,
} from "./state";

describe("modes.ts (session-mode catalog)", () => {
  test("the default mode is the first built-in agent", () => {
    expect(DEFAULT_MODE).toBe(AGENTS[0].id);
  });

  test("with default settings, every built-in agent plus raw is offered", () => {
    const modes = sessionModes();
    expect(modes.map((m) => m.mode)).toEqual([
      ...AGENTS.map((a) => a.id),
      RAW_MODE,
    ]);
    expect(modes[modes.length - 1]).toEqual({
      mode: RAW_MODE,
      label: "raw term",
      icon: "$",
    });
  });

  test("customs() is empty by default", () => {
    expect(customs()).toEqual([]);
  });

  test("sessionModes excludes agents hidden by the visibleAgents setting", async () => {
    // updateSettings applies to the in-memory store synchronously; the
    // backend/localStorage persistence is best-effort and swallowed in test.
    await updateSettings({ visibleAgents: [AGENTS[0].id] });
    try {
      const modes = sessionModes();
      expect(modes.map((m) => m.mode)).toEqual([AGENTS[0].id, RAW_MODE]);
    } finally {
      await updateSettings({ visibleAgents: AGENTS.map((a) => a.id) });
    }
  });

  test("defaultMode() returns the first built-in agent by default", () => {
    expect(defaultMode()).toBe(AGENTS[0].id);
  });

  test("defaultMode() returns a configured agent, raw, or nothing", async () => {
    try {
      await updateSettings({ defaultMode: AGENTS[1].id });
      expect(defaultMode()).toBe(AGENTS[1].id);

      await updateSettings({ defaultMode: RAW_MODE });
      expect(defaultMode()).toBe(RAW_MODE);

      // Empty string = "don't auto-open anything".
      await updateSettings({ defaultMode: "" });
      expect(defaultMode()).toBeUndefined();
    } finally {
      await updateSettings({ defaultMode: AGENTS[0].id });
    }
  });

  test("defaultMode() resolves a custom agent configured as default", async () => {
    const custom = {
      id: "custom-1",
      label: "Custom",
      command: "echo hi",
      icon: "✦",
    };
    try {
      await updateSettings({
        customAgents: [custom],
        defaultMode: "custom-1",
      });
      expect(defaultMode()).toBe("custom-1");
    } finally {
      await updateSettings({ customAgents: [], defaultMode: AGENTS[0].id });
    }
  });
});

describe("state.ts (shared session state helpers)", () => {
  test("parkedKeyFor namespaces parked sessions uniquely", () => {
    expect(parkedKeyFor(7)).toBe("parked:7");
    expect(parkedKeyFor(7)).not.toBe(parkedKeyFor(8));
  });

  test("nextPanelId increments and bumpPanelCounter jumps past restored ids", () => {
    const a = nextPanelId();
    const b = nextPanelId();
    expect(a).toBe("panel-1");
    expect(b).toBe("panel-2");
    bumpPanelCounter(42);
    expect(nextPanelId()).toBe("panel-43");
  });

  test("window focus flag round-trips", () => {
    setWindowFocused(false);
    expect(isWindowFocused()).toBe(false);
    setWindowFocused(true);
    expect(isWindowFocused()).toBe(true);
  });
});
