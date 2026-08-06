/**
 * App settings store: types, defaults, persistence, and change notification.
 *
 * Settings are persisted to the Rust backend (`settings_get` / `settings_set`
 * IPC commands) which stores them in `<app_config_dir>/settings.json`, with a
 * localStorage fallback so the app still works if the backend is unavailable.
 */

import { invoke } from "@tauri-apps/api/core";
import { AGENTS, AGENT_MODES } from "./agents";
import { DEFAULT_THEME_ID, getTheme } from "./themes";

export type FontWeightValue = "normal" | "bold";
export type UnicodeVersion = "6" | "11";
export type DictationEngine = "whisper" | "vosk" | "cloud";

export interface AppSettings {
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
  /** Base directory for auto-created worktree sessions (default /tmp). */
  worktreeBaseDir: string;
  /** Show a native desktop notification when an agent session finishes. */
  desktopNotifications: boolean;
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
   */
  visibleAgents: string[];
}

export const DEFAULT_SETTINGS: AppSettings = {
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
  worktreeBaseDir: "/tmp",
  desktopNotifications: true,
  ntfyEnabled: false,
  ntfyServer: "https://ntfy.sh",
  ntfyTopic: "",
  ntfyToken: "",
  visibleAgents: AGENTS.map((a) => a.id),
};

const STORAGE_KEY = "hivefield.settings";

let current: AppSettings = { ...DEFAULT_SETTINGS };
const listeners = new Set<(settings: AppSettings) => void>();

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
  const pickAgents = (key: string, fallback: string[]): string[] => {
    // Missing key (older settings files) → fall back to "all agents". An
    // explicit array is kept as-is (even empty = hide every agent), only
    // dropping ids that are no longer in the registry.
    if (!Array.isArray(v[key])) return fallback;
    return (v[key] as unknown[]).filter(
      (x): x is string => typeof x === "string" && AGENT_MODES.includes(x)
    );
  };

  return {
    fontFamily: pickStr("fontFamily", DEFAULT_SETTINGS.fontFamily),
    fontSize: Math.max(6, Math.min(48, pickNum("fontSize", DEFAULT_SETTINGS.fontSize))),
    lineHeight: Math.max(0.5, Math.min(3, pickNum("lineHeight", DEFAULT_SETTINGS.lineHeight))),
    letterSpacing: Math.max(-2, Math.min(8, pickNum("letterSpacing", DEFAULT_SETTINGS.letterSpacing))),
    fontWeight: v.fontWeight === "bold" ? "bold" : "normal",
    fontWeightBold: v.fontWeightBold === "bold" ? "bold" : "normal",
    unicodeVersion: v.unicodeVersion === "6" ? "6" : "11",
    minimumContrastRatio: Math.max(1, Math.min(21, pickNum("minimumContrastRatio", DEFAULT_SETTINGS.minimumContrastRatio))),
    cursorBlink: pickBool("cursorBlink", DEFAULT_SETTINGS.cursorBlink),
    fontLigatures: pickBool("fontLigatures", DEFAULT_SETTINGS.fontLigatures),
    theme: getTheme(
      typeof v.theme === "string" ? (v.theme as string) : undefined
    ).id,
    backgroundOpacity: Math.max(0.25, Math.min(1, pickNum("backgroundOpacity", DEFAULT_SETTINGS.backgroundOpacity))),
    dictationEngine:
      v.dictationEngine === "vosk" || v.dictationEngine === "cloud"
        ? v.dictationEngine
        : "whisper",
    worktreeBaseDir: pickStr("worktreeBaseDir", DEFAULT_SETTINGS.worktreeBaseDir),
    desktopNotifications: pickBool(
      "desktopNotifications",
      DEFAULT_SETTINGS.desktopNotifications
    ),
    ntfyEnabled: pickBool("ntfyEnabled", DEFAULT_SETTINGS.ntfyEnabled),
    ntfyServer: pickStr("ntfyServer", DEFAULT_SETTINGS.ntfyServer),
    ntfyTopic: pickStr("ntfyTopic", DEFAULT_SETTINGS.ntfyTopic),
    ntfyToken: pickStr("ntfyToken", DEFAULT_SETTINGS.ntfyToken),
    visibleAgents: pickAgents("visibleAgents", DEFAULT_SETTINGS.visibleAgents),
  };
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
  } catch {
    // backend persistence is best-effort; localStorage still has it
  }
  return next;
}

export function resetSettings(): Promise<AppSettings> {
  return updateSettings({ ...DEFAULT_SETTINGS });
}
