/**
 * Docs ↔ code drift guards.
 *
 * The README and FEATURE_PLAN are hand-written prose; these tests keep them
 * from silently diverging from the code they describe:
 *  - every built-in agent in `src/agents.json` must be mentioned in the
 *    README (so a new agent gets documented, and a removed one gets un-flagged
 *    deliberately);
 *  - the documented merge target must agree between AGENTS.md (the process
 *    contract) and docs/FEATURE_PLAN.md.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AGENTS } from "./agents";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const plan = readFileSync(new URL("../docs/FEATURE_PLAN.md", import.meta.url), "utf8");
const agentInstructions = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");

describe("README ↔ agent registry drift guard", () => {
  test("every built-in agent is mentioned in the README", () => {
    const lower = readme.toLowerCase();
    for (const agent of AGENTS) {
      expect(
        lower.includes(agent.id.toLowerCase()),
        `README does not mention the "${agent.id}" agent from src/agents.json`
      ).toBe(true);
    }
  });
});

describe("docs merge-target drift guard", () => {
  test("AGENTS.md and FEATURE_PLAN.md both merge into dev, never master", () => {
    for (const [name, text] of [
      ["AGENTS.md", agentInstructions],
      ["docs/FEATURE_PLAN.md", plan],
    ] as const) {
      // Whitespace-insensitive (the prose wraps across lines).
      const flat = text.replace(/\s+/g, " ").toLowerCase();
      expect(
        flat.includes("back to `dev`"),
        `${name} should state the merge target is dev`
      ).toBe(true);
      expect(
        flat.includes("back to `master`"),
        `${name} should not reference master as the merge target`
      ).toBe(false);
    }
  });
});
