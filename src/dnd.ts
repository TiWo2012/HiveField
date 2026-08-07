/**
 * Sidebar session drag & drop: the drag payload serialization, the custom
 * drag ghost, the new-window drop indicator, and the WebKitGTK resilience
 * layer (stripped MIME types, swallowed `drop`s, late `dragend`s).
 *
 * The in-flight drag state lives here (not in main.ts) so the sidebar's
 * drag-source handlers and the document-level fallback agree on what is being
 * dragged.
 */

import { isKnownModeAll } from "./agents";
import { customs, type Mode } from "./modes";
import { openSessionAtPoint } from "./sessions";
import { openNewWindow } from "./windows";
import { getApi } from "./state";

/** A session start request carried across a drag or passed to a panel. */
export interface SessionDrag {
  mode: Mode;
  /** Directory the shell should start in (e.g. a worktree path). */
  cwd?: string;
}

/** Custom MIME type used to drag sidebar entries into the dockview layout. */
export const DND_MIME = "application/x-hivefield-session";

/** Serialize a session drag payload (JSON, so it carries the optional cwd). */
export function serializeDrag(drag: SessionDrag): string {
  return JSON.stringify(drag);
}

/**
 * Read the requested session (mode + optional cwd) from a drag payload.
 * Tolerates platforms (WebKitGTK / Tauri on Linux) that only preserve the
 * `text/plain` target across a drag instead of our custom MIME type, and
 * falls back to a bare mode string for compatibility.
 */
export function readDragPayload(dt: DataTransfer | null | undefined): SessionDrag | undefined {
  if (!dt) return undefined;
  let raw: string;
  try {
    raw = dt.getData(DND_MIME) || dt.getData("text/plain");
  } catch {
    // Some WebKitGTK builds throw on getData() for foreign MIME types;
    // the in-memory drag payload covers those cases.
    return undefined;
  }
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { mode?: unknown; cwd?: unknown };
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.mode === "string" &&
      isKnownModeAll(parsed.mode, customs())
    ) {
      return {
        mode: parsed.mode as Mode,
        cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
      };
    }
  } catch {
    // Not JSON — fall through to the bare-mode legacy payload.
  }
  return isKnownModeAll(raw, customs())
    ? { mode: raw as Mode }
    : undefined;
}

/** Safely read the MIME types a drag exposes (WebKitGTK can hide/null them). */
function dataTransferTypes(dt: DataTransfer | null | undefined): string[] {
  if (!dt || !dt.types) return [];
  try {
    return Array.from(dt.types);
  } catch {
    return [];
  }
}

/**
 * True while one of our sidebar sessions is being dragged over a drop
 * target. The module-level flag is authoritative (payloads are unreadable
 * during `dragover` on WebKitGTK); the dataTransfer checks are a fallback for
 * platforms that do expose the payload. dockview's own tab drags set
 * `text/plain` to `""`, so this never collides with its internal DnD.
 */
export function isHiveFieldDrag(dt: DataTransfer | null | undefined): boolean {
  if (sidebarDragActive) return true;
  if (!dt) return false;
  const types = dataTransferTypes(dt);
  if (types.includes(DND_MIME)) return true;
  return types.includes("text/plain") && readDragPayload(dt) !== undefined;
}

/**
 * Resolve the session a drop carries: prefer the live dataTransfer payload
 * (reliable in `drop` events), falling back to the payload captured at
 * `dragstart` — but only while a sidebar drag is actually in flight, so a
 * stale payload is never applied to an unrelated drop.
 */
