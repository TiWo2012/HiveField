import { describe, expect, test } from "bun:test";
import { formatDiagnostics, type Diagnostics } from "./diagnostics";

const sample: Diagnostics = {
  app: "hivefield",
  version: "0.1.1",
  os: "linux",
  arch: "x86_64",
  installDir: "/home/u/.local/bin",
  launchDir: "/home/u/projects/foo",
  gitRepo: "/home/u/projects/foo",
  gitCommit: "abc123",
  settingsSchemaVersion: 1,
  worktreeBaseDir: "/tmp",
  dictationEngine: "whisper",
  logFile: "/home/u/.local/share/dev.hivefield.terminal/logs/hivefield.log",
};

describe("formatDiagnostics", () => {
  test("renders every field as key: value lines", () => {
    const text = formatDiagnostics(sample);
    expect(text).toContain("hiveField diagnostics");
    expect(text).toContain("version: 0.1.1");
    expect(text).toContain("os: linux");
    expect(text).toContain("gitRepo: /home/u/projects/foo");
    expect(text).toContain(
      "logFile: /home/u/.local/share/dev.hivefield.terminal/logs/hivefield.log"
    );
  });

  test("renders null fields as (none)", () => {
    const blob: Diagnostics = { ...sample, gitRepo: null, gitCommit: null };
    const text = formatDiagnostics(blob);
    expect(text).toContain("gitRepo: (none)");
    expect(text).toContain("gitCommit: (none)");
  });

  test("is newline-separated with a header", () => {
    const text = formatDiagnostics(sample);
    const lines = text.split("\n");
    expect(lines[0]).toBe("hiveField diagnostics");
    expect(lines[1]).toBe("=====================");
    expect(lines).toHaveLength(2 + Object.keys(sample).length);
  });
});
