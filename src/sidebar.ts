/**
 * The left sidebar: drag sources (one per visible session mode), the live
 * Running list (mirrors the dockview layout), the workspace-slot strip
 * (Ctrl+1…Ctrl+0) and the Workspace info section (launch dir, git
 * branch/worktrees, session count) — plus the workspace switching machinery
 * that parks/restores sessions across slots.
 *
 * The sidebar re-renders from the shared session state (state.ts); init
 * registers `refreshSidebarRunning`/`scheduleWorkspaceRefresh` as the state
 * module's sidebar hooks, so any module can trigger a re-render without
 * importing this one (which would create an import cycle).
 */

import { invoke } from "@tauri-apps/api/core";
import { isKnownModeAll, modeIconAll, modeLabelAll } from "./agents";
import { customs, DEFAULT_MODE, sessionModes, type Mode } from "./modes";
import { getSettings, subscribe } from "./settings";
import { toggleSettings } from "./settings-ui";
import { addPanelWithMode, killParkedSession, shortLabel } from "./sessions";
import { clearIdle, clearNotify, INDICATOR_ACTIVITY, INDICATOR_DONE } from "./titles";
import {
  getCurrentSlot,
  getWorkspaceSlots,
  renameWorkspace,
  switchWorkspace,
} from "./workspace";
import { openPromptModal } from "./modal";
import {
  beginSidebarDrag,
  buildDragGhost,
  DRAG_GRACE_MS,
  DND_MIME,
  endSidebarDrag,
  serializeDrag,
  setNewWindowIndicator,
  type SessionDrag,
} from "./dnd";
import {
  bumpPanelCounter,
  getApi,
  isPanelActive,
  panelStatus,
  panelToSession,
  parkedKeyFor,
  parkedSessions,
  sessions,
} from "./state";
import type { AppSettings } from "./settings";

/** Sidebar live sections (populated by buildSidebar). */
let sidebarRunningEl: HTMLElement | null = null;
let sidebarWorkspaceEl: HTMLElement | null = null;

/** Sidebar workspace-slot switcher strip (Ctrl+1…Ctrl+0). */
let sidebarWorkspacesEl: HTMLElement | null = null;

/** Cached workspace info shown in the sidebar's Workspace section. */
let launchCwd: string | undefined;
let gitRoot: string | undefined;
let gitBranch: string | undefined;
let gitWorktreeCount = 0;

/** Short uppercase section header ("RUNNING", "WORKSPACE"). */
function sidebarSectionTitle(text: string): HTMLElement {
  const t = document.createElement("div");
  t.className = "sidebar-section-title";
  t.textContent = text;
  return t;
}

/** Status glyph for a sidebar session row (active / busy / done). */
function sessionStatusGlyph(panelId: string): { glyph: string; cls: string } {
  const st = panelStatus.get(panelId);
  const indicator = st?.indicator ?? "";
  if (isPanelActive(panelId)) return { glyph: "▮", cls: "active" };
  if (indicator === INDICATOR_ACTIVITY) return { glyph: "●", cls: "activity" };
  if (indicator === INDICATOR_DONE) return { glyph: "✓", cls: "done" };
  return { glyph: "", cls: "" };
}

/**
 * Rebuild the "Running" sidebar list from the live dockview layout. The list
 * is small, so it's fine to re-render on every title/indicator/active-panel
 * change (renderTitle/setIndicator and the panel lifecycle hooks keep it in
 * sync). Newest session first.
 */
