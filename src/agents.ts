/**
 * The coding-agent CLI registry, shared by the session launcher (main.ts),
 * the settings store (which agents are visible as new-session sources) and
 * the settings UI (the "Show agents" checklist).
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
}

/** The plain-shell mode: never auto-runs an agent. */
export const RAW_MODE = "raw";

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
];

/** All agent mode ids (everything the app can auto-run as a session). */
export const AGENT_MODES: readonly string[] = AGENTS.map((a) => a.id);

/** Every session mode the app can start (all agents + the raw shell). */
export const KNOWN_MODES: readonly string[] = [...AGENT_MODES, RAW_MODE];

/** Registry lookup for an agent by mode id; undefined for raw/unknown. */
export function agentForMode(mode: string): AgentDef | undefined {
  return AGENTS.find((a) => a.id === mode);
}

/** Whether `mode` auto-runs a coding agent (and gets an isolated worktree). */
export function isAgentMode(mode: string): boolean {
  return AGENT_MODES.includes(mode);
}

/** Whether `mode` is a mode this app can start (agent id or raw). */
export function isKnownMode(mode: string): boolean {
  return KNOWN_MODES.includes(mode);
}

/** The command a mode auto-runs in the shell, or undefined for raw. */
export function modeCommand(mode: string): string | undefined {
  const agent = agentForMode(mode);
  return agent ? (agent.command ?? agent.id) : undefined;
}

/** Display label for a mode (the agent label, or "raw term"). */
export function modeLabel(mode: string): string {
  if (mode === RAW_MODE) return "raw term";
  return agentForMode(mode)?.label ?? mode;
}

/** Icon glyph for a mode. */
export function modeIcon(mode: string): string {
  if (mode === RAW_MODE) return "$";
  return agentForMode(mode)?.icon ?? "✦";
}
