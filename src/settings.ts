/**
 * App settings store: types, defaults, persistence, and change notification.
 *
 * Settings are persisted to the Rust backend (`settings_get` / `settings_set`
 * IPC commands) which stores them in `<app_config_dir>/settings.json`, with a
 * localStorage fallback so the app still works if the backend is unavailable.
 */

import { invoke } from "@tauri-apps/api/core";

export type FontWeightValue = "normal" | "bold";
export type UnicodeVersion = "6" | "11";

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
}

export const DEFAULT_SETTINGS: AppSettings = {
  fontFamily: "monospace",
  fontSize: 14,
  lineHeight: 1,
  letterSpacing: 0,
  fontWeight: "normal",
  fontWeightBold: "bold",
  unicodeVersion: "11",
  minimumContrastRatio: 1,
  cursorBlink: true,
};

/** Common Nerd Font family names offered as presets in the settings page. */
export const NERD_FONT_PRESETS: string[] = [
  "JetBrainsMono Nerd Font",
  "JetBrainsMono Nerd Font Mono",
  "FiraCode Nerd Font",
  "FiraCode Nerd Font Mono",
  "CaskaydiaCove Nerd Font",
  "CaskaydiaCove Nerd Font Mono",
  "Hack Nerd Font",
  "Hack Nerd Font Mono",
  "MesloLGM Nerd Font",
  "MesloLGM Nerd Font Mono",
  "Mononoki Nerd Font",
  "Mononoki Nerd Font Mono",
  "SauceCodePro Nerd Font",
  "UbuntuMono Nerd Font",
  "Terminess Nerd Font",
];

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
