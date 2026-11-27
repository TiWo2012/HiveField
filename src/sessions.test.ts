/**
 * Tests for the pure session helpers (sessions.ts): tab-label shortening and
 * fresh session codename generation. The lifecycle parts need dockview/xterm,
 * so only the DOM-free surface is covered here.
 *
 * sessions.ts transitively imports modules that attach global listeners on
 * load, so the test installs a minimal window/document stand-in first.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

type SessionsModule = typeof import("./sessions");

let sessions: SessionsModule;
let restoreWindow: (() => void) | undefined;
let restoreDocument: (() => void) | undefined;

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  const hadWindow = "window" in g;
  const hadDocument = "document" in g;
  const oldWindow = g.window;
  const oldDocument = g.document;
  g.window = {
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1200,
    innerHeight: 800,
  };
  g.document = {
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: { appendChild() {} },
  };
  restoreWindow = () => {
    if (hadWindow) g.window = oldWindow;
    else delete g.window;
  };
  restoreDocument = () => {
    if (hadDocument) g.document = oldDocument;
    else delete g.document;
  };
  sessions = await import("./sessions");
});

afterAll(() => {
  restoreDocument?.();
  restoreWindow?.();
});

describe("shortLabel", () => {
  test("uses the last segment of a POSIX path", () => {
    expect(sessions.shortLabel("/home/me/projects/hivefield")).toBe("hivefield");
  });

  test("ignores trailing separators and repeated slashes", () => {
    expect(sessions.shortLabel("/home/me/projects/hivefield/")).toBe("hivefield");
    expect(sessions.shortLabel("/home//me/")).toBe("me");
  });

  test("handles Windows-style paths", () => {
    expect(sessions.shortLabel("C:\\Users\\me\\project")).toBe("project");
    expect(sessions.shortLabel("C:\\Users\\me\\project\\")).toBe("project");
    expect(sessions.shortLabel("C:\\")).toBe("C:");
  });

  test("keeps the full path when there is no segment (root)", () => {
    expect(sessions.shortLabel("/")).toBe("/");
    expect(sessions.shortLabel("")).toBe("");
  });
});

describe("generateSessionName", () => {
  test("produces a lowercase adjective-noun codename", () => {
    const name = sessions.generateSessionName();
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  test("produces different names across many draws", () => {
    const names = new Set(Array.from({ length: 40 }, () => sessions.generateSessionName()));
    // The generator has only ~500 combinations, but 40 independent draws
    // landing on one value would mean it is not random at all.
    expect(names.size).toBeGreaterThan(1);
  });
});
