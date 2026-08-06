/**
 * Welcome / splash screen shown on launch when no saved workspace restores.
 *
 * Offers the current launch directory with quick-start session buttons, plus
 * a "recent projects" list drawn from directories that have a saved workspace
 * (backed by the `projects_list` / `project_touch` IPC commands). Opening a
 * project or starting a session dismisses it; any panel appearing (drop,
 * palette action, …) hides it too.
 */

import { invoke } from "@tauri-apps/api/core";

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
  /** Session quick-start buttons (first one is the primary action). */
  quickAgents: SplashAgent[];
  /** Open a session pinned to `cwd` (default agent mode). */
  onOpenProject: (cwd: string) => void;
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
  const hide = () => {
    if (hidden) return;
    hidden = true;
    root.remove();
  };

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
  // Keyboard users can start a session immediately; the first quick-start
  // button is the primary action.
  const primary = root.querySelector<HTMLButtonElement>(".splash-action.primary");
  primary?.focus();
  void refresh();

  return { hide };
}
