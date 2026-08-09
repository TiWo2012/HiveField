/**
 * Tests for broadcast mode (broadcast.ts): the toggle state machine, listener
 * notification (including the immediate-callback and unsubscribe contract),
 * and the fan-out rules — sender excluded, parked (background-workspace)
 * sessions never touched.
 *
 * The fan-out selection is tested through the pure `broadcastTargets` helper;
 * `broadcastToAll` itself is smoke-tested for not throwing (its IPC writes
 * reject in the test environment and are swallowed by design).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  broadcastTargets,
  broadcastToAll,
  isBroadcasting,
  onBroadcastChange,
  toggleBroadcast,
} from "./broadcast";
import { panelToSession, parkedSessions, setApi } from "./state";

/** A dockview api stub with three visible panels. */
function setThreePanels(): void {
  setApi({ panels: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] } as never);
  panelToSession.set("p1", 1);
  panelToSession.set("p2", 2);
  panelToSession.set("p3", 3);
}

beforeEach(() => {
  panelToSession.clear();
  parkedSessions.clear();
  setThreePanels();
  // Each test starts with broadcast off and no leftover panels parked.
  while (isBroadcasting()) toggleBroadcast();
});

describe("broadcast toggle state", () => {
  test("broadcast starts off", () => {
    expect(isBroadcasting()).toBe(false);
  });

  test("toggleBroadcast flips the state and returns it", () => {
    expect(toggleBroadcast()).toBe(true);
    expect(isBroadcasting()).toBe(true);
    expect(toggleBroadcast()).toBe(false);
    expect(isBroadcasting()).toBe(false);
  });
});

describe("broadcast listeners", () => {
  test("onBroadcastChange fires immediately with the current state", () => {
    toggleBroadcast(); // ensure on
    const seen: boolean[] = [];
    const unsub = onBroadcastChange((on) => seen.push(on));
    unsub();
    expect(seen).toEqual([true]);
  });

  test("listeners are notified on every toggle", () => {
    const seen: boolean[] = [];
    const unsub = onBroadcastChange((on) => seen.push(on));
    toggleBroadcast();
    toggleBroadcast();
    unsub();
    expect(seen).toEqual([false, true, false]);
  });

  test("unsubscribing stops notifications", () => {
    let calls = 0;
    const unsub = onBroadcastChange(() => calls++);
    unsub();
    toggleBroadcast();
    toggleBroadcast();
    expect(calls).toBe(1); // only the initial immediate callback
  });
});

describe("broadcastTargets", () => {
  test("is empty when broadcast is off", () => {
    expect(broadcastTargets(1)).toEqual([]);
  });

  test("excludes the sender and parked sessions", () => {
    parkedSessions.set(2, { slot: 9, element: {} as HTMLElement });
    toggleBroadcast();
    expect(broadcastTargets(1)).toEqual([3]);
    expect(broadcastTargets(-1)).toEqual([1, 3]);
  });

  test("skips panels without a session mapping", () => {
    panelToSession.delete("p2");
    toggleBroadcast();
    expect(broadcastTargets(1)).toEqual([3]);
  });

  test("no targets when every other pane is parked", () => {
    parkedSessions.set(2, { slot: 9, element: {} as HTMLElement });
    parkedSessions.set(3, { slot: 9, element: {} as HTMLElement });
    toggleBroadcast();
    expect(broadcastTargets(1)).toEqual([]);
  });
});

describe("broadcastToAll", () => {
  test("does not throw when the IPC write is unavailable", () => {
    toggleBroadcast();
    // The real @tauri-apps invoke rejects in the test environment; the
    // .catch() must swallow it.
    expect(() => broadcastToAll(1, "data")).not.toThrow();
  });
});
