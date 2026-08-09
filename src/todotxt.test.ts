/**
 * Tests for the todo.txt panel's pure helpers (todotxt-core.ts): parsing raw
 * file contents into a task list and the comparison key the 30s external-edit
 * poller uses to decide whether the renderer needs refreshing.
 */

import { describe, expect, test } from "bun:test";
import { parseTasks, tasksKey, toggleTask } from "./todotxt-core";

describe("parseTasks", () => {
  test("parses every non-blank line", () => {
    const tasks = parseTasks("x (A) 2024-01-02 2024-01-01 Call Mom\n(B) Buy milk\n");
    expect(tasks.map((t) => t.raw)).toEqual([
      "x (A) 2024-01-02 2024-01-01 Call Mom",
      "(B) Buy milk",
    ]);
    expect(tasks[0].done).toBe(true);
    expect(tasks[1].priority).toBe("B");
  });

  test("blank lines and a trailing newline are dropped", () => {
    const tasks = parseTasks("\n\nWrite tests\n\n");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].text).toBe("Write tests");
  });

  test("empty content yields an empty list", () => {
    expect(parseTasks("")).toEqual([]);
  });
});

describe("tasksKey", () => {
  test("serializes raws joined by newline", () => {
    const tasks = parseTasks("First\nSecond");
    expect(tasksKey(tasks)).toBe("First\nSecond");
  });

  test("is equal for identical lists", () => {
    expect(tasksKey(parseTasks("A\nB"))).toBe(tasksKey(parseTasks("A\nB")));
  });

  test("differs when a task is appended", () => {
    const before = parseTasks("A");
    const after = parseTasks("A\nB");
    expect(tasksKey(after)).not.toBe(tasksKey(before));
  });

  test("differs when a task is toggled on disk", () => {
    const tasks = parseTasks("(A) Ship it");
    const toggled = toggleTask(tasks, 0);
    expect(tasksKey(toggled)).not.toBe(tasksKey(parseTasks("(A) Ship it")));
  });

  test("ignores whitespace-only differences between lines", () => {
    // The poller compares parsed raws, so surrounding blank lines / a
    // trailing newline in the file must not count as a change.
    expect(tasksKey(parseTasks("A\nB\n"))).toBe(tasksKey(parseTasks("A\nB")));
  });
});
