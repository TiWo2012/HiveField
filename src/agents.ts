/**
 * The coding-agent CLI registry, shared by the session launcher (main.ts),
 * the settings store (which agents are visible as new-session sources) and
 * the settings UI (the "Show agents" checklist, and the custom-agent editor).
 *
 * The registry is two-tier:
 *  - `AGENTS`: the built-in coding-agent CLIs, hardcoded here.
 *  - `customAgents`: user-defined agents, stored in the `customAgents`
 *    setting. They are merged with the built-ins at runtime — every
 *    `*All` helper below takes the custom list and resolves against the
 *    combined registry, so a custom agent behaves exactly like a built-in
 *    (sidebar entry, palette/context-menu source, worktree, notifications).
 */

/** A coding-agent CLI this terminal can launch as a session. */
export interface AgentDef {
  /** Stable mode id (also the default launch command). */
  id: string;
  /** Human-readable label for the sidebar / menus / notifications. */
  label: string;
  /** Icon glyph for the sidebar, tabs, context menu and palette. */
  icon: string;
  /** The exact command to auto-run when it differs from `id`. */
  command?: string;
  /**
   * Whether a fresh session of this agent auto-creates an isolated git
   * worktree. Defaults to true; agents that edit real files (e.g. the
   * built-in Editor) opt out so their work can't vanish with a throwaway
   * checkout.
   */
  worktree?: boolean;
}

/**
 * A user-defined agent (Settings → Agents → Custom agents). The `command`
 * is a full command line — program plus arguments — e.g.
 * `"opencode --model gpt-5"` or `"aider --model sonnet"`.
 */
export interface CustomAgentDef extends AgentDef {
  /** The exact command line to auto-run (program + args). */
  command: string;
}

/** The plain-shell mode: never auto-runs an agent. */
export const RAW_MODE = "raw";

/**
 * Sentinel command for the built-in "Editor" agent: the exact command is
 * resolved at spawn time via the `editor_command` IPC command, so a
 * profile-defined `$EDITOR` (e.g. in .bashrc/.zshrc) is honored with a
 * per-platform fallback (`vi` on unix, `notepad` on Windows).
 */
export const EDITOR_CMD = "$EDITOR";

/**
 * The major coding-agent CLIs, in sidebar order. Sessions auto-run the agent
 * in an isolated worktree; add a new agent by appending to this list (and a
 * `command` when the CLI binary differs from the id). Which of these are
 * offered as new-session sources is controlled by the `visibleAgents` setting.
 */
export const AGENTS: readonly AgentDef[] = [
  { id: "opencode", label: "opencode", icon: "✦" },
  { id: "pi", label: "pi agent", icon: "π" },
  { id: "codex", label: "Codex", icon: "◈" },
  { id: "copilot", label: "Copilot", icon: "◎" },
  { id: "claude", label: "Claude Code", icon: "✳" },
  { id: "gemini", label: "Gemini CLI", icon: "✧" },
  { id: "aider", label: "Aider", icon: "⚒" },
  { id: "cursor", label: "Cursor Agent", icon: "▸", command: "cursor-agent" },
  { id: "amp", label: "Amp", icon: "⚡" },
  { id: "qwen", label: "Qwen Code", icon: "❖", command: "qwen-code" },
  { id: "goose", label: "Goose", icon: "❉" },
  { id: "crush", label: "Crush", icon: "✿" },
  { id: "cody", label: "Cody", icon: "⬡" },
  { id: "openhands", label: "OpenHands", icon: "☛" },
  // Runs $EDITOR (resolved via editor_command at spawn). No worktree: an
  // editor edits real files, and a throwaway checkout would swallow them.
  { id: "editor", label: "Editor", icon: "✎", command: EDITOR_CMD, worktree: false },
];

/** All built-in agent mode ids (everything the app can auto-run as a session). */
export const AGENT_MODES: readonly string[] = AGENTS.map((a) => a.id);

/* ---------------------------------------------------------------------------
 * Combined registry (built-ins + user custom agents). Every session the app
 * actually starts goes through these, so custom agents are first-class.
 * ------------------------------------------------------------------------- */

/** The full registry: built-ins first, then user-defined custom agents. */
export function allAgents(
  customAgents: readonly CustomAgentDef[]
): readonly AgentDef[] {
  return [...AGENTS, ...customAgents];
}

/** Registry lookup for an agent by mode id, custom agents included. */
export function agentForModeAll(
  mode: string,
  customAgents: readonly CustomAgentDef[]
): AgentDef | undefined {
  return allAgents(customAgents).find((a) => a.id === mode);
}

/** Whether `mode` auto-runs a coding agent (built-in or custom). */
export function isAgentModeAll(
  mode: string,
  customAgents: readonly CustomAgentDef[]
): boolean {
  return allAgents(customAgents).some((a) => a.id === mode);
}

/** Whether `mode` is a mode this app can start (agent id or raw). */
export function isKnownModeAll(
  mode: string,
  customAgents: readonly CustomAgentDef[]
): boolean {
  return mode === RAW_MODE || isAgentModeAll(mode, customAgents);
}

/**
 * The command a mode auto-runs in the shell, or undefined for raw.
 * Custom agents return their full command line; the built-in Editor returns
 * the `EDITOR_CMD` sentinel (resolved to the real command at spawn time).
 */
export function modeCommandAll(
  mode: string,
  customAgents: readonly CustomAgentDef[]
): string | undefined {
  const agent = agentForModeAll(mode, customAgents);
  return agent ? (agent.command ?? agent.id) : undefined;
}

/** Display label for a mode (the agent label, or "raw term"). */
export function modeLabelAll(
  mode: string,
  customAgents: readonly CustomAgentDef[]
): string {
  if (mode === RAW_MODE) return "raw term";
  return agentForModeAll(mode, customAgents)?.label ?? mode;
}

/** Icon glyph for a mode. */
export function modeIconAll(
  mode: string,
  customAgents: readonly CustomAgentDef[]
): string {
  if (mode === RAW_MODE) return "$";
  return agentForModeAll(mode, customAgents)?.icon ?? "✦";
}

/**
 * Whether a fresh session of `mode` auto-creates an isolated git worktree.
 * Agents that opt out (the Editor) run in the launch directory instead.
 */
export function agentUsesWorktreeAll(
  mode: string,
  customAgents: readonly CustomAgentDef[]
): boolean {
  return agentForModeAll(mode, customAgents)?.worktree ?? true;
}

/* ---------------------------------------------------------------------------
 * Custom-agent id minting (settings UI).
 * ------------------------------------------------------------------------- */

/**
 * Mint a stable mode id for a new custom agent from its label:
 * `custom-<slugified label>`, deduplicated against existing agents.
 */
export function makeCustomAgentId(
  label: string,
  existing: readonly CustomAgentDef[]
): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent";
  let id = `custom-${slug}`;
  const taken = new Set(existing.map((a) => a.id));
  let n = 2;
  while (taken.has(id)) id = `custom-${slug}-${n++}`;
  return id;
}
