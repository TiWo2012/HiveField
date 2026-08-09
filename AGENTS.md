# Agent Instructions

## Hard rule: always commit before finishing

Every time you finish a unit of work — a feature, a fix, a refactor, or even
an attempt that didn't pan out — you **must** leave the working tree with a
commit. Do not end a session with uncommitted changes.

**Commit even when the work is incomplete or broken.** Uncommitted work is
effectively lost: it's invisible to everyone else, and a stray checkout or
worktree cleanup can destroy it. A checkpoint commit protects the work and
lets you (or another agent) pick it up later.

### If the feature is incomplete

1. Do not hold the commit waiting for the feature to finish.
2. Commit what you have as soon as it builds, with a message that says exactly
   what works, what doesn't, and why.
3. Mark the commit clearly as incomplete so nobody mistakes it for done:
   - Prefix the subject with `wip:` (e.g. `wip: add sync-input broadcast`), or
   - Add a `WIP:` / status note in the body, e.g.:

     ```
     Add broadcast input to all panes

     WIP: input goes to every session; the toggle shortcut is not wired up
     yet and panes started before enabling don't join the broadcast.
     ```
4. Leave a clear trail in the body: the current state, what is known to be
   broken, and what the next step should be.

### Commit hygiene

- Stage only the files you intend to commit. Never commit secrets, build
  output (`dist/`, `target/`, `node_modules/`), or editor/agent config.
- Follow the repo's commit style: imperative, capitalized subject line, with a
  short body explaining the what and why.
- If a commit fails or a hook rejects it, fix the issue and make a new commit —
  do not amend a failed commit.
- A `wip:` commit can be amended, split, or replaced later once the work is
  finished. Prefer leaving an honestly labeled `wip:` commit over silently
  rewriting history mid-task.
- Run the relevant checks before committing (`bun run build`, `tsc`, and
  `cargo test` in `src-tauri/`) so the checkpoint is as green as possible —
  but when a fix is still in progress, an explicit `wip:` commit that fails
  checks is still better than leaving the work uncommitted.

## Hard rule: merge as soon as a feature is done

Do not let finished work sit on a side branch. The moment a unit of work — a
feature, a fix, or a refactor — is complete and committed, force-merge it
back to `dev` right away. A feature that is "done but not merged" is
effectively still undone: nobody can use it, and it rots on the branch.

- Merge as soon as the feature is done. Do not batch several finished features
  and merge them in one go — merge each one when it lands.
- Before merging, run the relevant checks on the branch (`bun run build`,
  `tsc`, and `cargo test` in `src-tauri/`) so `dev` stays green.
- Always merge into `dev` directly with `git merge` — do not let conflicts or
  drift block the merge. Force the merge through; if a fast-forward isn't
  possible, use a merge commit. Do not leave the branch unmerged.
- After merging, remove the worktree and its branch so the session leaves no
  stray branches behind.
- If a feature is genuinely broken or incomplete, do not merge it; leave it as
  a `wip:` commit (see above) and say so in your summary instead.
