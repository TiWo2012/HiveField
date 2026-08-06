//! Git worktree integration.
//!
//! Provides discovery, creation, and removal of git worktrees for the repo the
//! app was launched from. Everything shells out to the `git` binary — there are
//! no extra crates. All discovery is best-effort: a launch directory that is
//! not inside a git repository yields an empty worktree list rather than an
//! error, so the UI can render nothing and no one has to special-case it.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

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
/// git, and that error is surfaced to the caller (the UI shows it).
pub fn remove(dir: &Path, path: &str) -> Result<(), String> {
    let root = repo_root(dir).ok_or_else(|| "not inside a git repository".to_string())?;
    if path.trim().is_empty() {
        return Err("worktree path must not be empty".to_string());
    }
    let status = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["worktree", "remove"])
        .arg(path.trim())
        .status()
        .map_err(|e| format!("failed to run git worktree remove: {e}"))?;
    if !status.success() {
        return Err(format!("git worktree remove failed for '{path}'"));
    }
    Ok(())
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
}
