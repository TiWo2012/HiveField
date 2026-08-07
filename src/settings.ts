/**
 * App settings store: types, defaults, persistence, and change notification.
 *
 * Settings are persisted to the Rust backend (`settings_get` / `settings_set`
 * IPC commands) which stores them in `<app_config_dir>/settings.json`, with a
 * localStorage fallback so the app still works if the backend is unavailable.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  AGENTS,
  AGENT_MODES,
  RAW_MODE,
  type CustomAgentDef,
} from "./agents";
import { DEFAULT_THEME_ID, getTheme } from "./themes";
import {
  DEFAULT_KEYBINDS,
  KEYBIND_ACTIONS,
  parseKeybind,
  type KeybindAction,
} from "./keybinds";

export type FontWeightValue = "normal" | "bold";
export type UnicodeVersion = "6" | "11";
export type DictationEngine = "whisper" | "vosk" | "cloud";

/** A prompt snippet: a named chunk of text inserted into the active terminal. */
export interface PromptSnippet {
  name: string;
  content: string;
}

/**
 * Version of the settings document shape (persisted as `schemaVersion`).
 * Bump on any incompatible change and add a migration step on the Rust side
 * (src-tauri/src/settings.rs `migrate`). The backend refuses to overwrite a
 * document written by a newer app, so a downgrade never corrupts settings.
 */
export const SETTINGS_SCHEMA_VERSION = 1;

/** Built-in prompt snippets offered out of the box (editable in Settings). */
export const DEFAULT_PROMPT_SNIPPETS: PromptSnippet[] = [
  {
    name: "Explain this code",
    content:
      "Explain what this code does, section by section, and call out anything surprising, fragile, or hard to follow.",
  },
  {
    name: "Review my changes",
    content:
      "Review the current changes. Point out bugs, style issues, and missing edge cases, ordered by severity.",
  },
  {
    name: "Write tests",
    content:
      "Write tests for this code covering the main happy paths and the edge cases. Run them and fix any failures.",
  },
  {
    name: "Fix failing tests",
    content:
      "Run the test suite, diagnose the failures, fix the underlying bugs, and re-run until everything is green.",
  },
  {
    name: "Debug this problem",
    content:
      "I'm hitting a problem here. Diagnose the most likely cause, then fix it and verify the fix actually works.",
  },
  {
    name: "Summarize recent changes",
    content:
      "Summarize the recent git history and the current state of the working tree in a few bullet points.",
  },
];

