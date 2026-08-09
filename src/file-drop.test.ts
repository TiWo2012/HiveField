/**
 * Tests for shell path quoting used by OS file drag & drop (file-drop.ts):
 * safe paths pass through untouched, everything else is single-quoted with
 * embedded quotes escaped the POSIX way.
 */

import { describe, expect, test } from "bun:test";
import { shellQuote } from "./file-drop";

describe("shellQuote", () => {
  test("safe paths pass through untouched", () => {
    for (const p of [
      "README.md",
      "/home/user/project/src/main.ts",
      "src/main.ts",
      "file.tar.gz",
      "archive.zip",
      "a+b%20c@example.com,1",
      "./relative/path",
      "../up/one",
      "under_score.dot",
      "C:/Users/me/AppData",
    ]) {
      expect(shellQuote(p), p).toBe(p);
    }
  });

  test("paths with spaces are single-quoted", () => {
    expect(shellQuote("My Documents/file.txt")).toBe("'My Documents/file.txt'");
    expect(shellQuote("/tmp/my repo")).toBe("'/tmp/my repo'");
  });

  test("embedded single quotes are escaped POSIX-style", () => {
    // ' -> '\''  (close quote, escaped quote, reopen quote)
    expect(shellQuote("it's here.txt")).toBe("'it'\\''s here.txt'");
    expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  test("option-looking paths are quoted so they never parse as flags", () => {
    expect(shellQuote("-file")).toBe("'-file'");
    expect(shellQuote("--verbose")).toBe("'--verbose'");
  });

  test("shell metacharacters force quoting", () => {
    expect(shellQuote("a; rm -rf /")).toBe("'a; rm -rf /'");
    expect(shellQuote("$(touch pwned)")).toBe("'$(touch pwned)'");
    expect(shellQuote("back`tick`")).toBe("'back`tick`'");
    expect(shellQuote("star*glob?")).toBe("'star*glob?'");
    expect(shellQuote("pipe|redir>out<in")).toBe("'pipe|redir>out<in'");
  });

  test("unicode and non-ASCII paths are quoted", () => {
    expect(shellQuote("résumé.pdf")).toBe("'résumé.pdf'");
    expect(shellQuote("文件.txt")).toBe("'文件.txt'");
  });
});
