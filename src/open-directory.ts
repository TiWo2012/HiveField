/**
 * "Open Directory…": pick a folder with the native dialog and start a session
 * in it. Used by the File menu, the Ctrl+Shift+O keybind, and the command
 * palette.
 *
 * The directory becomes the new session's cwd (the default agent when one is
 * configured, else a plain shell) and is recorded as a recent project, the
 * same way opening a project from the splash does.
 */

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { RAW_MODE } from "./agents";
import { defaultMode } from "./modes";
import { addPanelWithMode } from "./sessions";
import { getWorkspaceCwd } from "./workspace";

/**
 * Start a session in `path` and mark it recent. Split out from the picker so
 * other callers (e.g. a dropped folder) can reuse the exact same behavior.
 */
export function openDirectoryAt(path: string): void {
  addPanelWithMode(defaultMode() ?? RAW_MODE, undefined, path);
  void invoke("project_touch", { cwd: path }).catch((err) =>
    console.error("failed to mark project recent", err),
  );
}

/**
 * Show the native folder picker and open the chosen directory. Cancelling the
 * dialog (or a picker error) is a no-op, so the shortcut never leaves the app
 * in a broken state.
 */
export async function openDirectory(): Promise<void> {
  try {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Open Directory",
      defaultPath: getWorkspaceCwd(),
    });
    if (typeof selected === "string" && selected) openDirectoryAt(selected);
  } catch (err) {
    console.error("failed to open directory picker", err);
  }
}