export function refreshSidebarRunning(): void {
  if (!sidebarRunningEl) return;
  sidebarRunningEl.replaceChildren();

  const panels = getApi()?.panels ?? [];
  if (panels.length === 0 && parkedSessions.size === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No sessions — drag one in above";
    sidebarRunningEl.appendChild(empty);
    return;
  }

  for (const panel of [...panels].reverse()) {
    const params = panel.api.getParameters() as Record<string, unknown>;
    const mode: Mode =
      typeof params.mode === "string" &&
      isKnownModeAll(params.mode, customs())
        ? params.mode
        : DEFAULT_MODE;
    const sessionId = panelToSession.get(panel.id);
    const entry = sessionId !== undefined ? sessions.get(sessionId) : undefined;
    const cwd =
      entry?.cwd ?? (typeof params.cwd === "string" ? params.cwd : undefined);
    const { glyph, cls } = sessionStatusGlyph(panel.id);

    const item = document.createElement("div");
    item.className = "sidebar-session";
    item.dataset.mode = mode;
    if (cls === "active") item.classList.add("active");
    item.title = (panel.title ?? "") + (cwd ? ` — ${cwd}` : "");

    const icon = document.createElement("span");
    icon.className = "sidebar-session-icon";
    icon.textContent = modeIconAll(mode, customs());
    item.appendChild(icon);

    const body = document.createElement("div");
    body.className = "sidebar-session-body";

    // The tab title carries the ●/✓ indicator prefix; our own status glyph
    // shows it, so strip it here to avoid double-indicating.
    const label = document.createElement("div");
    label.className = "sidebar-session-title";
    label.textContent = (panel.title ?? "").replace(/^[●✓] /, "");
    body.appendChild(label);

    if (cwd) {
      const dir = document.createElement("div");
      dir.className = "sidebar-session-cwd";
      dir.textContent = shortLabel(cwd);
      dir.title = cwd;
      body.appendChild(dir);
    }
    item.appendChild(body);

    const status = document.createElement("span");
    status.className = `sidebar-session-status${cls ? ` ${cls}` : ""}`;
    status.textContent = glyph;
    item.appendChild(status);

    // Click focuses the pane and its terminal.
    item.addEventListener("click", () => {
      panel.api.setActive();
      const sid = panelToSession.get(panel.id);
      const e = sid !== undefined ? sessions.get(sid) : undefined;
      e?.canvas.focus();
    });

    // Hover-only ✕ closes the session (same as Ctrl+Shift+W on its tab).
    const close = document.createElement("button");
    close.className = "sidebar-session-close";
    close.type = "button";
    close.textContent = "×";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      panel.api.close();
    });
    item.appendChild(close);

    sidebarRunningEl.appendChild(item);
  }

  // Background sessions: parked when their workspace was left, still running.
  // Clicking one jumps back to the workspace slot it belongs to; ✕ kills it.
  for (const [sessionId, parked] of parkedSessions) {
    const entry = sessions.get(sessionId);
    if (!entry) continue;
    const parkedKey = parkedKeyFor(sessionId);
    const st = panelStatus.get(parkedKey);
    const baseTitle = st?.baseTitle ?? entry.panel?.title ?? modeLabelAll(entry.mode, customs());
    const { glyph, cls } = sessionStatusGlyph(parkedKey);

    const item = document.createElement("div");
    item.className = "sidebar-session background";
    item.dataset.mode = entry.mode;
    item.title =
      `${baseTitle} — running in the background (workspace ${parked.slot})` +
      (entry.cwd ? ` — ${entry.cwd}` : "");

    const icon = document.createElement("span");
    icon.className = "sidebar-session-icon";
    icon.textContent = modeIconAll(entry.mode, customs());
    item.appendChild(icon);

    const body = document.createElement("div");
    body.className = "sidebar-session-body";

    const label = document.createElement("div");
    label.className = "sidebar-session-title";
    label.textContent = baseTitle.replace(/^[●✓] /, "");
    body.appendChild(label);

    if (entry.cwd) {
      const dir = document.createElement("div");
      dir.className = "sidebar-session-cwd";
      dir.textContent = shortLabel(entry.cwd);
      dir.title = entry.cwd;
      body.appendChild(dir);
    }
    item.appendChild(body);

    const status = document.createElement("span");
    status.className = `sidebar-session-status${cls ? ` ${cls}` : " background"}`;
    status.textContent = glyph || "◌";
    status.title = `Background session (workspace ${parked.slot})`;
    item.appendChild(status);

    // Click jumps back to the workspace slot this session belongs to.
    item.addEventListener("click", () => switchToWorkspace(parked.slot));

    // Hover-only ✕ kills the background session.
    const close = document.createElement("button");
    close.className = "sidebar-session-close";
    close.type = "button";
    close.textContent = "×";
    close.title = "Kill background session";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      killParkedSession(sessionId);
    });
    item.appendChild(close);

    sidebarRunningEl.appendChild(item);
  }
}

/** Debounce re-fetching git/workspace info when several sessions change at once. */
let workspaceRefreshTimer: ReturnType<typeof setTimeout> | undefined;
export function scheduleWorkspaceRefresh(): void {
  if (workspaceRefreshTimer !== undefined) clearTimeout(workspaceRefreshTimer);
  workspaceRefreshTimer = setTimeout(() => {
    workspaceRefreshTimer = undefined;
    void refreshWorkspaceInfo();
  }, 250);
}

/**
 * Fetch the launch directory + git worktree info and re-render the Workspace
 * section. Best-effort: on backend errors the section keeps its placeholders.
 */
