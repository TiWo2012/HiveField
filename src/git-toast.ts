/**
 * Poll the backend for repo changes since launch. The backend captured HEAD
 * at startup and diffs it against the current working tree (new commits +
 * uncommitted edits), and it returns a summary only *once per distinct change
 * set* — a repeated poll with nothing new yields null, so this re-arms
 * naturally: the toast fires when the first changes land, and again whenever a
 * new burst of changes appears. The dedup state lives in the backend, so a
 * frontend reload never re-shows an already-delivered summary. Polling stops
 * (until the next reload) when the backend reports the report is not
 * applicable, e.g. the launch directory is not a git repository.
 */

import { invoke } from "@tauri-apps/api/core";

/** Result of the `git_diff_report` IPC command (null when not applicable). */
interface GitDiffSummary {
  /** Number of files that changed since launch. */
  changed: number;
  /** Total inserted lines since launch. */
  insertions: number;
  /** Total deleted lines since launch. */
  deletions: number;
}

/** First check after launch (kept from the original one-shot timer). */
const GIT_REPORT_INITIAL_DELAY_MS = 10_000;
/** Re-arm interval between change-set polls. */
const GIT_REPORT_POLL_MS = 30_000;

let gitReportTimer: ReturnType<typeof setTimeout> | undefined;
/** The currently visible toast (replaced, never stacked). */
let gitDiffToast: HTMLElement | null = null;

/** Start polling for repo changes since launch (first check after 10s). */
export function scheduleGitDiffReport(): void {
  gitReportTimer = setTimeout(() => void pollGitDiffReport(), GIT_REPORT_INITIAL_DELAY_MS);
}

async function pollGitDiffReport(): Promise<void> {
  let summary: GitDiffSummary | null = null;
  try {
    summary = await invoke<GitDiffSummary | null>("git_diff_report");
  } catch {
    // Not a git repo / backend unavailable: nothing to report.
  }
  if (summary && summary.changed > 0) showGitDiffToast(summary);
  gitReportTimer = setTimeout(() => void pollGitDiffReport(), GIT_REPORT_POLL_MS);
}

function showGitDiffToast(summary: GitDiffSummary): void {
  if (gitDiffToast && gitDiffToast.isConnected) gitDiffToast.remove();

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
  gitDiffToast = toast;
  document.body.appendChild(toast);
  // Keep it out of the way: auto-dismiss after a while if not clicked. A
  // later change set re-arms a fresh toast via pollGitDiffReport.
  setTimeout(() => toast.remove(), 20_000);
}