export function resolveDragPayload(dt: DataTransfer | null | undefined): SessionDrag | undefined {
  const live = readDragPayload(dt);
  if (live) return live;

  // Fall back to the payload captured at `dragstart`: WebKitGTK strips the
  // transfer entirely (getData returns "" and `types` is empty), and it can
  // also deliver the `drop` *after* `dragend`. The in-memory copy stays
  // resolvable for a short grace window, refreshed while the drag hovers.
  if (Date.now() > pendingSessionExpiresAt) return undefined;
  if (!dt) return pendingSessionDrag;
  try {
    if (dt.getData(DND_MIME) || dt.getData("text/plain")) {
      // The transfer is readable but didn't parse as a session — a foreign
      // drag (external text, a file), not one of ours.
      return undefined;
    }
  } catch {
    // getData threw: treat like a stripped WebKitGTK transfer.
  }
  if (dataTransferTypes(dt).includes("Files")) return undefined;
  return pendingSessionDrag;
}

/** Small floating label used as the custom drag image for sidebar entries. */
export function buildDragGhost(source: { icon: string; label: string }): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  const icon = document.createElement("span");
  icon.className = "drag-ghost-icon";
  icon.textContent = source.icon;
  ghost.appendChild(icon);
  ghost.appendChild(document.createTextNode(source.label));
  return ghost;
}

/**
 * True while one of our sidebar sessions is being dragged. WebKitGTK does not
 * expose drag payloads through `dataTransfer.getData()` during `dragover`
 * (only `drop` can read them), so dockview's acceptance gate cannot rely on
 * the payload being readable. Set on `dragstart`, cleared on `dragend`.
 */
export let sidebarDragActive = false;

/**
 * The payload of the in-flight sidebar drag, kept in memory so the drop
 * handlers still resolve a session even when the webview strips our custom
 * MIME types (and `text/plain`) from the transfer.
 */
let pendingSessionDrag: SessionDrag | undefined;

/**
 * The payload above stays resolvable until this timestamp. WebKitGTK can
 * deliver the final `drop` after `dragend` (or never deliver it at all), so
 * the in-memory payload lives a short grace window past the drag instead of
 * dying at `dragend`. Refreshed on every `dragover` so long drags never
 * expire mid-flight.
 */
let pendingSessionExpiresAt = 0;
export const DRAG_GRACE_MS = 1000;

/** True once a `drop` for this drag was delivered anywhere in the app. */
export let dragSawDrop = false;

/** True once a session was actually opened for this drag. */
export let dragOpenedSession = false;

/**
 * True while a sidebar drag's pointer is outside this window (dragged out of
 * the webview). Set when a `dragleave` leaves the document or a `dragover`
 * reports coordinates outside the window bounds, cleared when the pointer
 * comes back in. On `dragend` a drag that ended outside opens a new window
 * with the dragged session instead of splitting the current layout.
 */
let sidebarDragOutside = false;

/** Whether the new-window drop indicator is currently visible. */
let newWindowIndicatorVisible = false;

/** The new-window drop indicator element (created lazily, see below). */
let newWindowDropEl: HTMLElement | null = null;

/**
 * Most recent pointer position (client coords) while the sidebar drag hovered
 * inside the terminal workspace; undefined when it never entered it (or left
 * again). WebKitGTK occasionally swallows the final `drop` entirely after
 * showing the drop overlay, so this is the position used to open the session
 * from the sidebar's `dragend` instead.
 */
export let lastSidebarDragOver: { clientX: number; clientY: number } | undefined;

/**
 * Show or hide the "drop to open in a new window" indicator. It is a
 * full-window drop surface that appears only while a sidebar drag hovers with
 * Alt held (see `setupSidebarDndFallback`), so it never clutters normal
 * dragging. Its background is deliberately opaque — the OS window can be
 * transparent, and a translucent fill would let the desktop bleed through.
 * Dropping on it opens the dragged session in a brand-new window.
 */
