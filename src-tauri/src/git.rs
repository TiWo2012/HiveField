//! Git worktree integration.
//!
//! Provides discovery, creation, and removal of git worktrees for the repo the
//! app was launched from. Everything shells out to the `git` binary — there are
//! no extra crates. All discovery is best-effort: a launch directory that is
//! not inside a git repository yields an empty worktree list rather than an
//! error, so the UI can render nothing and no one has to special-case it.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::Unpoisoned;

/// How long a cached worktree listing stays fresh. The frontend refreshes
/// workspace info on every session change (debounced to ~250 ms); without a
/// cache each refresh spawns fresh `git` processes, so misses are cheap and
/// hits must be the common case.
const WORKTREES_TTL: Duration = Duration::from_secs(5);

/// How long a cached diff summary stays fresh. Diffs change as the user edits,
/// but the sidebar / report only needs coarse, infrequent updates.
const DIFF_TTL: Duration = Duration::from_secs(10);

/// TTL cache for expensive git queries (each of which shells out to the `git`
/// binary). Managed as Tauri state so the hot IPC paths — worktree listing and
/// diff summaries — are served from memory most of the time. Mutating
/// operations (worktree create/remove) invalidate the affected entries.
pub struct GitCache {
    worktrees: Mutex<HashMap<String, (Instant, WorktreesInfo)>>,
    diffs: Mutex<HashMap<(String, String), (Instant, Option<DiffSummary>)>>,
}

impl Default for GitCache {
    fn default() -> Self {
        Self {
            worktrees: Mutex::new(HashMap::new()),
            diffs: Mutex::new(HashMap::new()),
        }
    }
}

impl GitCache {
    /// Worktree listing for the repo containing `dir`, cached per query dir
    /// for [`WORKTREES_TTL`]. Cache misses run the real git queries.
    pub fn cached_worktrees(&self, dir: &Path) -> WorktreesInfo {
        let key = dir.to_string_lossy().into_owned();
        if let Some((at, info)) = self.worktrees.lock_unpoisoned().get(&key) {
            if at.elapsed() < WORKTREES_TTL {
                return info.clone();
            }
        }
        let info = list(dir);
        self.worktrees
            .lock_unpoisoned()
            .insert(key, (Instant::now(), info.clone()));
        info
    }

    /// Diff summary of the repo containing `dir` against `base`, cached for
    /// [`DIFF_TTL`]. `launch_root` gates the result: the diff is only reported
    /// while `dir` resolves to the repo the app launched from (matching the
    /// `git_diff_summary` semantics). A cached `None` (not that repo, bad
    /// base, git unavailable) is stored too, so a flaky git call is not
    /// retried on every poll.
    pub fn cached_diff_summary(
        &self,
        dir: &Path,
        launch_root: &Path,
        base: &str,
    ) -> Option<DiffSummary> {
        let key = (dir.to_string_lossy().into_owned(), base.to_string());
        if let Some((at, summary)) = self.diffs.lock_unpoisoned().get(&key) {
            if at.elapsed() < DIFF_TTL {
                return summary.clone();
            }
        }
        let root = repo_root(dir)?;
        let summary = if root == launch_root {
            diff_summary(&root, base)
        } else {
            None
        };
        self.diffs
            .lock_unpoisoned()
            .insert(key, (Instant::now(), summary.clone()));
        summary
    }

    /// Drop cached entries keyed by `dir` after a mutating git operation
    /// (worktree create/remove) so the next query observes the new state.
    pub fn invalidate(&self, dir: &Path) {
        let key = dir.to_string_lossy().into_owned();
        self.worktrees.lock_unpoisoned().remove(&key);
        self.diffs.lock_unpoisoned().retain(|(d, _), _| d != &key);
    }
}

