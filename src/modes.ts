/**
 * Session-mode catalog: what the app can launch as a session (coding agents +
 * the raw shell), derived from the agent registry and the user's settings.
 *
 * `DEFAULT_MODE` and `customs()`/`sessionModes()` used to live in main.ts;
 * they are read by the session launcher, the sidebar, the context menus, the
 * palette and the splash, so they get a home of their own here (agents.ts
 * stays a pure registry — importing settings from it would create a cycle).
 */

import {
  AGENTS,
  RAW_MODE,
  allAgents,
  type CustomAgentDef,
} from "./agents";
import { getSettings } from "./settings";

/** What a session auto-runs: a coding agent, or a plain shell (`"raw"`). */
export type Mode = string;

/** Default session mode when none is requested (the first agent). */
export const DEFAULT_MODE: Mode = AGENTS[0].id;

/** The user-defined agents currently configured (shortcut for call sites). */
export function customs(): readonly CustomAgentDef[] {
  return getSettings().customAgents;
}

/**
 * The session modes currently offered as new-session sources (sidebar, context
 * menu, palette): the agents enabled in the `visibleAgents` setting (all of
 * them by default, built-in and custom), plus the raw shell which is always
 * offered.
 */
export function sessionModes(): ReadonlyArray<{ mode: Mode; label: string; icon: string }> {
  const visible = new Set(getSettings().visibleAgents);
  const agents = allAgents(customs())
    .filter((a) => visible.has(a.id))
    .map((a) => ({
      mode: a.id,
      label: a.label,
      icon: a.icon,
    }));
  return [...agents, { mode: RAW_MODE, label: "raw term", icon: "$" }];
}