export async function refreshWorkspaceInfo(): Promise<void> {
  try {
    if (launchCwd === undefined) {
      launchCwd = await invoke<string>("workspace_cwd");
    }
    const info = await invoke<{
      root: string | null;
      worktrees: Array<{ branch: string | null; current: boolean }>;
    }>("git_worktrees");
    gitRoot = info.root ?? undefined;
    gitBranch = info.worktrees.find((w) => w.current)?.branch ?? undefined;
    gitWorktreeCount = info.worktrees.length;
  } catch {
    // Backend unavailable — keep whatever we rendered before.
  }
  renderWorkspaceSection();
}

/** Re-render the cached workspace info into the sidebar. */
function renderWorkspaceSection(): void {
  if (!sidebarWorkspaceEl) return;
  sidebarWorkspaceEl.replaceChildren();

  const addRow = (label: string, value: string | undefined, title?: string) => {
    const row = document.createElement("div");
    row.className = "workspace-row";
    const lab = document.createElement("span");
    lab.className = "workspace-row-label";
    lab.textContent = label;
    const val = document.createElement("span");
    val.className = "workspace-row-value";
    val.textContent = value ?? "—";
    if (title) val.title = title;
    row.append(lab, val);
    sidebarWorkspaceEl!.appendChild(row);
  };

  addRow("Directory", launchCwd ? shortLabel(launchCwd) : "…", launchCwd);
  // "—" while the fetch is pending or when the launch dir isn't a git repo.
  addRow("Branch", gitRoot === undefined ? undefined : gitBranch ?? "detached");
  if (gitRoot !== undefined) addRow("Worktrees", String(gitWorktreeCount));
  addRow("Sessions", String((getApi()?.panels.length ?? 0) + parkedSessions.size));
}

/** The sidebar's "New session" drag-sources container (rebuilt on demand). */
let sidebarSourcesEl: HTMLElement | null = null;

/** Last visible-agent selection, to detect when the sidebar sources need rebuilding. */
let lastVisibleAgents = visibleAgentsKey(getSettings());

/**
 * Key over the visible-agent selection AND the custom-agent registry: adding
 * or removing a custom agent changes the offered sources just like toggling
 * an existing one, so the sidebar must rebuild in both cases.
 */
function visibleAgentsKey(s: AppSettings): string {
  return `${s.visibleAgents.join(",")}|${s.customAgents
    .map((a) => a.id)
    .join(",")}`;
}

/**
 * (Re)build the drag sources at the top of the sidebar from the currently
 * visible session modes. Re-run whenever the `visibleAgents` setting changes
 * so hidden agents leave the sidebar immediately.
 */
export function buildSidebarSources(): void {
  if (!sidebarSourcesEl) return;
  sidebarSourcesEl.replaceChildren();

  const title = document.createElement("div");
  title.className = "sidebar-title";
  title.textContent = "New session";
  sidebarSourcesEl.appendChild(title);

  const modes = sessionModes();

  for (const source of modes) {
    const item = document.createElement("div");
    item.className = "drag-item";
    item.dataset.mode = source.mode;
    item.draggable = true;

    const icon = document.createElement("span");
    icon.className = "drag-icon";
    icon.textContent = source.icon;
    item.appendChild(icon);
    item.appendChild(document.createTextNode(source.label));

    item.addEventListener("dragstart", (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      // Remember the drag in module state: WebKitGTK only surfaces the
      // payload to `drop` handlers, never to `dragover`, and sometimes
      // strips our custom MIME type entirely. The flag drives dockview's
      // drop-overlay acceptance; the stored payload survives any MIME loss.
      const drag: SessionDrag = { mode: source.mode };
      beginSidebarDrag(drag);
      // Advertise the session under our own MIME type *and* as plain text:
      // some WebKitGTK builds only surface the text/plain target across a
      // drag. JSON carries the mode plus an optional worktree cwd.
      const payload = serializeDrag(drag);
      dt.setData(DND_MIME, payload);
      dt.setData("text/plain", payload);
      dt.effectAllowed = "copy";

      // Custom ghost so the drag reads as a session, not a text blob.
      const ghost = buildDragGhost(source);
      document.body.appendChild(ghost);
      dt.setDragImage(ghost, 8, 8);
      requestAnimationFrame(() => ghost.remove());
    });

    // `dragend` fires whether the drag was dropped or cancelled — see
    // endSidebarDrag (dnd.ts) for the WebKitGTK recovery logic.
    item.addEventListener("dragend", (e) => endSidebarDrag(e));

    sidebarSourcesEl.appendChild(item);
  }
}

