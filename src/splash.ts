/**
 * Welcome / splash screen shown on every launch *before* the workspace
 * auto-resumes. The deferred resume is offered as a "Continue latest" button;
 * the current launch directory gets quick-start session buttons, and a
 * "recent projects" list draws from directories that have a saved workspace
 * (backed by the `projects_list` / `project_touch` IPC commands).
 *
 * Opening a project, starting a session, clicking Continue, or dropping a
 * folder onto the splash dismisses it; any panel appearing (drop, palette
 * action, …) hides it too.
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/** A recent project as reported by the backend. */
interface RecentProject {
  cwd: string;
  /** Epoch ms when last opened; 0 when unknown. */
  lastOpened: number;
  /** Whether the directory still exists on disk. */
  exists: boolean;
}

/** A quick-start session button shown for the current directory. */
export interface SplashAgent {
  mode: string;
  label: string;
  icon: string;
}

export interface SplashOptions {
  /** Canonical launch directory (may be undefined while resolving). */
  cwd?: string;
  /** Whether the launch directory has a saved workspace to resume. */
  hasSavedWorkspace: boolean;
  /** Session quick-start buttons (first one is the primary action). */
  quickAgents: SplashAgent[];
  /** Resume the launch directory's latest session (deferred auto-resume). */
  onContinue: () => void;
  /** Open a session pinned to `cwd` (default agent mode). */
  onOpenProject: (cwd: string) => void;
  /** A folder/file was dropped on the splash: dismiss it and continue. */
  onDropPath: (path: string) => void;
  /** Start a session in the launch directory with the given mode. */
  onNewSession: (mode: string) => void;
  /** Dismiss the splash and open a fresh session in the launch directory. */
  onSkip: () => void;
  /** Forget a project (clear its saved workspace). */
  onForgetProject: (cwd: string) => void | Promise<void>;
}

/** Short tab/label name for a directory: last path segment. */
function shortLabel(cwd: string): string {
  const last = cwd.split(/[\\/]/).filter(Boolean).pop();
  return last || cwd;
}

