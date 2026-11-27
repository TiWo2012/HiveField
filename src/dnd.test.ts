/**
 * Tests for sidebar drag payload handling (dnd.ts): serialization, the
 * custom-MIME / text-plain / bare-mode parsing fallbacks, and the in-memory
 * grace window WebKitGTK needs when it strips the transfer.
 *
 * dnd.ts pulls in sessions.ts, which transitively imports modules that attach
 * document/window listeners at load time, so the test installs a tiny DOM
 * stand-in before importing it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AGENTS, RAW_MODE } from "./agents";

type DndModule = typeof import("./dnd");

let dnd: DndModule;
let restoreWindow: (() => void) | undefined;
let restoreDocument: (() => void) | undefined;

/** Build a DataTransfer stand-in with getData()/types behaviour. */
function makeTransfer(
  data: Record<string, string>,
  options: { types?: string[]; throwOnGet?: boolean } = {},
): DataTransfer {
  return {
    types: options.types ?? Object.keys(data),
    getData(type: string) {
      if (options.throwOnGet) throw new Error("WebKitGTK refused the transfer");
      return data[type] ?? "";
    },
  } as unknown as DataTransfer;
}

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
  dnd = await import("./dnd");
});

afterAll(() => {
  dnd.resetSidebarDndState();
  restoreDocument?.();
  restoreWindow?.();
});

describe("serializeDrag / readDragPayload", () => {
  test("round-trips a mode and optional cwd", () => {
    const drag = { mode: AGENTS[0].id, cwd: "/tmp/project" };
    expect(dnd.serializeDrag(drag)).toBe(JSON.stringify(drag));
    expect(dnd.readDragPayload(makeTransfer({ [dnd.DND_MIME]: dnd.serializeDrag(drag) }))).toEqual(
      drag,
    );
  });

  test("omits an absent cwd when reading a payload", () => {
    const raw = JSON.stringify({ mode: RAW_MODE });
    expect(dnd.readDragPayload(makeTransfer({ [dnd.DND_MIME]: raw }))).toEqual({
      mode: RAW_MODE,
    });
  });

  test("falls back to text/plain when the custom MIME type was stripped", () => {
    const raw = dnd.serializeDrag({ mode: AGENTS[1].id });
    expect(dnd.readDragPayload(makeTransfer({ "text/plain": raw }))).toEqual({
      mode: AGENTS[1].id,
    });
  });

  test("accepts a legacy bare mode string", () => {
    expect(dnd.readDragPayload(makeTransfer({ "text/plain": RAW_MODE }))).toEqual({
      mode: RAW_MODE,
    });
  });

  test("rejects empty, malformed and unknown payloads", () => {
    expect(dnd.readDragPayload(undefined)).toBeUndefined();
    expect(dnd.readDragPayload(null)).toBeUndefined();
    expect(dnd.readDragPayload(makeTransfer({}))).toBeUndefined();
    expect(dnd.readDragPayload(makeTransfer({ "text/plain": "not a mode" }))).toBeUndefined();
    expect(
      dnd.readDragPayload(makeTransfer({ "text/plain": JSON.stringify({ mode: "not-a-mode" }) })),
    ).toBeUndefined();
  });

  test("treats a throwing getData() as an unreadable foreign transfer", () => {
    expect(dnd.readDragPayload(makeTransfer({}, { throwOnGet: true }))).toBeUndefined();
  });

  test("drops non-string cwd values", () => {
    const raw = JSON.stringify({ mode: RAW_MODE, cwd: 42 });
    expect(dnd.readDragPayload(makeTransfer({ "text/plain": raw }))).toEqual({
      mode: RAW_MODE,
    });
  });
});

describe("isHiveFieldDrag", () => {
  test("recognizes the custom MIME type", () => {
    expect(dnd.isHiveFieldDrag(makeTransfer({ [dnd.DND_MIME]: "anything" }))).toBe(true);
  });

  test("recognizes a valid text/plain session payload but not foreign text", () => {
    const raw = dnd.serializeDrag({ mode: RAW_MODE });
    expect(dnd.isHiveFieldDrag(makeTransfer({ "text/plain": raw }))).toBe(true);
    expect(dnd.isHiveFieldDrag(makeTransfer({ "text/plain": "external text" }))).toBe(false);
  });

  test("is false without a transfer or when the active drag flag is off", () => {
    expect(dnd.isHiveFieldDrag(undefined)).toBe(false);
    expect(dnd.isHiveFieldDrag(makeTransfer({}))).toBe(false);
  });
});

describe("resolveDragPayload", () => {
  test("prefers the live transfer over the captured drag payload", () => {
    dnd.beginSidebarDrag({ mode: RAW_MODE });
    const live = makeTransfer({ "text/plain": dnd.serializeDrag({ mode: AGENTS[0].id }) });
    expect(dnd.resolveDragPayload(live)).toEqual({ mode: AGENTS[0].id });
    dnd.resetSidebarDndState();
  });

  test("uses the captured payload when WebKitGTK strips the transfer", () => {
    dnd.beginSidebarDrag({ mode: AGENTS[2].id, cwd: "/tmp/worktree" });
    expect(dnd.resolveDragPayload(null)).toEqual({
      mode: AGENTS[2].id,
      cwd: "/tmp/worktree",
    });
    dnd.resetSidebarDndState();
  });

  test("does not reuse a stale payload after the drag is reset", () => {
    dnd.beginSidebarDrag({ mode: RAW_MODE });
    dnd.resetSidebarDndState();
    expect(dnd.resolveDragPayload(null)).toBeUndefined();
  });

  test("ignores a readable transfer that is not one of ours", () => {
    dnd.beginSidebarDrag({ mode: RAW_MODE });
    expect(dnd.resolveDragPayload(makeTransfer({ "text/plain": "foreign" }))).toBeUndefined();
    dnd.resetSidebarDndState();
  });

  test("ignores file drags even with a captured session payload", () => {
    dnd.beginSidebarDrag({ mode: RAW_MODE });
    expect(dnd.resolveDragPayload(makeTransfer({}, { types: ["Files"] }))).toBeUndefined();
    dnd.resetSidebarDndState();
  });
});