/// A single worktree as reported by `git worktree list --porcelain`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// Absolute path to the worktree directory.
    pub path: String,
    /// Branch name (without the `refs/heads/` prefix), or `None` when HEAD is
    /// detached or the worktree is bare.
    pub branch: Option<String>,
    /// True when this is a bare repository.
    pub bare: bool,
    /// True when HEAD is not on a branch (e.g. a commit was checked out).
    pub detached: bool,
    /// True for the worktree the app was launched from.
    pub current: bool,
}

/// Payload of the `git_worktrees` IPC command.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreesInfo {
    /// Canonical top-level of the worktree the app was launched from, or
    /// `None` when the launch dir is not inside a git repository.
    pub root: Option<String>,
    /// All worktrees of that repo (empty when not in a repository).
    pub worktrees: Vec<Worktree>,
}

/// Run `git -C <dir> <args>` and return stdout on success (exit code 0).
fn git_stdout(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Resolve the top-level directory of the git worktree containing `dir`.
pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    let out = git_stdout(dir, &["rev-parse", "--show-toplevel"])?;
    let root = out.trim();
    if root.is_empty() {
        return None;
    }
    Some(PathBuf::from(root))
}

/// A summary of the changes between a base commit and the current working
/// tree: how many files were touched, plus the total added/deleted lines.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    /// Number of files that changed (modified, added, deleted, renamed).
    pub changed: u64,
    /// Total inserted lines.
    pub insertions: u64,
    /// Total deleted lines.
    pub deletions: u64,
}

/// Resolve the commit the repo's HEAD currently points at (full hash).
/// Returns `None` when `dir` is not inside a repository or git is unavailable.
pub fn head_commit(dir: &Path) -> Option<String> {
    let out = git_stdout(dir, &["rev-parse", "HEAD"])?;
    let hash = out.trim();
    if hash.is_empty() {
        return None;
    }
    Some(hash.to_string())
}

/// Diff summary between the `base` commit and the current working tree of the
/// repo containing `dir`. `git diff <base>` compares the commit against the
/// index plus the working tree, so it catches both commits made since `base`
/// and uncommitted edits — exactly the "how much has the repo moved since
/// launch" question. Binary files count toward `changed` but contribute 0
/// lines (`git` reports `-` for them in numstat). Returns `None` when the
/// diff cannot be produced (not a repo, bad base, git unavailable).
pub fn diff_summary(dir: &Path, base: &str) -> Option<DiffSummary> {
    let numstat = git_stdout(dir, &["diff", "--numstat", base])?;
    Some(parse_numstat(&numstat))
}

/// Sum `git diff --numstat` output into a [`DiffSummary`]. Each non-empty
/// line is `\`<added>\t<deleted>\t<path>``; binary files report `-` for their
/// counts and are only counted in `changed`.
fn parse_numstat(numstat: &str) -> DiffSummary {
    let mut summary = DiffSummary {
        changed: 0,
        insertions: 0,
        deletions: 0,
    };
    for line in numstat.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let Some(add) = parts.next() else { continue };
        let Some(del) = parts.next() else { continue };
        summary.changed += 1;
        summary.insertions += add.parse::<u64>().unwrap_or(0);
        summary.deletions += del.parse::<u64>().unwrap_or(0);
    }
    summary
}

/// List the worktrees of the repo containing `dir`. Returns an empty
/// `WorktreesInfo` (never an error) when `dir` is not inside a repository or
/// git is unavailable.
pub fn list(dir: &Path) -> WorktreesInfo {
    let root = match repo_root(dir) {
        Some(root) => root,
        None => return WorktreesInfo { root: None, worktrees: Vec::new() },
    };

    let porcelain = match git_stdout(&root, &["worktree", "list", "--porcelain"]) {
        Some(text) => text,
        None => {
            return WorktreesInfo {
                root: Some(root.to_string_lossy().into_owned()),
                worktrees: Vec::new(),
            }
        }
    };
    let mut worktrees = parse_porcelain(&porcelain);
    mark_current(&mut worktrees, &root);

    WorktreesInfo {
        root: Some(root.to_string_lossy().into_owned()),
        worktrees,
    }
}

