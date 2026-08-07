/**
 * Tests for the settings schema versioning: the document keeps its own
 * `schemaVersion` (a newer doc loaded by an older app is not downgraded),
 * and unknown fields from a newer app survive a round-trip through this
 * version (the backend stores the document verbatim, so dropping them would
 * corrupt newer settings).
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  getSettings,
  updateSettings,
} from "./settings";

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
