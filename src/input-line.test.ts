/**
 * Tests for the pure helpers extracted from main.ts during the monolith
 * decomposition: input-line title tracking and OSC 133 output parsing.
 */

import { describe, expect, test } from "bun:test";
import {
  analyzeOutput,
  inputLineToTitle,
  sanitizeTitle,
  trackInputLine,
  type InputLineState,
} from "./input-line";

describe("analyzeOutput (OSC 133 shell-integration markers)", () => {
  test("passes plain text through untouched", () => {
    expect(analyzeOutput("hello world\n")).toEqual({
      markers: [],
      text: "hello world\n",
    });
  });

  test("extracts complete markers and strips them from the text", () => {
    const { markers, text } = analyzeOutput(
      "\x1b]133;A\x07ls\x1b]133;C\x07out\x1b]133;D;0\x07"
    );
    expect(markers).toEqual(["A", "C", "D"]);
    expect(text).toBe("lsout");
  });

  test("strips ST-terminated markers (ESC \\) too", () => {
    const { markers, text } = analyzeOutput("a\x1b]133;C\x1b\\b");
    expect(markers).toEqual(["C"]);
    expect(text).toBe("ab");
  });

  test("leaves a split marker in the text (buffered by xterm like any OSC)", () => {
    const { markers, text } = analyzeOutput("pre\x1b]133;D");
    expect(markers).toEqual([]);
    expect(text).toBe("pre\x1b]133;D");
  });

  test("finds markers at the start of successive chunks (lastIndex reset)", () => {
    // The regex carries a `g` flag; without resetting lastIndex, a preceding
    // chunk whose last match ended at a non-zero position would cause the
    // regex to start scanning the next chunk from that offset, silently
    // missing markers at the beginning.
    // First chunk: a marker in the middle — lastIndex ends non-zero.
    expect(analyzeOutput("abc\x1b]133;A\x07text")).toEqual({
      markers: ["A"],
      text: "abctext",
    });
    // Second chunk: a marker right at the start — must still be found.
    expect(analyzeOutput("\x1b]133;C\x07more")).toEqual({
      markers: ["C"],
      text: "more",
    });
  });

  test("finds multiple markers in successive chunks", () => {
    // Round-trip: many alternating chunks, each with a marker at position 0.
    for (let i = 0; i < 10; i++) {
      expect(analyzeOutput("\x1b]133;C\x07chunk" + i)).toEqual({
        markers: ["C"],
        text: "chunk" + i,
      });
    }
  });
});

describe("sanitizeTitle / inputLineToTitle", () => {
  test("strips control characters and collapses whitespace", () => {
    expect(sanitizeTitle("  fix\tthe\r\nbug  ")).toBe("fix the bug");
  });

  test("truncates long titles with an ellipsis", () => {
    const long = "x".repeat(100);
    const out = sanitizeTitle(long);
    expect(out.length).toBe(60);
    expect(out.endsWith("…")).toBe(true);
  });

  test("inputLineToTitle is sanitizeTitle", () => {
    expect(inputLineToTitle("  cargo  test  ")).toBe("cargo test");
  });
});

describe("trackInputLine", () => {
  const fresh = (): InputLineState => ({ line: "", escape: 0 });

  test("accumulates typed characters and submits on Enter", () => {
    let submitted: string[] = [];
    let st = trackInputLine(fresh(), "ls -la", (line) => submitted.push(line));
    expect(st.line).toBe("ls -la");
    st = trackInputLine(st, "\r", (line) => submitted.push(line));
    expect(submitted).toEqual(["ls -la"]);
    expect(st.line).toBe("");
  });

  test("handles backspace, Ctrl+U and Ctrl+W", () => {
    let st = trackInputLine(fresh(), "abc\x7f", () => {});
    expect(st.line).toBe("ab");
    st = trackInputLine(st, "\x15", () => {});
    expect(st.line).toBe("");
    st = trackInputLine(fresh(), "one two\x17", () => {});
    expect(st.line).toBe("one");
  });

  test("ignores escape sequences (arrows, OSC) when titling", () => {
    let st = trackInputLine(fresh(), "git\x1b[D", () => {});
    // ESC [ D is an arrow key: no characters land in the line.
    expect(st.line).toBe("git");
    st = trackInputLine(st, " status", () => {});
    expect(st.line).toBe("git status");
  });
});
