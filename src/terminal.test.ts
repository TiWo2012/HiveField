/**
 * Tests for the terminal helpers that do not require a real xterm instance:
 * color conversion, viewport/follow bookkeeping, and the write behaviour that
 * keeps output pinned to the bottom.
 */

import { describe, expect, test } from "bun:test";
import type { Terminal } from "@xterm/xterm";
import { hexToRgba, isAtBottom, isFollowing, setFollowing, writeToTerminal } from "./terminal";

interface TerminalStub {
  terminal: Terminal;
  scrolls: number;
}

/** A minimal xterm stand-in exposing only the surface the helpers touch. */
function stubTerminal(viewportY: number, baseY: number): TerminalStub {
  const state = { viewportY, baseY, scrolls: 0 };
  const terminal = {
    buffer: { active: state },
    write(_data: string, callback?: () => void) {
      callback?.();
    },
    scrollToBottom() {
      state.scrolls++;
    },
  } as unknown as Terminal;
  return {
    terminal,
    get scrolls() {
      return state.scrolls;
    },
  };
}

describe("hexToRgba", () => {
  test("converts 6-digit hex with and without a leading #", () => {
    expect(hexToRgba("#1e1e2e", 0.5)).toBe("rgba(30, 30, 46, 0.5)");
    expect(hexToRgba("ff8800", 1)).toBe("rgba(255, 136, 0, 1)");
  });

  test("trims surrounding whitespace and ignores case", () => {
    expect(hexToRgba("  #AABBCC  ", 0.25)).toBe("rgba(170, 187, 204, 0.25)");
  });

  test("returns the input unchanged when it is not a hex color", () => {
    expect(hexToRgba("var(--accent)", 0.5)).toBe("var(--accent)");
    expect(hexToRgba("#abc", 0.5)).toBe("#abc");
    expect(hexToRgba("", 0.5)).toBe("");
  });

  test("handles the alpha bounds", () => {
    expect(hexToRgba("#000000", 0)).toBe("rgba(0, 0, 0, 0)");
    expect(hexToRgba("#ffffff", 1)).toBe("rgba(255, 255, 255, 1)");
  });
});

describe("isAtBottom", () => {
  test("is true when the viewport top coincides with the bottom page", () => {
    expect(isAtBottom(stubTerminal(10, 10).terminal)).toBe(true);
  });

  test("is true when the viewport is past the bottom (defensive)", () => {
    expect(isAtBottom(stubTerminal(12, 10).terminal)).toBe(true);
  });

  test("is false while there is scrollback below the viewport", () => {
    expect(isAtBottom(stubTerminal(3, 10).terminal)).toBe(false);
  });
});

describe("follow state", () => {
  test("terminals follow output by default", () => {
    expect(isFollowing(stubTerminal(0, 0).terminal)).toBe(true);
  });

  test("follow state is tracked per terminal", () => {
    const a = stubTerminal(0, 0).terminal;
    const b = stubTerminal(0, 0).terminal;
    setFollowing(a, false);
    expect(isFollowing(a)).toBe(false);
    expect(isFollowing(b)).toBe(true);
    setFollowing(a, true);
    expect(isFollowing(a)).toBe(true);
  });
});

describe("writeToTerminal", () => {
  test("scrolls to the bottom when the user is following output", () => {
    const stub = stubTerminal(2, 10);
    setFollowing(stub.terminal, true);
    writeToTerminal(stub.terminal, "output");
    expect(stub.scrolls).toBe(1);
  });

  test("scrolls when the viewport is already at the bottom, even if follow is off", () => {
    const stub = stubTerminal(10, 10);
    setFollowing(stub.terminal, false);
    writeToTerminal(stub.terminal, "output");
    expect(stub.scrolls).toBe(1);
  });

  test("leaves a user reading scrollback alone when follow is off", () => {
    const stub = stubTerminal(2, 10);
    setFollowing(stub.terminal, false);
    writeToTerminal(stub.terminal, "output");
    expect(stub.scrolls).toBe(0);
  });

  test("re-checks follow state inside the async write callback", () => {
    const stub = stubTerminal(2, 10);
    setFollowing(stub.terminal, true);
    // Simulate xterm flipping the state between write() and its drain: the
    // callback must see the latest value.
    const write = stub.terminal.write.bind(stub.terminal);
    (stub.terminal as unknown as { write: typeof write }).write = (data, callback) => {
      setFollowing(stub.terminal, false);
      write(data, callback);
    };
    writeToTerminal(stub.terminal, "output");
    expect(stub.scrolls).toBe(0);
  });
});
