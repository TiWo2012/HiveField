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
  isKnownModeAll,
  type CustomAgentDef,
} from "./agents";
import { getSettings, subscribe } from "./settings";

/** What a session auto-runs: a coding agent, or a plain shell (`"raw"`). */
export type Mode = string;

/**
 * Fallback session mode when none is requested and none is configured (the
 * first built-in agent). `defaultMode()` below is the *configured* default;
 * this constant only covers malformed/missing panel params and the setting's
 * own fallback.
 */
export const DEFAULT_MODE: Mode = AGENTS[0].id;

/**
 * The configured default session mode (Settings → Agents → Default agent):
 * a built-in or custom agent id, `RAW_MODE` for a plain shell, or undefined
 * when the setting is empty ("don't auto-open anything"). Every auto-open
 * path (fresh start, splash Skip/Continue with no saved layout, "New agent
 * tab", opening a recent project) resolves through this, so the app opens
 * exactly the agent the user picked.
 */
export function defaultMode(): Mode | undefined {
  const mode = getSettings().defaultMode;
  return isKnownModeAll(mode, customs()) ? mode : undefined;
}

/** The user-defined agents currently configured (shortcut for call sites). */
export function customs(): readonly CustomAgentDef[] {
  return getSettings().customAgents;
}

type SessionModeEntry = { mode: Mode; label: string; icon: string };

let _sessionModesCache: readonly SessionModeEntry[] | null = null;

// Invalidate the cache whenever settings change.
subscribe(() => {
  _sessionModesCache = null;
});

/**
 * The session modes currently offered as new-session sources (sidebar, context
 * menu, palette): the agents enabled in the `visibleAgents` setting (all of
 * them by default, built-in and custom), plus the raw shell which is always
 * offered.
 *
 * The result is cached between settings changes so repeated calls (palette,
 * menus, sidebar, etc.) are free.
 */
export function sessionModes(): ReadonlyArray<SessionModeEntry> {
  if (_sessionModesCache) return _sessionModesCache;
  const visible = new Set(getSettings().visibleAgents);
  const agents = allAgents(customs())
    .filter((a) => visible.has(a.id))
    .map((a) => ({
      mode: a.id,
      label: a.label,
      icon: a.icon,
    }));
  _sessionModesCache = [...agents, { mode: RAW_MODE, label: "raw term", icon: "$" }];
  return _sessionModesCache;
}
