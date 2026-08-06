import { invoke } from "@tauri-apps/api/core";
import type { DockviewApi, SerializedDockview } from "dockview";

/** True while a saved layout is being applied, so the save binding ignores it. */
let restoring = false;

/** Debounce window for persisting layout changes (ms). */
const SAVE_DEBOUNCE_MS = 500;

/**
 * A plausible dockview serialization is a non-null object carrying both a
 * `grid` object and a `panels` object. Anything else is treated as absent.
 */
function isPlausibleLayout(saved: unknown): saved is SerializedDockview {
  if (!saved || typeof saved !== "object") return false;
  const v = saved as Record<string, unknown>;
  return (
    v.grid !== null &&
    typeof v.grid === "object" &&
    v.panels !== null &&
    typeof v.panels === "object"
  );
}

/** Whether a serialized layout contains at least one panel entry. */
function hasPanels(layout: unknown): boolean {
  if (!layout || typeof layout !== "object") return false;
  const panels = (layout as Record<string, unknown>).panels;
  return (
    panels !== null &&
    typeof panels === "object" &&
    Object.keys(panels as object).length > 0
  );
}

/**
 * Restore the saved dockview layout for the launch directory (cwd).
 * Returns true when a valid saved layout was applied, false otherwise
 * (no saved layout, malformed data, or the backend being unavailable).
 * Never throws.
 */
export async function restoreWorkspace(api: DockviewApi): Promise<boolean> {
  try {
    const cwd = await invoke<string>("workspace_cwd");
    const saved = await invoke<unknown>("workspace_get", { cwd });
    if (!isPlausibleLayout(saved)) return false;

    // Ignore layout-change events fired while the restore mutates the layout.
    restoring = true;
    try {
      api.fromJSON(saved);
    } finally {
      restoring = false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist dockview layout changes for the launch directory (cwd), debounced.
 * Best-effort: backend errors are swallowed. Skips saving while a restore is
 * in flight and skips layouts with zero panels so a wiped workspace re-defaults
 * to a fresh opencode panel next launch instead of a blank window.
 */
export function bindWorkspaceSave(api: DockviewApi): void {
  let cwd: string | undefined;
  let ready = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const persist = () => {
    if (restoring || !ready || cwd === undefined) return;
    const layout = api.toJSON();
    if (!hasPanels(layout)) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      invoke("workspace_set", { cwd, layout }).catch(() => {});
    }, SAVE_DEBOUNCE_MS);
  };

  api.onDidLayoutChange(persist);

  // Resolve the cwd once; nothing is persisted until it is known.
  invoke<string>("workspace_cwd")
    .then((value) => {
      cwd = value;
      ready = true;
      persist();
    })
    .catch(() => {
      // No cwd available: persistence is best-effort, so just stay idle.
    });
}
