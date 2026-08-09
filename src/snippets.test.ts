/**
 * Tests for the "Insert prompt…" picker items (snippets.ts): every configured
 * snippet becomes one item with a readable label (unnamed fallback), a
 * truncated first-line preview, and a run() that hands the snippet to the
 * caller.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { snippetPickerItems } from "./snippets";
import { DEFAULT_SETTINGS, updateSettings, type PromptSnippet } from "./settings";

beforeEach(async () => {
  // Restore the default snippet list between tests.
  await updateSettings({ ...DEFAULT_SETTINGS });
});

describe("snippetPickerItems", () => {
  test("maps every snippet to a picker item in order", async () => {
    const snippets: PromptSnippet[] = [
      { name: "Review", content: "Review the diff." },
      { name: "Explain", content: "Explain this code." },
    ];
    await updateSettings({ promptSnippets: snippets });
    const items = snippetPickerItems(() => {});
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe("snippet-0");
    expect(items[0].label).toBe("Review");
    expect(items[0].detail).toBe("Review the diff.");
    expect(items[0].icon).toBe("✎");
    expect(items[0].group).toBe("Prompts");
    expect(items[1].id).toBe("snippet-1");
    expect(items[1].label).toBe("Explain");
  });

  test("a blank name falls back to (unnamed)", async () => {
    await updateSettings({
      promptSnippets: [{ name: "   ", content: "Hello" }],
    });
    const items = snippetPickerItems(() => {});
    expect(items[0].label).toBe("(unnamed)");
  });

  test("the detail preview is the first line, truncated to 61 chars", async () => {
    const longLine = "x".repeat(100);
    const snippets: PromptSnippet[] = [
      { name: "Long", content: `${longLine}\nsecond line` },
      { name: "Short", content: "first line\nsecond line" },
    ];
    await updateSettings({ promptSnippets: snippets });
    const items = snippetPickerItems(() => {});
    expect(items[0].detail).toBe(`${"x".repeat(61)}…`);
    expect(items[1].detail).toBe("first line");
  });

  test("an empty snippet content yields an empty preview", async () => {
    await updateSettings({ promptSnippets: [{ name: "Empty", content: "" }] });
    const items = snippetPickerItems(() => {});
    expect(items[0].detail).toBe("");
  });

  test("run() calls insert with the chosen snippet", async () => {
    const snippets: PromptSnippet[] = [
      { name: "Write tests", content: "Write tests for this code." },
    ];
    await updateSettings({ promptSnippets: snippets });
    const inserted: PromptSnippet[] = [];
    const items = snippetPickerItems((s) => inserted.push(s));
    items[0].run();
    expect(inserted).toEqual(snippets);
  });

  test("default snippets produce one item each", () => {
    const items = snippetPickerItems(() => {});
    expect(items).toHaveLength(DEFAULT_SETTINGS.promptSnippets.length);
  });
});