export function setNewWindowIndicator(visible: boolean): void {
  if (visible === newWindowIndicatorVisible) return;
  newWindowIndicatorVisible = visible;
  if (!visible) {
    newWindowDropEl?.remove();
    newWindowDropEl = null;
    return;
  }
  if (!newWindowDropEl) {
    const el = document.createElement("div");
    el.className = "new-window-drop";
    const icon = document.createElement("span");
    icon.className = "new-window-drop-icon";
    icon.textContent = "⤢";
    const label = document.createElement("span");
    label.className = "new-window-drop-label";
    label.textContent = "Drop to open in a new window";
    const inner = document.createElement("div");
    inner.className = "new-window-drop-inner";
    inner.appendChild(icon);
    inner.appendChild(label);
    el.appendChild(inner);

    // Accept the drag so WebKitGTK reliably delivers the `drop`, and keep the
    // in-memory payload fresh for arbitrarily long hovers.
    el.addEventListener("dragover", (e) => {
      if (!isHiveFieldDrag(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      pendingSessionExpiresAt = Date.now() + DRAG_GRACE_MS;
    });
    // Dropping on the indicator opens the session in a new window instead of
    // the current one. `dragSawDrop`/`dragOpenedSession` stop the dragend and
    // document-level fallbacks from also opening a split.
    el.addEventListener("drop", (e) => {
      const drag = resolveDragPayload(e.dataTransfer);
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      dragSawDrop = true;
      dragOpenedSession = true;
      setNewWindowIndicator(false);
      openNewWindow(drag.mode);
    });
    // Hide once the pointer truly leaves the overlay (i.e. the window); a
    // transition onto a child element keeps it up.
    el.addEventListener("dragleave", (e) => {
      const related = e.relatedTarget as Node | null;
      if (!related || !el.contains(related)) setNewWindowIndicator(false);
    });
    document.body.appendChild(el);
    newWindowDropEl = el;
  }
}

/**
 * Remove any drop-target overlay dockview left behind. WebKitGTK can swallow
 * the `drop`/`dragleave` that would normally clear it, leaving a grey
 * highlight stuck on the workspace after the mouse is released.
 */
export function clearStuckDropOverlay(): void {
  for (const dropzone of document.querySelectorAll<HTMLElement>(
    ".dv-drop-target-dropzone"
  )) {
    dropzone.parentElement?.classList.remove("dv-drop-target");
    dropzone.remove();
  }
}

/**
 * End the in-flight sidebar drag: drop the flag that makes isHiveFieldDrag()
 * accept every drag and drop the stored payload. Every release path (the
 * mouseup net, the drop handler) must call this — if a swallowed `dragend`
 * leaves sidebarDragActive set, isHiveFieldDrag() returns true for every
 * subsequent drag and resolveDragPayload() falls through to the stale
 * pendingSessionDrag for unrelated foreign drops. It also hides the
 * per-drag UI (the drop overlay, the new-window indicator). Note: the
 * sidebar `dragend` handler intentionally does NOT call this — it keeps the
 * payload alive for the grace window so a late WebKitGTK `drop` still
 * resolves.
 */
export function resetSidebarDndState(): void {
  sidebarDragActive = false;
  pendingSessionDrag = undefined;
  pendingSessionExpiresAt = 0;
  lastSidebarDragOver = undefined;
  sidebarDragOutside = false;
  setNewWindowIndicator(false);
  clearStuckDropOverlay();
}

/**
 * WebKitGTK workaround: dockview's own drop targets sometimes lose the final
 * `drop` (the preview overlay still shows while hovering — only the release
 * is dropped on the floor) or deliver it late. This layer makes the sidebar
 * drag resilient:
 *
 * - `dragover` records the last hovered workspace position and preventDefaults
 *   so WebKitGTK reliably fires the `drop`, and keeps the in-memory payload
 *   fresh for long drags;
 * - a capture-phase `drop` opens the session itself when dockview did not
 *   already (its overlay state can be missing at the release point);
 * - `dragend` on the sidebar recovers a swallowed `drop` by opening the
 *   session at the last hovered position;
 * - a `mouseup` net covers the worst case where even `dragend` never fires.
 */
export function setupSidebarDndFallback() {
  const terminalEl = document.getElementById("terminal")!;
  const inTerminal = (clientX: number, clientY: number) => {
    const r = terminalEl.getBoundingClientRect();
    return (
      clientX >= r.left && clientX <= r.right &&
      clientY >= r.top && clientY <= r.bottom
    );
  };

  // Track where a sidebar drag hovers so a swallowed `drop` can still open
  // the session from `dragend`. Cleared when the pointer leaves the workspace
  // so a release over the sidebar stays a cancel.
  document.addEventListener(
    "dragover",
    (e) => {
      if (!isHiveFieldDrag(e.dataTransfer)) return;
      // Keep the in-memory payload fresh for arbitrarily long drags.
      pendingSessionExpiresAt = Date.now() + DRAG_GRACE_MS;
      // Outside the window bounds means the drag left the window (the
      // gesture that opens the dragged session in a new window).
      sidebarDragOutside =
        e.clientX < 0 ||
        e.clientY < 0 ||
        e.clientX > window.innerWidth ||
        e.clientY > window.innerHeight;
      // The new-window drop indicator follows the Alt modifier on every hover
      // (keyboard events may not reach the page mid-drag on WebKitGTK).
      setNewWindowIndicator(e.altKey);
      if (inTerminal(e.clientX, e.clientY)) {
        // preventDefault so WebKitGTK reliably delivers the final `drop`.
        e.preventDefault();
        lastSidebarDragOver = { clientX: e.clientX, clientY: e.clientY };
      } else {
        lastSidebarDragOver = undefined;
      }
    },
    true
  );

  // A `dragleave` with no related target means the pointer left the document
  // (the window). This is the reliable "drag out of the window" signal —
  // WebKitGTK stops delivering `dragover` events once the pointer is outside.
  document.addEventListener(
    "dragleave",
    (e) => {
      if (!sidebarDragActive) return;
      if (e.relatedTarget === null) sidebarDragOutside = true;
    },
    true
  );

  // Worst-case recovery: if a sidebar drag produced neither a `drop` nor a
  // `dragend` (WebKitGTK can lose the drag state machine after showing the
  // overlay), the first `mouseup` is the release — open the session at the
  // last hovered position.
  document.addEventListener(
    "mouseup",
    () => {
      // Not our drag (or it already ended): nothing to clean up — and a late
      // WebKitGTK `drop` may still be on its way, so leave the grace window
      // intact.
      if (!sidebarDragActive) return;
      if (
        dragOpenedSession ||
        // A drag that left the window belongs to the new-window gesture;
        // never fall back to splitting the pane it hovered before leaving.
        sidebarDragOutside ||
        !lastSidebarDragOver ||
        !pendingSessionDrag
      ) {
        // Nothing left to release: a session already opened through the drop
        // path, a drag that left the window, or a drag that ended without
        // ever hovering the terminal whose `dragend` was swallowed. Either
        // way this mouseup ends the drag — clear the in-flight state so a
        // stuck sidebarDragActive can't make isHiveFieldDrag() accept every
        // subsequent drag and let the stale payload leak into an unrelated
        // foreign drop.
        resetSidebarDndState();
        return;
      }
      const { clientX, clientY } = lastSidebarDragOver;
      if (openSessionAtPoint(clientX, clientY, pendingSessionDrag)) {
        dragOpenedSession = true;
      }
      resetSidebarDndState();
    },
    true
  );

  // Capture phase: this runs before dockview's own handlers and only acts if
  // they ended up not opening a session.
  document.addEventListener(
    "drop",
    (e) => {
      const drag = resolveDragPayload(e.dataTransfer);
      if (!drag) {
        // A drop that resolves to nothing (a foreign drag, or an expired
        // payload) still ends any stale in-flight sidebar drag — otherwise
        // the stuck flags would keep accepting every subsequent drop and
        // overlay. Clear them so the next drag starts clean.
        resetSidebarDndState();
        return;
      }
      dragSawDrop = true;
      e.preventDefault(); // don't let the webview insert/paste the payload
      const before = getApi().panels.length;
      setTimeout(() => {
        // A drop that opened a session in a *new* window (the Alt indicator
        // or a drag-out) sets dragOpenedSession synchronously; dockview opens
        // in-window drops synchronously (panels grew). Either way the drag is
        // over — drop the in-flight state so a swallowed `dragend` can't
        // leave it set.
        if (dragOpenedSession || getApi().panels.length > before) {
          resetSidebarDndState();
          return;
        }
        if (openSessionAtPoint(e.clientX, e.clientY, drag)) {
          dragOpenedSession = true;
        }
        resetSidebarDndState();
      }, 0);
    },
    true
  );

  // The Alt modifier drives the new-window drop indicator. During an HTML5
  // drag WebKitGTK may stop delivering key events to the page, so `dragover`
  // also refreshes it from `altKey`; these handlers cover the case where Alt
  // is pressed before the drag starts (the keydown fires before dragstart).
  // Losing focus (dragging out onto another app) hides it defensively.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Alt" && sidebarDragActive) setNewWindowIndicator(true);
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Alt" && sidebarDragActive) setNewWindowIndicator(false);
  });
  window.addEventListener("blur", () => setNewWindowIndicator(false));
}