/// Parse `git worktree list --porcelain` output into [`Worktree`] records.
///
/// Porcelain format is newline-separated key/value pairs per worktree, blank
/// line separated. Only the keys we care about are kept; the rest (`HEAD`,
/// `locked`, `prunable` …) is ignored.
fn parse_porcelain(porcelain: &str) -> Vec<Worktree> {
    let mut worktrees = Vec::new();
    for block in porcelain.split("\n\n") {
        let block = block.trim();
        if block.is_empty() {
            continue;
        }
        let mut wt = Worktree {
            path: String::new(),
            branch: None,
            bare: false,
            detached: false,
            current: false,
        };
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                wt.path = p.to_string();
            } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
                wt.branch = Some(b.to_string());
            } else if line == "bare" {
                wt.bare = true;
            } else if line == "detached" {
                wt.detached = true;
            }
        }
        if !wt.path.is_empty() {
            worktrees.push(wt);
        }
    }
    worktrees
}

/// Flag the worktree whose (canonical) path equals `current` — the worktree
/// the app was launched from. Comparison falls back to the raw path when
/// canonicalization fails (e.g. nonexistent paths in tests).
fn mark_current(worktrees: &mut [Worktree], current: &Path) {
    let canon_current = current.canonicalize().unwrap_or_else(|_| current.to_path_buf());
    for wt in worktrees.iter_mut() {
        let p = Path::new(&wt.path);
        let canon = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        if canon == canon_current {
            wt.current = true;
        }
    }
}

/// Create a worktree on a new branch `branch` in the repo containing `dir`.
///
/// When `path` is omitted the worktree lands in a sibling directory named
/// `<repo dir>-<branch>` (e.g. `~/proj/hiveField` → `~/proj/hiveField-feature`).
/// Returns the absolute path of the new worktree.
pub fn create(dir: &Path, branch: &str, path: Option<&str>) -> Result<PathBuf, String> {
    let root = repo_root(dir).ok_or_else(|| "not inside a git repository".to_string())?;
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("branch name must not be empty".to_string());
    }

    let target = match path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p.trim()),
        _ => {
            let parent = root
                .parent()
                .ok_or_else(|| "unable to resolve repository parent directory".to_string())?;
            let name = root
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("repo");
            parent.join(format!("{name}-{branch}"))
        }
    };

    let status = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["worktree", "add", "-b", branch])
        .arg(&target)
        .status()
        .map_err(|e| format!("failed to run git worktree add: {e}"))?;
    if !status.success() {
        return Err(format!("git worktree add failed for branch '{branch}'"));
    }
    Ok(target)
}

/// Remove the worktree at `path` from the repo containing `dir`.
///
/// Plain removal: a worktree with untracked or modified files is refused by
/// git, and that error is surfaced to the caller (the UI shows it). When
/// `force` is true, `git worktree remove --force` is used, which also deletes
/// the working tree — this is what auto-created throwaway session worktrees
/// get on close.
pub fn remove(dir: &Path, path: &str, force: bool) -> Result<(), String> {
    let root = repo_root(dir).ok_or_else(|| "not inside a git repository".to_string())?;
    if path.trim().is_empty() {
        return Err("worktree path must not be empty".to_string());
    }
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&root).arg("worktree").arg("remove");
    if force {
        cmd.arg("--force");
    }
    cmd.arg(path.trim());
    let status = cmd
        .status()
        .map_err(|e| format!("failed to run git worktree remove: {e}"))?;
    if !status.success() {
        return Err(format!("git worktree remove failed for '{path}'"));
    }
    Ok(())
}

/// A freshly auto-created throwaway worktree.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoWorktree {
    /// Absolute path of the new checkout.
    pub path: String,
    /// Branch it was checked out on (sanitized name + timestamp suffix).
    pub branch: String,
}

