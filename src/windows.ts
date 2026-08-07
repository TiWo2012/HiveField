/**
 * Opening a new app window via the backend, on this window's launch
 * directory (so the new window restores the same project's workspace and its
 * sessions land there).
 */

import { invoke } from "@tauri-apps/api/core";
import { getWorkspaceCwd } from "./workspace";
import type { Mode } from "./modes";

/**
 * Ask the backend to open a new window scoped to this window's launch
 * directory. `mode` optionally requests a session the new window should open
 * right away instead of showing the splash — used when an agent is dragged
 * out of this window (or dropped on the Alt new-window indicator), so the
 * dragged agent lands in the new window.
 */
export function openNewWindow(mode?: Mode): void {
  void invoke("window_new", {
    cwd: getWorkspaceCwd(),
    ...(mode ? { startMode: mode } : {}),
  }).catch((err) =>
    console.error("failed to open new window", err)
  );
}