export function buildSidebar() {
  const sidebar = document.getElementById("sidebar")!;

  // Drag sources live in their own container so the visible-agent setting can
  // rebuild just this section (see buildSidebarSources).
  const sourcesSection = document.createElement("div");
  sourcesSection.className = "sidebar-sources";
  sidebar.appendChild(sourcesSection);
  sidebarSourcesEl = sourcesSection;
  buildSidebarSources();

  // Live list of running sessions (rebuilds as panes come and go).
  const runningSection = document.createElement("div");
  runningSection.className = "sidebar-section running";
  runningSection.appendChild(sidebarSectionTitle("Running"));
  const runningList = document.createElement("div");
  runningList.className = "sidebar-running-list";
  runningSection.appendChild(runningList);
  sidebarRunningEl = runningList;
  sidebar.appendChild(runningSection);

  // Workspace switcher: ten slots, Ctrl+1…Ctrl+0 to jump. Click a row to
  // switch (empty slots start a fresh workspace), double-click to rename.
  const wsStripSection = document.createElement("div");
  wsStripSection.className = "sidebar-section workspaces";
  wsStripSection.appendChild(sidebarSectionTitle("Workspaces"));
  const wsStrip = document.createElement("div");
  wsStrip.className = "sidebar-workspace-strip";
  wsStripSection.appendChild(wsStrip);
  sidebar.appendChild(wsStripSection);
  sidebarWorkspacesEl = wsStrip;
  renderWorkspaceStrip();

  // Workspace info: launch dir, git branch/worktrees, session count.
  const wsSection = document.createElement("div");
  wsSection.className = "sidebar-section workspace";
  wsSection.appendChild(sidebarSectionTitle("Workspace"));
  const wsBody = document.createElement("div");
  wsBody.className = "sidebar-workspace-body";
  wsSection.appendChild(wsBody);
  sidebarWorkspaceEl = wsBody;
  sidebar.appendChild(wsSection);

  // Handy shortcut reminders (live: they follow the configured keybinds).
  const shortcuts = document.createElement("div");
  shortcuts.className = "sidebar-shortcuts";
  const shortcutRows: Array<{ kbd: HTMLElement; label: string }> = [];
  const renderShortcuts = () => {
    const kb = getSettings().keybinds;
    const entries: Array<[string, string]> = [
      [kb.newTab, "new tab"],
      [kb.palette, "palette"],
      [kb.find, "find"],
      [`${kb.workspace1}…${kb.workspace10}`, "workspaces"],
    ];
    entries.forEach(([keys, label], i) => {
      if (!shortcutRows[i]) {
        const row = document.createElement("div");
        const k = document.createElement("kbd");
        k.textContent = keys;
        row.appendChild(k);
        row.appendChild(document.createTextNode(` ${label}`));
        shortcuts.appendChild(row);
        shortcutRows.push({ kbd: k, label });
      } else {
        shortcutRows[i].kbd.textContent = keys;
      }
    });
  };
  renderShortcuts();
  subscribe(() => renderShortcuts());
  sidebar.appendChild(shortcuts);
  const settingsBtn = document.createElement("button");
  settingsBtn.className = "sidebar-settings";
  settingsBtn.type = "button";
  settingsBtn.textContent = "⚙";
  settingsBtn.addEventListener("click", toggleSettings);
  sidebar.appendChild(settingsBtn);
}

/**
 * Rebuild the sidebar's drag sources whenever the visible-agent selection
 * changes, so hidden agents disappear (and re-enabled ones reappear) without
 * restarting the app. Registered by init after buildSidebar.
 */
export function syncSidebarSourcesToSettings(): void {
  subscribe((settings) => {
    const visibleKey = visibleAgentsKey(settings);
    if (visibleKey !== lastVisibleAgents) {
      lastVisibleAgents = visibleKey;
      buildSidebarSources();
    }
  });
}

/* ---------------------------------------------------------------------------
 * Workspace switching (Ctrl+1…Ctrl+0) + sidebar slot strip
 * --------------------------------------------------------------------------- */

/**
 * Locate the terminal content element for a panel (it carries data-panel-id).
 */
function findTerminalElement(panelId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `.terminal-panel[data-panel-id="${panelId}"]`
  );
}