/// Create a throwaway worktree under `base_dir` on a fresh branch derived from
/// `name`.
///
/// `name` is sanitized into a valid git branch name (lowercased, invalid
/// characters collapsed to `-`, leading/trailing separators trimmed), then a
/// timestamp suffix is appended so repeated sessions never collide. The
/// checkout lands at `<base_dir>/<repo>-<sanitized>-<suffix>`; the returned
/// path is what a session should be spawned with as its `cwd`. If the branch
/// or directory already exists, a numeric counter is appended.
pub fn auto_create(dir: &Path, name: &str, base_dir: &str) -> Result<AutoWorktree, String> {
    let root = repo_root(dir).ok_or_else(|| "not inside a git repository".to_string())?;
    let base = sanitize_branch_name(name);
    let repo_name = root
        .file_name()
        .and_then(|n| n.to_str())
        .map(sanitize_branch_name)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "repo".to_string());

    let base_dir = expand_home(base_dir);
    fs::create_dir_all(&base_dir).map_err(|e| {
        format!(
            "failed to create worktree base dir '{}': {e}",
            base_dir.display()
        )
    })?;

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Find a branch + directory pair that does not collide yet. Branch names
    // and paths live in different namespaces, so both must be checked.
    let mut counter: u64 = 0;
    let (branch, path) = loop {
        let suffix = if counter == 0 {
            ts.to_string()
        } else {
            format!("{ts}-{counter}")
        };
        let branch = format!("{base}-{suffix}");
        let path = base_dir.join(format!("{repo_name}-{base}-{suffix}"));
        let branch_taken = git_stdout(
            &root,
            &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")],
        )
        .is_some();
        if !branch_taken && !path.exists() {
            break (branch, path);
        }
        counter += 1;
    };

    let status = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["worktree", "add", "-b", &branch])
        .arg(&path)
        .status()
        .map_err(|e| format!("failed to run git worktree add: {e}"))?;
    if !status.success() {
        return Err(format!("git worktree add failed for branch '{branch}'"));
    }
    Ok(AutoWorktree {
        path: path.to_string_lossy().into_owned(),
        branch,
    })
}

/// Turn an arbitrary session name into a valid, normalized git branch name.
///
/// Lowercases the input, collapses any run of characters that are not
/// `[a-z0-9._-]` into a single `-`, trims leading/trailing separators and
/// dots, and neutralizes `..`. Falls back to `"worktree"` when nothing usable
/// remains.
fn sanitize_branch_name(raw: &str) -> String {
    let mut out = String::new();
    let mut prev_sep = false;
    for ch in raw.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            out.push(ch);
            prev_sep = ch == '-' || ch == '.';
        } else if !prev_sep {
            // Runs of separators collapse into a single '-'; a leading run is
            // dropped entirely.
            if !out.is_empty() {
                out.push('-');
            }
            prev_sep = true;
        }
    }
    let mut out = out.trim_start_matches(['-', '.']).to_string();
    while out.ends_with('-') || out.ends_with('.') {
        out.pop();
    }
    // Git treats `..` as a range operator in some contexts — neutralize it.
    let out = out.replace("..", "-");
    if out.is_empty() {
        "worktree".to_string()
    } else {
        out
    }
}

