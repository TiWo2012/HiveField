import { invoke } from "@tauri-apps/api/core";
import type { DockviewApi, IDockviewPanel, SerializedDockview } from "dockview";

/** Number of workspace slots (accessed with Ctrl+1 … Ctrl+0). */
export const WORKSPACE_SLOTS = 10;

/** A single workspace slot as seen by the UI (sidebar strip / palette). */
export interface WorkspaceSlot {
  slot: number;
  /** User-assigned name, when set. */
  name?: string;
  /** Whether the slot has a saved layout (or is the live current slot). */
  hasLayout: boolean;
}

/** True while a saved layout is being applied, so the save binding ignores it. */
let restoring = false;

/** Debounce window for persisting layout changes (ms). */
const SAVE_DEBOUNCE_MS = 500;

/** The launch directory (cwd) every slot of this session is scoped to. */
let cwd: string | undefined;

/**
 * Epoch ms when this launch resolved the workspace; stamped into every
 * persisted document so the recent-projects splash can sort by recency.
 */
const openedAt = Date.now();

/** Currently active slot (1-based). */
let currentSlot = 1;

/** Per-slot persisted data: optional user name + optional saved layout. */
interface SlotData {
  name?: string;
  layout?: SerializedDockview;
}

/** slot number -> data. Only slots that ever held a layout/name appear here. */
const slots = new Map<number, SlotData>();

/**
 * The live dockview instance, kept so the UI can report the *current* slot as
 * having a layout as soon as panels exist, before the debounced save lands.
 */
let apiRef: DockviewApi | undefined;

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
 * Normalize the per-cwd persisted document into { current, slots }.
 *
 * New documents look like `{ "current": 2, "slots": { "1": {"layout": …},
 * "2": {"name": "docs", "layout": …} } }`. Documents written by older
 * versions stored a bare dockview layout (`{grid, panels}`) under the cwd;
 * those are treated as a legacy slot 1. Anything else yields an empty,
 * slot-1-default workspace.
 */
function parseDoc(raw: unknown): { current: number; slots: Map<number, SlotData> } {
  const parsed = new Map<number, SlotData>();
  if (isPlausibleLayout(raw)) {
    parsed.set(1, { layout: raw });
    return { current: 1, slots: parsed };
  }
  if (raw && typeof raw === "object") {
    const v = raw as Record<string, unknown>;
    if (
      typeof v.current === "number" &&
      v.slots !== null &&
      typeof v.slots === "object"
    ) {
      const entries = v.slots as Record<string, unknown>;
      for (const key of Object.keys(entries)) {
        const slot = parseInt(key, 10);
        if (!Number.isInteger(slot) || slot < 1 || slot > WORKSPACE_SLOTS) continue;
        const entry = entries[key];
        if (!entry || typeof entry !== "object") continue;
        const e = entry as Record<string, unknown>;
        const data: SlotData = {};
        if (typeof e.name === "string") data.name = e.name;
        if (isPlausibleLayout(e.layout)) data.layout = e.layout;
        parsed.set(slot, data);
      }
      const cur = typeof v.current === "number" ? Math.floor(v.current) : 1;
      return {
        current: Math.min(Math.max(1, cur), WORKSPACE_SLOTS),
        slots: parsed,
      };
    }
  }
  return { current: 1, slots: parsed };
}

/** Persist the whole workspace document (current slot + all slot data). */
async function persist(): Promise<void> {
  if (cwd === undefined) return;
  const doc: Record<string, unknown> = {
    current: currentSlot,
    lastOpened: openedAt,
    slots: {},
  };
  const entries = doc.slots as Record<string, unknown>;
  for (const [slot, data] of slots) {
    const entry: Record<string, unknown> = {};
    if (data.name) entry.name = data.name;
    if (data.layout) entry.layout = data.layout;
    entries[String(slot)] = entry;
  }
  await invoke("workspace_set", { cwd, layout: doc }).catch(() => {});
}

/**
 * Resolve the launch directory and load the persisted workspace document into
 * module state. Safe to call repeatedly (re-reads from disk, e.g. to refresh
 * names); layout-restore and save bindings keep working off module state.
 */
export async function loadWorkspaces(): Promise<void> {
  try {
    if (cwd === undefined) {
      cwd = await invoke<string>("workspace_cwd");
    }
    const saved = await invoke<unknown>("workspace_get", { cwd });
    const parsed = parseDoc(saved);
    slots.clear();
    for (const [slot, data] of parsed.slots) slots.set(slot, data);
    currentSlot = parsed.current;
  } catch {
    // Backend unavailable: keep whatever state we have.
  }
}

/** Snapshot of every slot for the UI (sidebar strip, palette). */
export function getWorkspaceSlots(): WorkspaceSlot[] {
  const result: WorkspaceSlot[] = [];
  for (let slot = 1; slot <= WORKSPACE_SLOTS; slot++) {
    const data = slots.get(slot);
    let hasLayout = data?.layout !== undefined;
    // The live current slot counts as having a layout the moment any panel
    // exists, even before the debounced save writes it to disk.
    if (slot === currentSlot && apiRef && apiRef.panels.length > 0) hasLayout = true;
    result.push({ slot, name: data?.name, hasLayout });
  }
  return result;
}