/**
 * Park every live session of the current workspace before switching away: the
 * PTYs keep running and the terminal elements (scrollback included) are kept
 * off-screen, so the workspace can be restored intact later. The panel
 * removals that follow (`api.clear`) see the sessions in `parkedSessions` and
 * skip killing them; output keeps streaming into the hidden terminals and the
 * tab indicator / agent-done notifications keep working.
 *
 * Runs via the `beforeClear` hook of `switchWorkspace`, so it only fires when
 * a switch is actually in flight and `slot` is the workspace being left.
 *
 * The panel's title/notification status is re-keyed under `parked:<id>` so it
 * can never collide with a live panel that happens to reuse the same panel id
 * (serialized layouts can carry identical ids across slots/runs).
 */
function parkWorkspaceSessions(slot: number): void {
  for (const panel of getApi().panels) {
    const sessionId = panelToSession.get(panel.id);
    if (sessionId === undefined) continue;
    const entry = sessions.get(sessionId);
    if (!entry) continue;
    const element = findTerminalElement(panel.id);
    if (!element) continue;
    const parkedKey = parkedKeyFor(sessionId);
    const st = panelStatus.get(panel.id);
    if (st) {
      panelStatus.set(parkedKey, st);
      panelStatus.delete(panel.id);
    }
    // Pending idle/notify timers were armed under the panel id and would
    // no-op now that the status moved; the next output event re-arms them
    // under the parked key.
    clearIdle(panel.id);
    clearNotify(panel.id);
    // The panel is about to be detached (api.clear runs next), and WebKitGTK
    // never fires a blur for a textarea removed from the DOM — leaving xterm
    // believing the terminal is still focused, so restoring the session into
    // an inactive pane would paint a filled cursor instead of an outlined one.
    // Blur explicitly first (a no-op for panes that were never focused).
    entry.canvas.blur();
    parkedSessions.set(sessionId, { slot, element });
  }
}

/**
 * Jump to a workspace slot: park the current layout's sessions so they keep
 * running in the background, save the layout, restore the target (closing the
 * live panels and re-attaching the target's parked sessions or respawning from
 * its saved layout), seed empty slots with a fresh opencode panel, and refresh
 * the strip.
 */
export function switchToWorkspace(slot: number): void {
  void switchWorkspace(getApi(), slot, (_panels, leavingSlot) =>
    parkWorkspaceSessions(leavingSlot)
  ).then((restored) => {
    // Restored panels carry serialized ids like `panel-1`, so bump the
    // counter past them before any new panel is added (avoids duplicates).
    for (const panel of getApi().panels) {
      const m = /^panel-(\d+)$/.exec(panel.id);
      if (m) bumpPanelCounter(parseInt(m[1], 10));
    }
    if (!restored) addPanelWithMode("opencode");
    renderWorkspaceStrip();
    // Reconcile cursor fill/outline state with the newly active pane after
    // parked sessions were re-attached and fresh ones spawned.
    
  });
}

/** Re-render the sidebar workspace-slot strip from the workspace module. */
export function renderWorkspaceStrip(): void {
  if (!sidebarWorkspacesEl) return;
  sidebarWorkspacesEl.replaceChildren();
  const current = getCurrentSlot();
  for (const ws of getWorkspaceSlots()) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "workspace-slot";
    if (ws.slot === current) row.classList.add("active");

    const num = document.createElement("span");
    num.className = "workspace-slot-num";
    num.textContent = String(ws.slot);

    const label = document.createElement("span");
    label.className = "workspace-slot-label";
    label.textContent =
      ws.name ?? (ws.hasLayout ? `workspace ${ws.slot}` : "empty");

    const dot = document.createElement("span");
    dot.className = "workspace-slot-dot";
    if (ws.hasLayout) dot.classList.add("filled");

    row.append(num, label, dot);
    row.addEventListener("click", () => switchToWorkspace(ws.slot));
    row.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      void renameWorkspacePrompt(ws.slot);
    });
    sidebarWorkspacesEl!.appendChild(row);
  }
}

/** Prompt for a workspace slot's name (double-click a strip row). */
export async function renameWorkspacePrompt(slot: number): Promise<void> {
  const ws = getWorkspaceSlots().find((w) => w.slot === slot);
  const name = await openPromptModal({
    title: `Rename workspace ${slot}`,
    label: "Workspace name",
    placeholder: "e.g. docs, backend, agents",
    hint: `Leave empty to clear the name. ${getSettings().keybinds.workspace1}…${getSettings().keybinds.workspace10} switches workspaces.`,
    value: ws?.name ?? "",
    confirmText: "Save",
  });
  if (name === null) return;
  await renameWorkspace(slot, name);
  renderWorkspaceStrip();
}