/**
 * The sidebar's drag-start handler records the in-flight drag state.
 * `sidebarDragActive`/`pendingSessionDrag` are exported as writable bindings
 * so the sidebar can set them; this helper keeps the assignments in one place.
 */
export function beginSidebarDrag(drag: SessionDrag): void {
  sidebarDragActive = true;
  pendingSessionDrag = drag;
  pendingSessionExpiresAt = Date.now() + DRAG_GRACE_MS;
  dragSawDrop = false;
  dragOpenedSession = false;
  lastSidebarDragOver = undefined;
  sidebarDragOutside = false;
  setNewWindowIndicator(false);
}

/**
 * Called by the dockview drop integration (main.ts) when a drop actually
 * opened a session, so the dragend/mouseup fallbacks don't double-open.
 */
export function markDragOpenedSession(): void {
  dragOpenedSession = true;
}

/**
 * The sidebar's `dragend` handler. Fires whether the drag was dropped or
 * cancelled. WebKitGTK sometimes swallows the final `drop` (the overlay was
 * shown, the release did nothing): if no drop was delivered and no session
 * opened, release the session at the last hovered workspace position
 * instead. The in-memory payload stays resolvable for a grace window so a
 * `drop` that arrives after `dragend` still opens its session.
 */
export function endSidebarDrag(e: DragEvent): void {
  sidebarDragActive = false;
  setNewWindowIndicator(false);
  if (!dragOpenedSession && !dragSawDrop && pendingSessionDrag) {
    // Decide where the drag actually ended. WebKitGTK's dragend
    // coordinates are not always trustworthy (a drop outside the window
    // can report stale in-window coordinates, especially on Wayland), and
    // its `dragleave` can fire spuriously with a null relatedTarget. So:
    // coordinates clearly outside the window, or ambiguous coordinates
    // combined with the dragleave flag, mean the session was dragged out
    // and belongs in a brand-new window; clearly-inside coordinates win
    // over a spurious dragleave flag.
    const MARGIN = 8;
    const clearlyInside =
      e.clientX >= MARGIN &&
      e.clientY >= MARGIN &&
      e.clientX <= window.innerWidth - MARGIN &&
      e.clientY <= window.innerHeight - MARGIN;
    const clearlyOutside =
      e.clientX < 0 ||
      e.clientY < 0 ||
      e.clientX > window.innerWidth ||
      e.clientY > window.innerHeight;
    const endedOutside = clearlyOutside || (sidebarDragOutside && !clearlyInside);
    if (endedOutside) {
      openNewWindow(pendingSessionDrag.mode);
      dragOpenedSession = true;
    } else if (lastSidebarDragOver) {
      // In-window release (WebKitGTK swallowed the `drop`): open the
      // session at the last hovered workspace position.
      const { clientX, clientY } = lastSidebarDragOver;
      if (openSessionAtPoint(clientX, clientY, pendingSessionDrag)) {
        dragOpenedSession = true;
      }
    }
  }
  // Clear any drop overlay dockview never got a chance to remove.
  clearStuckDropOverlay();
  lastSidebarDragOver = undefined;
  sidebarDragOutside = false;
}
