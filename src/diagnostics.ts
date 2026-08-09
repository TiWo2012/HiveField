/**
 * Diagnostics for bug reports: fetches the environment context blob from the
 * backend (the `diagnostics` IPC command) and puts a formatted copy on the
 * clipboard via the "Copy diagnostics" palette action. The backend exposes
 * the same data on the CLI as `hivefield --doctor` (see
 * `src-tauri/src/diagnostics.rs`).
 */

import { invoke } from "@tauri-apps/api/core";
import { copyText } from "./clipboard";

/** The flat diagnostics blob produced by the `diagnostics` IPC command. */
export interface Diagnostics {
  app: string;
  version: string;
  os: string;
  arch: string;
  /** Where the binary lives / the updater installs to. */
  installDir: string | null;
  /** Process launch directory (what sessions default to). */
  launchDir: string | null;
  /** Git repo root containing the launch dir, when inside a repo. */
  gitRepo: string | null;
  /** HEAD commit of that repo when diagnostics ran. */
  gitCommit: string | null;
  /** Settings document schema version. */
  settingsSchemaVersion: number | null;
  /** Effective worktree base dir. */
  worktreeBaseDir: string | null;
  /** Resolved dictation engine id (`whisper` / `cloud`). */
  dictationEngine: string | null;
  /** The rotated log file the app writes to. */
  logFile: string | null;
}

/** Fetch the diagnostics blob and copy a formatted version to the clipboard. */
export async function copyDiagnostics(): Promise<void> {
  const blob = await invoke<Diagnostics>("diagnostics");
  await copyText(formatDiagnostics(blob));
}

/** Render the blob as readable `key: value` lines for pasting into a report. */
export function formatDiagnostics(blob: Diagnostics): string {
  const lines = Object.entries(blob).map(([key, value]) => {
    if (value === null) return `${key}: (none)`;
    return `${key}: ${value}`;
  });
  return ["hiveField diagnostics", "=====================", ...lines].join("\n");
}