export interface AppSettings {
  /**
   * Version of the persisted settings document (see SETTINGS_SCHEMA_VERSION).
   * Kept as the document's own version, so a newer doc loaded by an older app
   * is never silently downgraded.
   */
  schemaVersion: number;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  fontWeight: FontWeightValue;
  fontWeightBold: FontWeightValue;
  unicodeVersion: UnicodeVersion;
  minimumContrastRatio: number;
  cursorBlink: boolean;
  fontLigatures: boolean;
  /** Terminal + UI color theme id (see themes.ts). */
  theme: string;
  /** Terminal background opacity: 1 = opaque, < 1 = translucent. */
  backgroundOpacity: number;
  dictationEngine: DictationEngine;
  /**
   * Stable device id of the microphone used for dictation, as reported by the
   * `dictation_devices` IPC command. Empty string means the system default
   * input device.
   */
  dictationMic: string;
  /** Base directory for auto-created worktree sessions (default /tmp). */
  worktreeBaseDir: string;
  /** Show a native desktop notification when an agent session finishes. */
  desktopNotifications: boolean;
  /** Play an audible bell tone when a terminal receives the BEL character. */
  terminalBellSound: boolean;
  /**
   * Show a system notification when a terminal rings while its session is
   * not the one the user is looking at.
   */
  terminalBellNotify: boolean;
  /** Master switch for ntfy push notifications. */
  ntfyEnabled: boolean;
  /** ntfy server base URL (https://ntfy.sh or a self-hosted instance). */
  ntfyServer: string;
  /** ntfy topic to publish agent-done notifications to. */
  ntfyTopic: string;
  /** Optional ntfy access token (sent as Authorization: Bearer; stored unencrypted). */
  ntfyToken: string;
  /**
   * Agent mode ids offered as new-session sources (sidebar / context menu /
   * palette). Empty array hides every agent (the raw shell is always shown).
   * Covers built-in ids and custom-agent ids.
   */
  visibleAgents: string[];
  /**
   * User-defined agents (Settings → Agents → Custom agents), merged with the
   * built-in registry at runtime. Each has its own command line, so agents
   * with custom flags/args are supported (e.g. `opencode --model gpt-5`).
   */
  customAgents: CustomAgentDef[];
  /**
   * Keyboard shortcuts, keyed by action id (see keybinds.ts). An empty string
   * means the action is unbound. Missing/invalid entries fall back to the
   * action's default.
   */
  keybinds: Record<KeybindAction, string>;
  /** Prompt snippets offered via Ctrl+Shift+P → "Insert prompt…". */
  promptSnippets: PromptSnippet[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  fontFamily: "Maple Mono",
  fontSize: 14,
  lineHeight: 1,
  letterSpacing: 0,
  fontWeight: "normal",
  fontWeightBold: "bold",
  unicodeVersion: "11",
  minimumContrastRatio: 1,
  cursorBlink: true,
  fontLigatures: true,
  theme: DEFAULT_THEME_ID,
  backgroundOpacity: 1,
  dictationEngine: "whisper",
  dictationMic: "",
  worktreeBaseDir: "/tmp",
  desktopNotifications: true,
  terminalBellSound: true,
  terminalBellNotify: true,
  ntfyEnabled: false,
  ntfyServer: "https://ntfy.sh",
  ntfyTopic: "",
  ntfyToken: "",
  visibleAgents: AGENTS.map((a) => a.id),
  customAgents: [],
  keybinds: { ...DEFAULT_KEYBINDS },
  promptSnippets: DEFAULT_PROMPT_SNIPPETS,
};

/**
 * Bounds for numeric settings, shared by validation (normalize) and every
 * UI control that clamps input (settings page number fields, zoomBy).
 */
export const FONT_SIZE_MIN = 6;
export const FONT_SIZE_MAX = 48;
export const LINE_HEIGHT_MIN = 0.5;
export const LINE_HEIGHT_MAX = 3;
export const LETTER_SPACING_MIN = -2;
export const LETTER_SPACING_MAX = 8;
export const CONTRAST_RATIO_MIN = 1;
export const CONTRAST_RATIO_MAX = 21;
export const OPACITY_MIN = 0.25;
export const OPACITY_MAX = 1;

const STORAGE_KEY = "hivefield.settings";

let current: AppSettings = { ...DEFAULT_SETTINGS };
const listeners = new Set<(settings: AppSettings) => void>();

/**
 * The most recent error from the backend `settings_set` write, or undefined
 * when the last write succeeded (or none was attempted). The frontend applies
 * and localStorage-caches every change regardless, so a failing backend write
 * would silently leave the disk copy stale — this state exposes that so the
 * UI can tell the user instead of letting frontend and disk diverge.
 */
let lastPersistError: string | undefined;
const persistErrorListeners = new Set<(err: string | undefined) => void>();

export function getPersistError(): string | undefined {
  return lastPersistError;
}

/** Subscribe to backend-persistence failures (Settings UI shows a status row). */
export function subscribePersistError(
  listener: (err: string | undefined) => void
): () => void {
  persistErrorListeners.add(listener);
  listener(lastPersistError);
  return () => persistErrorListeners.delete(listener);
}

function setPersistError(err: string | undefined): void {
  if (err === lastPersistError) return;
  lastPersistError = err;
  for (const l of persistErrorListeners) l(err);
}

export function getSettings(): AppSettings {
  return current;
}

export function subscribe(listener: (settings: AppSettings) => void): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

function normalize(value: unknown): AppSettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_SETTINGS };
  const v = value as Record<string, unknown>;
  const pickStr = (key: string, fallback: string): string =>
    typeof v[key] === "string" && (v[key] as string).trim() !== ""
      ? (v[key] as string)
      : fallback;
  const pickNum = (key: string, fallback: number): number =>
    typeof v[key] === "number" && Number.isFinite(v[key] as number)
      ? (v[key] as number)
      : fallback;
  const pickBool = (key: string, fallback: boolean): boolean =>
    typeof v[key] === "boolean" ? (v[key] as boolean) : fallback;
  /**
   * Parse user-defined agents from stored settings. Invalid entries (empty
   * id/label/command, or a mode id colliding with a built-in) are dropped.
   * Used both for the `customAgents` setting itself and to know which custom
   * ids are valid when filtering `visibleAgents`.
   */
  const pickCustomAgents = (value: unknown): CustomAgentDef[] => {
    if (!Array.isArray(value)) return [];
    const out: CustomAgentDef[] = [];
    const taken = new Set<string>([...AGENT_MODES, RAW_MODE]);
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id.trim() : "";
      const label = typeof o.label === "string" ? o.label.trim() : "";
      const command = typeof o.command === "string" ? o.command.trim() : "";
      if (!id || !label || !command || taken.has(id)) continue;
      taken.add(id);
      out.push({
        id,
        label,
        command,
        icon:
          typeof o.icon === "string" && o.icon.trim() !== ""
            ? o.icon.trim()
            : "✦",
      });
    }
    return out;
  };
  const pickAgents = (
    key: string,
    fallback: string[],
    customAgents: CustomAgentDef[]
  ): string[] => {
    // Missing key (older settings files) → fall back to "all agents". An
    // explicit array is kept as-is (even empty = hide every agent), only
    // dropping ids that are no longer in the registry.
    if (!Array.isArray(v[key])) return fallback;
    const known = new Set<string>([
      ...AGENT_MODES,
      ...customAgents.map((a) => a.id),
    ]);
    return (v[key] as unknown[]).filter(
      (x): x is string => typeof x === "string" && known.has(x)
    );
  };
  const pickKeybinds = (value: unknown): Record<KeybindAction, string> => {
    const out: Record<KeybindAction, string> = { ...DEFAULT_KEYBINDS };
    if (value && typeof value === "object") {
      const src = value as Record<string, unknown>;
      for (const def of KEYBIND_ACTIONS) {
        const raw = src[def.id];
        if (typeof raw !== "string") continue;
        const trimmed = raw.trim();
        // Empty string is a valid "unbound" value; anything else must parse.
        if (trimmed === "") out[def.id] = "";
        else if (parseKeybind(trimmed)) out[def.id] = trimmed;
      }
    }
    return out;
  };

  const pickSnippets = (key: string, fallback: PromptSnippet[]): PromptSnippet[] => {
    // Missing key (older settings files) → default snippets. Explicit arrays
    // are kept as-is (even empty = no snippets offered), preserving each
    // entry's name/content verbatim (a blank name shows as "(unnamed)").
    if (!Array.isArray(v[key])) return fallback;
    const out: PromptSnippet[] = [];
    for (const item of v[key] as unknown[]) {
      if (typeof item !== "object" || item === null) continue;
      const o = item as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name : "";
      const content = typeof o.content === "string" ? o.content : "";
      out.push({ name, content });
    }
    return out;
  };

  const customAgents = pickCustomAgents(v.customAgents);
  // The "all agents" fallback for older settings files must include custom
  // agents, otherwise they would be hidden until the user re-checks them.
  const allDefaultVisible = [
    ...DEFAULT_SETTINGS.visibleAgents,
    ...customAgents.map((a) => a.id),
  ];

  // The document's own schema version: keep what the file says (a newer
  // version means an older app loaded a newer document — it must not stamp
  // the file as its own older version, or the backend's downgrade guard
  // would not fire).
  const schemaVersion =
    typeof v.schemaVersion === "number" &&
    Number.isFinite(v.schemaVersion) &&
    v.schemaVersion >= 1
      ? Math.floor(v.schemaVersion)
      : SETTINGS_SCHEMA_VERSION;

  const known: AppSettings = {
    schemaVersion,
    fontFamily: pickStr("fontFamily", DEFAULT_SETTINGS.fontFamily),
    fontSize: Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, pickNum("fontSize", DEFAULT_SETTINGS.fontSize))),
    lineHeight: Math.max(LINE_HEIGHT_MIN, Math.min(LINE_HEIGHT_MAX, pickNum("lineHeight", DEFAULT_SETTINGS.lineHeight))),
    letterSpacing: Math.max(LETTER_SPACING_MIN, Math.min(LETTER_SPACING_MAX, pickNum("letterSpacing", DEFAULT_SETTINGS.letterSpacing))),
    fontWeight: v.fontWeight === "bold" ? "bold" : "normal",
    fontWeightBold: v.fontWeightBold === "bold" ? "bold" : "normal",
    unicodeVersion: v.unicodeVersion === "6" ? "6" : "11",
    minimumContrastRatio: Math.max(CONTRAST_RATIO_MIN, Math.min(CONTRAST_RATIO_MAX, pickNum("minimumContrastRatio", DEFAULT_SETTINGS.minimumContrastRatio))),
    cursorBlink: pickBool("cursorBlink", DEFAULT_SETTINGS.cursorBlink),
    fontLigatures: pickBool("fontLigatures", DEFAULT_SETTINGS.fontLigatures),
    theme: getTheme(
      typeof v.theme === "string" ? (v.theme as string) : undefined
    ).id,
    backgroundOpacity: Math.max(OPACITY_MIN, Math.min(OPACITY_MAX, pickNum("backgroundOpacity", DEFAULT_SETTINGS.backgroundOpacity))),
    dictationEngine:
      v.dictationEngine === "vosk" || v.dictationEngine === "cloud"
        ? v.dictationEngine
        : "whisper",
    dictationMic: pickStr("dictationMic", DEFAULT_SETTINGS.dictationMic),
    worktreeBaseDir: pickStr("worktreeBaseDir", DEFAULT_SETTINGS.worktreeBaseDir),
    desktopNotifications: pickBool(
      "desktopNotifications",
      DEFAULT_SETTINGS.desktopNotifications
    ),
    terminalBellSound: pickBool(
      "terminalBellSound",
      DEFAULT_SETTINGS.terminalBellSound
    ),
    terminalBellNotify: pickBool(
      "terminalBellNotify",
      DEFAULT_SETTINGS.terminalBellNotify
    ),
    ntfyEnabled: pickBool("ntfyEnabled", DEFAULT_SETTINGS.ntfyEnabled),
    ntfyServer: pickStr("ntfyServer", DEFAULT_SETTINGS.ntfyServer),
    ntfyTopic: pickStr("ntfyTopic", DEFAULT_SETTINGS.ntfyTopic),
    ntfyToken: pickStr("ntfyToken", DEFAULT_SETTINGS.ntfyToken),
    visibleAgents: pickAgents("visibleAgents", allDefaultVisible, customAgents),
    customAgents,
    keybinds: pickKeybinds(v.keybinds),
    promptSnippets: pickSnippets("promptSnippets", DEFAULT_SETTINGS.promptSnippets),
  };
  // Preserve unknown keys from the stored document so fields written by a
  // *newer* app survive a round-trip through this version (the backend stores
  // the document verbatim; dropping unknowns would corrupt newer settings).
  return { ...v, ...known } as AppSettings;
}

