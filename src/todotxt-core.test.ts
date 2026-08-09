/**
 * Tests for the pure todo.txt grammar (todotxt-core.ts): parsing, re-
 * serialization, and the completion/add mutations used by the todo.txt panel.
 */

import { describe, expect, test } from "bun:test";
import {
  addTask,
  parseLine,
  serializeTask,
  todayStr,
  toggleTask,
  type TodoTask,
} from "./todotxt-core";

describe("parseLine", () => {
  test("parses a plain task", () => {
    expect(parseLine("Call Mom")).toEqual({
      raw: "Call Mom",
      done: false,
      priority: null,
      created: null,
      completed: null,
      text: "Call Mom",
    });
  });

  test("parses a completed task", () => {
    const t = parseLine("x Call Mom");
    expect(t.done).toBe(true);
    expect(t.text).toBe("Call Mom");
    expect(t.completed).toBeNull();
  });

  test("parses a priority", () => {
    const t = parseLine("(A) Call Mom");
    expect(t.priority).toBe("A");
    expect(t.done).toBe(false);
    expect(t.text).toBe("Call Mom");
  });

  test("parses priority + creation date", () => {
    const t = parseLine("(B) 2024-01-01 Call Mom @phone +family");
    expect(t.priority).toBe("B");
    expect(t.created).toBe("2024-01-01");
    expect(t.text).toBe("Call Mom @phone +family");
  });

  test("parses done + completion + creation dates", () => {
    const t = parseLine("x 2024-01-02 2024-01-01 Call Mom");
    expect(t.done).toBe(true);
    expect(t.completed).toBe("2024-01-02");
    expect(t.created).toBe("2024-01-01");
    expect(t.text).toBe("Call Mom");
  });

  test("two dates on an incomplete task: first is creation", () => {
    const t = parseLine("2024-01-02 2024-01-01 Call Mom");
    expect(t.done).toBe(false);
    expect(t.created).toBe("2024-01-02");
    expect(t.completed).toBeNull();
    expect(t.text).toBe("Call Mom");
  });

  test("done marker without a space is not a completion", () => {
    const t = parseLine("xylophone practice");
    expect(t.done).toBe(false);
    expect(t.text).toBe("xylophone practice");
  });

  test("lowercase priority is not a priority", () => {
    const t = parseLine("(a) call mom");
    expect(t.priority).toBeNull();
    expect(t.text).toBe("(a) call mom");
  });

  test("trims surrounding whitespace", () => {
    const t = parseLine("  (C) 2024-05-05 Ship it  ");
    expect(t.priority).toBe("C");
    expect(t.created).toBe("2024-05-05");
    expect(t.text).toBe("Ship it");
  });

  test("keeps context and project tags in the text", () => {
    const t = parseLine("x (A) 2024-01-02 2024-01-01 Ship @home +release");
    expect(t.text).toBe("Ship @home +release");
  });
});

describe("serializeTask", () => {
  test("round-trips a plain task", () => {
    const t = parseLine("Write tests");
    expect(serializeTask(t)).toBe("Write tests");
  });

  test("round-trips a fully-formed done task", () => {
    const t = parseLine("x (A) 2024-01-02 2024-01-01 Call Mom");
    expect(serializeTask(t)).toBe("x (A) 2024-01-02 2024-01-01 Call Mom");
  });

  test("drops the completion date once a task is un-done", () => {
    const t = parseLine("x 2024-01-02 2024-01-01 Call Mom");
    t.done = false;
    expect(serializeTask(t)).toBe("2024-01-01 Call Mom");
  });

  test("stamps today's date when a done task has no dates", () => {
    const t = parseLine("x Call Mom");
    t.completed = null;
    t.created = null;
    const out = serializeTask(t);
    expect(out).toBe(`x ${todayStr()} Call Mom`);
  });

  test("never emits a completion date on an incomplete task", () => {
    const t = parseLine("Call Mom");
    t.completed = "2024-01-02";
    expect(serializeTask(t)).toBe("Call Mom");
  });
});

describe("toggleTask", () => {
  test("completing sets done, completion date, and creation date", () => {
    const tasks = [parseLine("Call Mom")];
    toggleTask(tasks, 0);
    const t = tasks[0];
    expect(t.done).toBe(true);
    expect(t.completed).toBe(todayStr());
    expect(t.created).toBe(todayStr());
    expect(t.raw).toBe(`x ${todayStr()} ${todayStr()} Call Mom`);
  });

  test("un-completing clears the completion date and the x prefix", () => {
    const tasks = [parseLine("x 2024-01-02 2024-01-01 Call Mom")];
    toggleTask(tasks, 0);
    const t = tasks[0];
    expect(t.done).toBe(false);
    expect(t.completed).toBeNull();
    expect(t.created).toBe("2024-01-01");
    expect(t.raw).toBe("2024-01-01 Call Mom");
  });

  test("keeps an existing creation date when completing", () => {
    const tasks = [parseLine("2024-01-01 Call Mom")];
    toggleTask(tasks, 0);
    const t = tasks[0];
    expect(t.created).toBe("2024-01-01");
    expect(t.raw).toBe(`x ${todayStr()} 2024-01-01 Call Mom`);
  });

  test("an out-of-range index is a no-op", () => {
    const tasks = [parseLine("Call Mom")];
    expect(toggleTask(tasks, 5)).toBe(tasks);
    expect(tasks[0].done).toBe(false);
  });
});

describe("addTask", () => {
  test("appends a parsed task with a creation date", () => {
    const tasks: TodoTask[] = [];
    addTask(tasks, "Ship it @home");
    expect(tasks).toHaveLength(1);
    const t = tasks[0];
    expect(t.created).toBe(todayStr());
    expect(t.text).toBe("Ship it @home");
    expect(t.raw).toBe(`${todayStr()} Ship it @home`);
  });

  test("keeps an explicit date/priority from the input", () => {
    const tasks: TodoTask[] = [];
    addTask(tasks, "(A) 2024-01-01 Launch 🚀");
    expect(tasks[0].priority).toBe("A");
    expect(tasks[0].created).toBe("2024-01-01");
    expect(tasks[0].raw).toBe("(A) 2024-01-01 Launch 🚀");
  });

  test("ignores blank input", () => {
    const tasks: TodoTask[] = [];
    addTask(tasks, "");
    addTask(tasks, "   ");
    expect(tasks).toHaveLength(0);
  });

  test("appends at the end preserving earlier tasks", () => {
    const tasks = [parseLine("First")];
    addTask(tasks, "Second");
    expect(tasks.map((t) => t.text)).toEqual(["First", "Second"]);
  });
});
