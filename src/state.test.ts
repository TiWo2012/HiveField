/**
 * Tests for the shared session-state helpers (state.ts): discarded-session
 * bookkeeping, the sidebar refresh hooks, the dockview api handle, and the
 * panel-id counter.
 */

import { describe, expect, test } from "bun:test";
import {
  discardSession,
  isDiscardedSession,
  isPanelActive,
  refreshSidebarRunning,
  scheduleWorkspaceRefresh,
  setApi,
  setSidebarHooks,
} from "./state";

describe("discarded sessions", () => {
  test("a discarded session id is remembered and queryable", () => {
    expect(isDiscardedSession(1)).toBe(false);
    discardSession(1);
    expect(isDiscardedSession(1)).toBe(true);
  });

  test("the set is bounded to the 200 most recent ids", () => {
    for (let i = 1; i <= 250; i++) discardSession(i);
    expect(isDiscardedSession(250)).toBe(true);
    expect(isDiscardedSession(51)).toBe(true);
    // The 50 oldest ids were evicted once the cap was exceeded.
    expect(isDiscardedSession(50)).toBe(false);
    expect(isDiscardedSession(1)).toBe(false);
  });
});

describe("sidebar refresh hooks", () => {
  test("hooks are no-ops until registered", () => {
    expect(() => {
      refreshSidebarRunning();
      scheduleWorkspaceRefresh();
    }).not.toThrow();
  });

  test("registered hooks are invoked by the refresh helpers", () => {
    let runningCalls = 0;
    let workspaceCalls = 0;
    setSidebarHooks({
      refreshRunning: () => runningCalls++,
      scheduleWorkspaceRefresh: () => workspaceCalls++,
    });
    refreshSidebarRunning();
    refreshSidebarRunning();
    scheduleWorkspaceRefresh();
    expect(runningCalls).toBe(2);
    expect(workspaceCalls).toBe(1);
  });
});

describe("dockview api handle", () => {
  test("isPanelActive compares against the api's active panel", () => {
    setApi({ activePanel: { id: "panel-7" } } as never);
    expect(isPanelActive("panel-7")).toBe(true);
    expect(isPanelActive("panel-8")).toBe(false);
  });
});
