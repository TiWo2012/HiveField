/**
 * Ten seconds after launch, ask the backend how the repo changed since the
 * app opened — the backend captured HEAD at startup, and this diffs it
 * against the current working tree (new commits + uncommitted edits). Shows
 * a small toast with the totals: files changed, lines added, lines deleted.
 * Nothing is shown when the launch directory is not a git repository, the
 * window moved to a different repo, or nothing changed.
 */

import { invoke } from "@tauri-apps/api/core";

/** Result of the `git_diff_summary` IPC command (null when not applicable). */
interface GitDiffSummary {
  /** Number of files that changed since launch. */
  changed: number;
  /** Total inserted lines since launch. */
  insertions: number;
  /** Total deleted lines since launch. */
  deletions: number;
}

export function scheduleGitDiffReport(): void {
  setTimeout(async () => {
    let summary: GitDiffSummary | null = null;
    try {
      summary = await invoke<GitDiffSummary | null>("git_diff_summary");
    } catch {
      // Not a git repo / backend unavailable: nothing to report.
    }
    if (!summary || summary.changed === 0) return;

    const toast = document.createElement("div");
    toast.className = "hivefield-toast git-diff-toast";

    const icon = document.createElement("span");
    icon.className = "git-diff-icon";
    icon.textContent = "⑂";
    icon.title = "Changes since launch";

    const text = document.createElement("span");
    text.className = "git-diff-text";
    const files = document.createElement("span");
    files.textContent = `${summary.changed} file${summary.changed === 1 ? "" : "s"} changed`;
    const plus = document.createElement("span");
    plus.className = "git-diff-add";
    plus.textContent = `+${summary.insertions}`;
    plus.title = "lines added";
    const minus = document.createElement("span");
    minus.className = "git-diff-del";
    minus.textContent = `−${summary.deletions}`;
    minus.title = "lines deleted";
    text.append("since launch · ", files, " · ", plus, " ", minus);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "git-diff-dismiss";
    close.title = "Dismiss";
    close.setAttribute("aria-label", "Dismiss git changes summary");
    close.textContent = "✕";
    close.addEventListener("click", () => toast.remove());

    toast.append(icon, text, close);
    document.body.appendChild(toast);
    // Keep it out of the way: auto-dismiss after a while if not clicked.
    setTimeout(() => toast.remove(), 20_000);
  }, 10_000);
}
