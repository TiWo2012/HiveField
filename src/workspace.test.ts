/**
 * Tests for workspace document parsing and slot bookkeeping (workspace.ts).
 * The parser is the compatibility boundary for saved layouts: it has to
 * understand the current `{current, slots}` document, the legacy bare
 * dockview layout, and arbitrary junk from disk without throwing.
 */

import { describe, expect, test } from "bun:test";
import {
  getSlotLabel,
  getWorkspaceSlots,
  parseWorkspaceDoc,
  renameWorkspace,
  WORKSPACE_SLOTS,
} from "./workspace";

/** A minimal dockview-shaped layout. */
function layout(panelId = "panel-1") {
  return {
    grid: { root: { type: "branch", data: [] } },
    panels: { [panelId]: { id: panelId, contentComponent: "terminal" } },
  } as never;
}

describe("parseWorkspaceDoc — current format", () => {
  test("reads the current slot, names and layouts", () => {
    const doc = {
      current: 3,
      slots: {
        "1": { name: "docs", layout: layout("panel-1") },
        "3": { layout: layout("panel-9") },
      },
    };
    const parsed = parseWorkspaceDoc(doc);
    expect(parsed.current).toBe(3);
    expect([...parsed.slots.keys()]).toEqual([1, 3]);
    expect(parsed.slots.get(1)?.name).toBe("docs");
    expect(parsed.slots.get(1)?.layout).toBe(doc.slots["1"].layout);
    expect(parsed.slots.get(3)?.layout).toBe(doc.slots["3"].layout);
  });

  test("keeps a named slot with no saved layout", () => {
    const parsed = parseWorkspaceDoc({ current: 2, slots: { "2": { name: "scratch" } } });
    expect(parsed.slots.get(2)).toEqual({ name: "scratch" });
  });

  test("clamps the current slot into 1..WORKSPACE_SLOTS and floors fractions", () => {
    expect(parseWorkspaceDoc({ current: 0, slots: {} }).current).toBe(1);
    expect(parseWorkspaceDoc({ current: -5, slots: {} }).current).toBe(1);
    expect(parseWorkspaceDoc({ current: 99, slots: {} }).current).toBe(WORKSPACE_SLOTS);
    expect(parseWorkspaceDoc({ current: 3.9, slots: {} }).current).toBe(3);
  });

  test("drops out-of-range, non-integer and empty slot entries", () => {
    const parsed = parseWorkspaceDoc({
      current: 1,
      slots: {
        "0": { name: "zero" },
        "11": { name: "too high" },
        abc: { name: "not a number" },
        "2": null,
        "3": "not an object",
        "4": {},
        "5": { name: "kept" },
      },
    });
    expect([...parsed.slots.keys()]).toEqual([5]);
    expect(parsed.slots.get(5)?.name).toBe("kept");
  });

  test("ignores malformed layouts inside a valid slot entry", () => {
    const parsed = parseWorkspaceDoc({
      current: 1,
      slots: { "1": { name: "docs", layout: { grid: null, panels: {} } } },
    });
    expect(parsed.slots.get(1)).toEqual({ name: "docs" });
  });
});

describe("parseWorkspaceDoc — legacy and malformed documents", () => {
  test("treats a bare layout as legacy slot 1", () => {
    const saved = layout("panel-7");
    const parsed = parseWorkspaceDoc(saved);
    expect(parsed.current).toBe(1);
    expect(parsed.slots.size).toBe(1);
    expect(parsed.slots.get(1)?.layout).toBe(saved);
  });

  test("accepts an empty `panels` object as a plausible legacy layout", () => {
    const parsed = parseWorkspaceDoc({ grid: {}, panels: {} });
    expect(parsed.slots.get(1)?.layout).toEqual({ grid: {}, panels: {} } as never);
  });

  test("returns an empty slot-1 workspace for junk", () => {
    for (const raw of [null, undefined, 42, "text", [], {}, { grid: null, panels: {} }]) {
      const parsed = parseWorkspaceDoc(raw);
      expect(parsed.current).toBe(1);
      expect(parsed.slots.size).toBe(0);
    }
  });

  test("defaults current to 1 when a current-format doc omits it", () => {
    const parsed = parseWorkspaceDoc({ slots: { "2": { name: "two" } } });
    expect(parsed.current).toBe(1);
    expect(parsed.slots.get(2)?.name).toBe("two");
  });
});

describe("slot labels and renaming", () => {
  test("unset slots get a generic workspace label", () => {
    expect(getSlotLabel(8)).toBe("workspace 8");
  });

  test("renaming trims the name and an empty name clears it", async () => {
    await renameWorkspace(8, "  docs  ");
    expect(getSlotLabel(8)).toBe("docs");
    expect(getWorkspaceSlots()).toContainEqual({ slot: 8, name: "docs", hasLayout: false });

    await renameWorkspace(8, "   ");
    expect(getSlotLabel(8)).toBe("workspace 8");
    // Emptied, unnamed slots disappear from the UI strip.
    expect(getWorkspaceSlots()).not.toContainEqual(expect.objectContaining({ slot: 8 }));
  });
});