/// Expand a leading `~` in a configured base dir to the user's home directory.
fn expand_home(path: &str) -> PathBuf {
    let trimmed = path.trim();
    let home = || {
        if cfg!(windows) {
            std::env::var("USERPROFILE")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("."))
        } else {
            std::env::var("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("."))
        }
    };
    if trimmed == "~" {
        return home();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return home().join(rest);
    }
    PathBuf::from(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_porcelain_two_worktrees() {
        let porcelain = "\
worktree /home/u/proj/hiveField
HEAD 0123456789abcdef0123456789abcdef01234567
branch refs/heads/master

worktree /home/u/proj/hiveField-feature
HEAD 89abcdef0123456789abcdef0123456789abcdef
branch refs/heads/feature/x
";
        let wts = parse_porcelain(porcelain);
        assert_eq!(wts.len(), 2);
        assert_eq!(wts[0].path, "/home/u/proj/hiveField");
        assert_eq!(wts[0].branch.as_deref(), Some("master"));
        assert!(!wts[0].bare && !wts[0].detached && !wts[0].current);
        assert_eq!(wts[1].branch.as_deref(), Some("feature/x"));
    }

    #[test]
    fn parse_porcelain_detached() {
        let porcelain = "\
worktree /home/u/proj/hiveField
HEAD 0123456789abcdef0123456789abcdef01234567
detached
";
        let wts = parse_porcelain(porcelain);
        assert_eq!(wts.len(), 1);
        assert!(wts[0].detached, "detached worktree should be flagged");
        assert!(wts[0].branch.is_none());
    }

    #[test]
    fn parse_porcelain_bare_main_worktree() {
        let porcelain = "\
worktree /srv/git/hiveField.git
bare
";
        let wts = parse_porcelain(porcelain);
        assert_eq!(wts.len(), 1);
        assert!(wts[0].bare, "bare worktree should be flagged");
        assert!(wts[0].branch.is_none());
    }

    #[test]
    fn parse_porcelain_empty_or_whitespace() {
        assert!(parse_porcelain("").is_empty());
        assert!(parse_porcelain("   \n\n ").is_empty());
    }

    #[test]
    fn parse_porcelain_ignores_unknown_keys() {
        let porcelain = "\
worktree /home/u/proj/hiveField
HEAD 0123456789abcdef0123456789abcdef01234567
branch refs/heads/master
locked
prunable gitdir file
";
        let wts = parse_porcelain(porcelain);
        assert_eq!(wts.len(), 1);
        assert_eq!(wts[0].branch.as_deref(), Some("master"));
    }

    #[test]
    fn parse_porcelain_skips_empty_block_lines() {
        // A trailing blank line must not yield a bogus empty worktree.
        let porcelain = "worktree /a/b\nbranch refs/heads/main\n\n\n";
        let wts = parse_porcelain(porcelain);
        assert_eq!(wts.len(), 1);
        assert_eq!(wts[0].path, "/a/b");
    }

    #[test]
    fn mark_current_matches_by_canonical_path() {
        // Nonexistent fixture paths: falls back to raw-path comparison.
        let mut wts = parse_porcelain(
            "worktree /home/u/proj/hiveField\nbranch refs/heads/master\n\n\
             worktree /home/u/proj/hiveField-feature\nbranch refs/heads/feature\n",
        );
        mark_current(&mut wts, Path::new("/home/u/proj/hiveField"));
        assert!(wts[0].current, "first worktree is the launch-dir one");
        assert!(!wts[1].current);
    }

    // ---- parse_numstat ----

    #[test]
    fn numstat_counts_changed_files_and_lines() {
        let numstat = "42\t7\tsrc/main.rs\n1\t1\tREADME.md\n";
        let s = parse_numstat(numstat);
        assert_eq!(s.changed, 2);
        assert_eq!(s.insertions, 43);
        assert_eq!(s.deletions, 8);
    }

    #[test]
    fn numstat_handles_binary_files_as_zero_lines() {
        let numstat = "-\t-\tassets/logo.png\n3\t0\tsrc/git.rs\n";
        let s = parse_numstat(numstat);
        assert_eq!(s.changed, 2);
        assert_eq!(s.insertions, 3);
        assert_eq!(s.deletions, 0);
    }

    #[test]
    fn numstat_empty_input_yields_zeroes() {
        let s = parse_numstat("");
        assert_eq!(s.changed, 0);
        assert_eq!(s.insertions, 0);
        assert_eq!(s.deletions, 0);
    }

    #[test]
    fn numstat_tolerates_malformed_lines() {
        // A line without a tab separator can't yield both counts, so it is
        // skipped rather than counted or panicking.
        let numstat = "garbage\n2\t3\tsrc/x.rs\n";
        let s = parse_numstat(numstat);
        assert_eq!(s.changed, 1);
        assert_eq!(s.insertions, 2);
        assert_eq!(s.deletions, 3);
    }

    // ---- sanitize_branch_name ----

    #[test]
    fn sanitize_replaces_separators_and_spaces() {
        assert_eq!(sanitize_branch_name("My Feature!"), "my-feature");
        assert_eq!(sanitize_branch_name("feature/x fix"), "feature-x-fix");
    }

    #[test]
    fn sanitize_collapses_and_trims_separator_runs() {
        assert_eq!(sanitize_branch_name("---  leading  ---"), "leading");
        assert_eq!(sanitize_branch_name("trailing---..."), "trailing");
        assert_eq!(sanitize_branch_name("a   b\tc"), "a-b-c");
    }

    #[test]
    fn sanitize_keeps_valid_branch_chars() {
        assert_eq!(sanitize_branch_name("FEATURE_x.y"), "feature_x.y");
        assert_eq!(sanitize_branch_name("fix-123"), "fix-123");
    }

    #[test]
    fn sanitize_neutralizes_dotdot_and_non_ascii() {
        assert_eq!(sanitize_branch_name("a..b"), "a-b");
        assert_eq!(sanitize_branch_name("Ünïcode"), "n-code");
    }

    #[test]
    fn sanitize_falls_back_when_empty() {
        assert_eq!(sanitize_branch_name(""), "worktree");
        assert_eq!(sanitize_branch_name("   "), "worktree");
        assert_eq!(sanitize_branch_name("---"), "worktree");
        assert_eq!(sanitize_branch_name("..."), "worktree");
    }

    #[test]
    fn sanitize_never_starts_or_ends_with_separator() {
        for name in ["-x-", ".x.", "x-", "x.", ".x", "x---", "x..."] {
            let out = sanitize_branch_name(name);
            assert!(!out.starts_with(['-', '.']), "{name:?} -> {out:?}");
            assert!(!out.ends_with(['-', '.']), "{name:?} -> {out:?}");
            assert!(!out.is_empty(), "{name:?} must fall back, not stay empty");
        }
    }

    // ---- GitCache (TTL caching of git queries) ----

    #[test]
    fn cache_serves_identical_results_for_non_git_dir() {
        let cache = GitCache::default();
        let dir = Path::new("/definitely/not/a/git/repo");
        let a = cache.cached_worktrees(dir);
        let b = cache.cached_worktrees(dir);
        assert_eq!(a.root, None);
        assert!(a.worktrees.is_empty());
        assert_eq!(a.root, b.root);
        assert_eq!(a.worktrees.len(), b.worktrees.len());
    }

    #[test]
    fn cache_diff_summary_is_none_for_non_git_dir() {
        let cache = GitCache::default();
        let dir = Path::new("/definitely/not/a/git/repo");
        assert_eq!(cache.cached_diff_summary(dir, dir, "HEAD"), None);
    }

    #[test]
    fn invalidate_clears_worktree_entries() {
        let cache = GitCache::default();
        let dir = Path::new("/definitely/not/a/git/repo");
        cache.cached_worktrees(dir);
        assert_eq!(cache.worktrees.lock_unpoisoned().len(), 1);
        cache.invalidate(dir);
        assert_eq!(cache.worktrees.lock_unpoisoned().len(), 0);
    }

    // ---- auto_create naming (no git involved) ----

    #[test]
    fn auto_create_candidate_names_are_sanitized_and_suffixed() {
        let base = sanitize_branch_name("My Feature");
        assert_eq!(base, "my-feature");
        // The branch is "<sanitized>-<ts>" and the dir embeds the repo name.
        let repo = sanitize_branch_name("hiveField");
        assert_eq!(repo, "hivefield");
        let dir = format!("{repo}-{base}-12345");
        assert_eq!(dir, "hivefield-my-feature-12345");
        assert_eq!(format!("{base}-12345"), "my-feature-12345");
    }
}
