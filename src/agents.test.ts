import { describe, expect, test } from "bun:test";
import {
  AGENTS,
  AGENT_MODES,
  EDITOR_CMD,
  RAW_MODE,
  agentForModeAll,
  agentUsesWorktreeAll,
  allAgents,
  isAgentModeAll,
  isKnownModeAll,
  makeCustomAgentId,
  modeCommandAll,
  modeIconAll,
  modeLabelAll,
} from "./agents";

const NO_CUSTOMS: never[] = [];

describe("built-in registry (src/agents.json)", () => {
  test("has the expected built-in agents in sidebar order", () => {
    expect(AGENTS.map((a) => a.id)).toEqual([
      "opencode",
      "pi",
      "codex",
      "copilot",
      "claude",
      "gemini",
      "aider",
      "cursor",
      "amp",
      "qwen",
      "goose",
      "crush",
      "cody",
      "openhands",
      "editor",
      "todotxt",
    ]);
  });

  test("mode ids are unique", () => {
    const ids = AGENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every agent has a label and an icon", () => {
    for (const a of AGENTS) {
      expect(a.label.trim().length).toBeGreaterThan(0);
      expect(a.icon.length).toBeGreaterThan(0);
    }
  });

  test("AGENT_MODES mirrors AGENTS in order", () => {
    expect(AGENT_MODES).toEqual(AGENTS.map((a) => a.id));
  });

  test("raw is not a registered agent", () => {
    expect(AGENT_MODES).not.toContain(RAW_MODE);
  });

  test("command overrides exist where the CLI binary differs from the id", () => {
    expect(agentForModeAll("cursor", NO_CUSTOMS)?.command).toBe("cursor-agent");
    expect(agentForModeAll("qwen", NO_CUSTOMS)?.command).toBe("qwen-code");
    // The Editor uses the $EDITOR sentinel, resolved at spawn time.
    expect(agentForModeAll("editor", NO_CUSTOMS)?.command).toBe(EDITOR_CMD);
    // Agents whose id is the command need no override.
    expect(agentForModeAll("opencode", NO_CUSTOMS)?.command).toBeUndefined();
  });

  test("editor and todotxt opt out of isolated worktrees", () => {
    for (const a of AGENTS) {
      expect(agentUsesWorktreeAll(a.id, NO_CUSTOMS)).toBe(
        a.id !== "editor" && a.id !== "todotxt"
      );
    }
  });
});

describe("custom agents merge", () => {
  const customs = [
    { id: "custom-x", label: "Custom X", command: "opencode --model gpt-5", icon: "✦" },
    { id: "custom-y", label: "Custom Y", command: "aider --sonnet", icon: "✦" },
  ];

  test("allAgents appends customs after built-ins", () => {
    expect(allAgents(customs).map((a) => a.id)).toEqual([
      ...AGENT_MODES,
      "custom-x",
      "custom-y",
    ]);
  });

  test("lookup resolves built-ins and customs", () => {
    expect(agentForModeAll("pi", customs)?.label).toBe("pi agent");
    expect(agentForModeAll("custom-x", customs)?.command).toBe("opencode --model gpt-5");
    expect(agentForModeAll("unknown", customs)).toBeUndefined();
  });

  test("isAgentModeAll / isKnownModeAll cover raw, built-ins and customs", () => {
    expect(isAgentModeAll("codex", customs)).toBe(true);
    expect(isAgentModeAll("custom-y", customs)).toBe(true);
    expect(isAgentModeAll("nope", customs)).toBe(false);
    expect(isKnownModeAll(RAW_MODE, customs)).toBe(true);
    expect(isKnownModeAll("codex", customs)).toBe(true);
    expect(isKnownModeAll("custom-y", customs)).toBe(true);
    expect(isKnownModeAll("nope", customs)).toBe(false);
  });

  test("modeCommandAll prefers the command override, falls back to the id", () => {
    expect(modeCommandAll("cursor", customs)).toBe("cursor-agent");
    expect(modeCommandAll("pi", customs)).toBe("pi");
    expect(modeCommandAll("custom-x", customs)).toBe("opencode --model gpt-5");
    expect(modeCommandAll(RAW_MODE, customs)).toBeUndefined();
  });

  test("labels and icons fall back gracefully for unknown modes", () => {
    expect(modeLabelAll("pi", customs)).toBe("pi agent");
    expect(modeLabelAll("custom-x", customs)).toBe("Custom X");
    expect(modeLabelAll(RAW_MODE, customs)).toBe("raw term");
    expect(modeLabelAll("unknown", customs)).toBe("unknown");
    expect(modeIconAll(RAW_MODE, customs)).toBe("$");
    expect(modeIconAll("unknown", customs)).toBe("✦");
  });
});

describe("custom-agent id minting", () => {
  test("slugifies labels", () => {
    expect(makeCustomAgentId("My Agent", [])).toBe("custom-my-agent");
    expect(makeCustomAgentId("Café Time", [])).toBe("custom-caf-time");
    expect(makeCustomAgentId("  ", [])).toBe("custom-agent");
  });

  test("increments suffixes on collisions", () => {
    const existing = [{ id: "custom-x", label: "X", command: "x", icon: "✦" }];
    expect(makeCustomAgentId("X", existing)).toBe("custom-x-2");
    const both = [
      ...existing,
      { id: "custom-x-2", label: "X", command: "x", icon: "✦" },
    ];
    expect(makeCustomAgentId("X", both)).toBe("custom-x-3");
  });

  test("never collides with built-in ids", () => {
    // makeCustomAgentId only dedupes against the passed list, so callers pass
    // the combined registry; verify a built-in id can never be minted.
    for (const a of AGENTS) {
      const id = makeCustomAgentId(a.id, NO_CUSTOMS);
      expect(id.startsWith("custom-")).toBe(true);
      expect(id).not.toBe(a.id);
    }
  });
});