function fromLocalStorage(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalize(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Load settings from the backend (falling back to localStorage), notify
 * listeners, and return the merged result. Await this once at startup.
 */
export async function loadSettings(): Promise<AppSettings> {
  let merged: AppSettings;
  try {
    const stored = (await invoke<unknown>("settings_get")) ?? {};
    merged = normalize(stored);
  } catch {
    merged = fromLocalStorage();
  }
  current = merged;
  for (const listener of listeners) listener(current);
  return current;
}

/**
 * Apply new settings: update the in-memory value, notify listeners, persist to
 * localStorage (cache) and the backend (source of truth).
 */
export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next: AppSettings = normalize({ ...current, ...patch });
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore quota/availability errors
  }
  for (const listener of listeners) listener(next);
  try {
    await invoke("settings_set", { settings: next });
    setPersistError(undefined);
  } catch (err) {
    // The in-memory and localStorage copies stay in sync, but the backend's
    // on-disk settings.json is now stale. Surface the failure instead of
    // swallowing it: a silent diverge is exactly the bug this guard exists for.
    setPersistError(String(err));
    console.error("failed to persist settings to disk", err);
  }
  return next;
}

export function resetSettings(): Promise<AppSettings> {
  return updateSettings({ ...DEFAULT_SETTINGS });
}