/** Relative "time ago" label for a last-opened timestamp. */
function timeAgo(epochMs: number): string {
  if (!epochMs) return "never";
  const diff = Date.now() - epochMs;
  if (diff < 0) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return days === 1 ? "yesterday" : `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const date = new Date(epochMs);
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Dismissable welcome-screen handle. */
export interface SplashHandle {
  /** Remove the splash from the DOM (idempotent). */
  hide: () => void;
}

/**
 * Mount the splash screen inside `container` (the terminal area). Fetches the
 * recent-projects list on mount and re-fetches after a project is forgotten.
 */
export function mountSplash(container: HTMLElement, opts: SplashOptions): SplashHandle {
  const root = document.createElement("div");
  root.id = "splash";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Welcome — recent projects");

  const inner = document.createElement("div");
  inner.className = "splash-inner";
  root.appendChild(inner);

  // Brand header.
  const brand = document.createElement("div");
  brand.className = "splash-brand";
  const logo = document.createElement("span");
  logo.className = "splash-logo";
  logo.textContent = "✦";
  const brandText = document.createElement("div");
  const h1 = document.createElement("h1");
  h1.textContent = "hiveField";
  const tagline = document.createElement("p");
  tagline.textContent = "Pick a project to get started.";
  brandText.append(h1, tagline);
  brand.append(logo, brandText);
  inner.appendChild(brand);

  // Primary action: resume the launch directory's latest session. This is the
  // deferred "auto-resume" — nothing is restored until the user acts.
  const resumeSection = document.createElement("section");
  resumeSection.className = "splash-section";
  const resumeHeading = document.createElement("h2");
  resumeHeading.textContent = "Continue";
  resumeSection.appendChild(resumeHeading);
  const resumeBtn = document.createElement("button");
  resumeBtn.type = "button";
  resumeBtn.className = "splash-resume";
  const resumeLabel = document.createElement("span");
  resumeLabel.className = "resume-label";
  resumeLabel.textContent = opts.hasSavedWorkspace
    ? "Continue latest session"
    : "Start a session here";
  const resumeArrow = document.createElement("span");
  resumeArrow.className = "resume-arrow";
  resumeArrow.textContent = "→";
  resumeBtn.append(resumeLabel, resumeArrow);
  resumeBtn.addEventListener("click", () => {
    opts.onContinue();
    hide();
  });
  const resumeHint = document.createElement("p");
  resumeHint.className = "splash-resume-hint";
  const resumePath = opts.cwd ?? "this directory";
  resumeHint.textContent = opts.hasSavedWorkspace
    ? `Resumes the last layout for ${resumePath}.`
    : `No saved session for ${resumePath} yet — starts fresh.`;
  resumeSection.append(resumeHeading, resumeBtn, resumeHint);
  inner.appendChild(resumeSection);

  // Current directory card with quick-start sessions.
  const cwdSection = document.createElement("section");
  cwdSection.className = "splash-section";
  const cwdHeading = document.createElement("h2");
  cwdHeading.textContent = "Current directory";
  cwdSection.appendChild(cwdHeading);
  const cwdCard = document.createElement("div");
  cwdCard.className = "splash-cwd";
  const cwdName = document.createElement("div");
  cwdName.className = "project-name";
  cwdName.textContent = opts.cwd ? shortLabel(opts.cwd) : "current directory";
  const cwdPath = document.createElement("div");
  cwdPath.className = "project-path";
  cwdPath.textContent = opts.cwd ?? "";
  cwdPath.title = opts.cwd ?? "";
  const actions = document.createElement("div");
  actions.className = "splash-actions";
  opts.quickAgents.forEach((agent, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    if (i === 0) btn.className = "splash-action primary";
    else btn.className = "splash-action";
    btn.textContent = `${agent.icon} ${agent.label}`;
    btn.addEventListener("click", () => opts.onNewSession(agent.mode));
    actions.appendChild(btn);
  });
  cwdCard.append(cwdName, cwdPath, actions);
  cwdSection.appendChild(cwdCard);
  inner.appendChild(cwdSection);

  // Recent projects list.
  const recentSection = document.createElement("section");
  recentSection.className = "splash-section";
  const recentHeading = document.createElement("h2");
  recentHeading.textContent = "Recent projects";
  const recentHint = document.createElement("span");
  recentHint.className = "splash-hint";
  recentHint.textContent = "directories with a saved workspace";
  recentHeading.appendChild(recentHint);
  recentSection.appendChild(recentHeading);
  const list = document.createElement("div");
  list.className = "splash-recents";
  const empty = document.createElement("p");
  empty.className = "splash-empty";
  empty.textContent =
    "No recent projects yet — start in the current directory and your layout will be saved here.";
  recentSection.append(list, empty);
  inner.appendChild(recentSection);

  // Skip link (opens a fresh session in the launch directory).
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "splash-skip";
  skip.textContent = "Skip — open a fresh session here";
  skip.addEventListener("click", () => opts.onSkip());
  inner.appendChild(skip);

  let hidden = false;
  let dropHint: HTMLDivElement | null = null;
  let unlistenDrop: (() => void) | undefined;
  const hide = () => {
    if (hidden) return;
    hidden = true;
    root.remove();
    dropHint?.remove();
    dropHint = null;
    unlistenDrop?.();
  };

  // OS file/folder drops dismiss the splash and continue: the drop is handed
  // to main (which resumes the saved workspace and lands the path in the
  // shell), and the splash is removed. Listens only while mounted; the global
  // file-drop handler stays inert because no sessions exist yet.
  getCurrentWebview()
    .onDragDropEvent((event) => {
      const { type } = event.payload;
      if (type === "enter" || type === "over") {
        root.classList.add("dragover");
        if (!dropHint) {
          dropHint = document.createElement("div");
          dropHint.className = "splash-drop-hint";
          dropHint.textContent = "Drop to continue";
          root.appendChild(dropHint);
        }
        return;
      }
      if (type === "leave") {
        root.classList.remove("dragover");
        dropHint?.remove();
        dropHint = null;
        return;
      }
      // type === "drop"
      root.classList.remove("dragover");
      dropHint?.remove();
      dropHint = null;
      const { paths } = event.payload;
      if (paths.length === 0) return; // non-file drag (text/URL from another app)
      opts.onDropPath(paths[0]);
      hide();
    })
    .then((unlisten) => {
      // The splash may have been dismissed before the listener finished
      // registering; unlisten immediately in that case.
      if (hidden) unlisten();
      else unlistenDrop = unlisten;
    })
    .catch(() => {
      // Drag-drop interception unavailable: the splash still works, drops
      // just don't dismiss it.
    });

  /** Render a single recent-project row (or nothing when filtered out). */
  function renderProject(project: RecentProject): HTMLElement | undefined {
    if (opts.cwd && project.cwd === opts.cwd) return undefined; // shown above
    const row = document.createElement("div");
    row.className = project.exists ? "splash-project" : "splash-project missing";
    row.setAttribute("role", "button");
    row.tabIndex = 0;

    const icon = document.createElement("span");
    icon.className = "project-icon";
    icon.textContent = "🗀";
    const meta = document.createElement("span");
    meta.className = "project-meta";
    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = shortLabel(project.cwd);
    const path = document.createElement("span");
    path.className = "project-path";
    path.textContent = project.exists
      ? `${project.cwd} · ${timeAgo(project.lastOpened)}`
      : `${project.cwd} · missing`;
    path.title = project.cwd;
    meta.append(name, path);

    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "project-forget";
    forget.title = "Forget this project";
    forget.setAttribute("aria-label", `Forget ${project.cwd}`);
    forget.textContent = "✕";
    forget.addEventListener("click", (e) => {
      e.stopPropagation();
      void (async () => {
        await opts.onForgetProject(project.cwd);
        await refresh();
      })();
    });

    row.append(icon, meta, forget);
    if (project.exists) {
      const open = () => {
        opts.onOpenProject(project.cwd);
        hide();
      };
      row.addEventListener("click", open);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
    } else {
      row.setAttribute("aria-disabled", "true");
      row.title = "This directory no longer exists";
    }
    return row;
  }

  async function refresh(): Promise<void> {
    let projects: RecentProject[] = [];
    try {
      projects = await invoke<RecentProject[]>("projects_list");
    } catch {
      // Backend unavailable: show an empty list (the empty-state hint covers it).
    }
    list.textContent = "";
    const shown = projects.map(renderProject).filter((el): el is HTMLElement => !!el);
    for (const el of shown) list.appendChild(el);
    empty.style.display = shown.length > 0 ? "none" : "";
  }

  container.appendChild(root);
  // Keyboard users can continue immediately: the resume button is the
  // primary (focused) action, and Enter activates it.
  root.querySelector<HTMLButtonElement>(".splash-resume")?.focus();
  void refresh();

  return { hide };
}