/** The currently active workspace slot (1-based). */
export function getCurrentSlot(): number {
  return currentSlot;
}

/**
 * The canonical launch directory, once resolved (undefined before the
 * workspace is loaded). Exposed for the splash screen's "current directory"
 * card and recent-projects filtering.
 */
export function getWorkspaceCwd(): string | undefined {
  return cwd;
}

/** Short label for a slot: its user name, or a generic fallback. */
export function getSlotLabel(slot: number): string {
  return slots.get(slot)?.name ?? `workspace ${slot}`;
}

/** Set (or clear, with an empty name) a slot's user-assigned name. */
export async function renameWorkspace(slot: number, name: string): Promise<void> {
  const trimmed = name.trim();
  const data = slots.get(slot) ?? {};
  if (trimmed) data.name = trimmed;
  else delete data.name;
  slots.set(slot, data);
  await persist();
}

/** True while a switchWorkspace() call is mid-flight (rapid keys ignored). */
let switching = false;

/**
 * Switch to another workspace slot.
 *
 * The current layout is captured into the slot being left, the active slot
 * moves to `target`, and the target's saved layout is applied (closing every
 * live panel, which kills their shells — sessions respawn from the restored
 * layout, same as a launch restore). Returns true when a saved layout was
 * restored; false when the slot is empty and the caller should seed it (e.g.
 * with a fresh opencode panel). Switching to the current slot is a no-op.
 *
 * `beforeClear` runs once, immediately before the live panels are torn down,
 * so a caller can park the outgoing sessions (keep them running in the
 * background) only when a switch is actually happening. It receives the
 * outgoing panels and the slot being left.
 */
export async function switchWorkspace(
  api: DockviewApi,
  target: number,
  beforeClear?: (panels: IDockviewPanel[], leavingSlot: number) => void
): Promise<boolean> {
  apiRef = api;
  if (target < 1 || target > WORKSPACE_SLOTS) return false;
  // A switch is already in flight: ignore the keypress (it would capture the
  // wrong layout mid-teardown). The in-flight switch still completes.
  if (switching) return true;
  if (target === currentSlot) return api.panels.length > 0;
  switching = true;
  try {
    // Save the layout of the slot we're leaving (keeps its name).
    const leaving = api.toJSON();
    if (hasPanels(leaving)) {
      const data = slots.get(currentSlot) ?? {};
      data.layout = leaving;
      slots.set(currentSlot, data);
    }
    const leavingSlot = currentSlot;

    currentSlot = target;
    await persist();

    // Apply the target slot's saved layout, if any. Layout-change events
    // fired while we tear down and rebuild are ignored by the save binding.
    const targetData = slots.get(target);
    restoring = true;
    try {
      beforeClear?.(api.panels, leavingSlot);
      api.clear();
      if (targetData?.layout) {
        api.fromJSON(targetData.layout);
        return true;
      }
      return false;
    } finally {
      restoring = false;
    }
  } finally {
    switching = false;
  }
}

/**
 * Restore the saved layout for the *current* workspace slot (the one that was
 * active last session, defaulting to slot 1). Returns true when a valid saved
 * layout was applied, false otherwise (no saved layout, malformed data, or
 * the backend being unavailable). Never throws.
 */
export async function restoreWorkspace(api: DockviewApi): Promise<boolean> {
  apiRef = api;
  try {
    await loadWorkspaces();
    const data = slots.get(currentSlot);
    if (!data?.layout) return false;

    // Ignore layout-change events fired while the restore mutates the layout.
    restoring = true;
    try {
      api.fromJSON(data.layout);
    } finally {
      restoring = false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist dockview layout changes for the *current* workspace slot, debounced.
 * Best-effort: backend errors are swallowed. Skips saving while a restore is
 * in flight and skips layouts with zero panels so a wiped workspace re-defaults
 * to a fresh opencode panel next launch instead of a blank window.
 */
export function bindWorkspaceSave(api: DockviewApi): void {
  apiRef = api;
  let ready = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const persistNow = () => {
    if (restoring || !ready || cwd === undefined) return;
    const layout = api.toJSON();
    if (!hasPanels(layout)) return;
    const data = slots.get(currentSlot) ?? {};
    data.layout = layout;
    slots.set(currentSlot, data);
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      void persist();
    }, SAVE_DEBOUNCE_MS);
  };

  api.onDidLayoutChange(persistNow);

  // Persist once cwd is known. `loadWorkspaces` (run by restoreWorkspace)
  // usually resolves it first; fall back to resolving it here so saving still
  // works when only bindWorkspaceSave ran.
  if (cwd === undefined) {
    invoke<string>("workspace_cwd")
      .then((value) => {
        cwd = value;
        ready = true;
        persistNow();
      })
      .catch(() => {
        // No cwd available: persistence is best-effort, so just stay idle.
      });
  } else {
    ready = true;
    persistNow();
  }
}
