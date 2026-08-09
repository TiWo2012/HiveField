/**
 * Built-in updater client: wraps the backend `updater_check` / `updater_install`
 * IPC commands and the `updater://progress` / `updater://done` events they
 * emit. The backend checks github.com/TiWo2012/HiveField for the latest
 * release, downloads it, and installs it to the same location the repo's
 * `install.sh` (curl | sh) installer uses — see src-tauri/src/updater.rs.
 *
 * The Settings → Updates tab is the only consumer today; keep the wiring here
 * so a startup check / status badge can reuse it later.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Result of `updater_check`: latest release + where it would be installed. */
export interface UpdateInfo {
  /** Version of the running app (from the backend's Cargo version). */
  currentVersion: string;
  /** Latest release tag from GitHub, without the leading `v`. */
  latestVersion: string;
  /** ISO timestamp of the latest release, or "" when unknown. */
  publishedAt: string;
  /** Release notes (markdown body), or "" when the release has none. */
  changelog: string;
  /** URL of the release page on GitHub. */
  htmlUrl: string;
  /** Name of the release asset matching this platform. */
  assetName: string;
  /** Direct download URL of that asset. */
  assetUrl: string;
  /** Asset size in bytes. */
  assetSize: number;
  /** Where the release will be installed (mirrors install.sh). */
  installDir: string;
  /** Whether the latest release is newer than the running version. */
  updateAvailable: boolean;
}

/** Payload of `updater://progress` events. */
export interface UpdateProgress {
  /** Download percentage 0..=100. */
  percent: number;
  /** Total asset size in bytes (0 when unknown). */
  total: number;
}

/** Result of a completed `updater_install`. */
export interface UpdateDone {
  version: string;
  path: string;
}

/** Query the backend for the latest release info (no download). */
export function checkForUpdates(): Promise<UpdateInfo> {
  return invoke<UpdateInfo>("updater_check");
}

/** Download the latest release and install it to the shared install dir. */
export function installUpdate(): Promise<UpdateDone> {
  return invoke<UpdateDone>("updater_install");
}

/** Subscribe to download progress; returns an unlisten function. */
export function onUpdateProgress(
  listener: (progress: UpdateProgress) => void
): Promise<UnlistenFn> {
  return listen<UpdateProgress>("updater://progress", (event) =>
    listener(event.payload)
  );
}

/** Subscribe to install completion; returns an unlisten function. */
export function onUpdateDone(
  listener: (done: UpdateDone) => void
): Promise<UnlistenFn> {
  return listen<UpdateDone>("updater://done", (event) =>
    listener(event.payload)
  );
}
