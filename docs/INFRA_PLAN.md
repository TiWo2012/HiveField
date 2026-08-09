# Infrastructure Plan — hiveField Terminal

A prioritized backlog of **infrastructure** additions (as opposed to product
features — see `FEATURE_PLAN.md`). These are the tooling, CI, observability,
and supply-chain gaps an audit of the current tree found. Each item is
independent, lands as its own branch merged back to `dev` per `AGENTS.md`,
and names the concrete files it touches.

> **Status (audited 2026-08, HEAD `4c23894`):** all items are **unstarted**.
> This is a forward-looking backlog, not a changelog. Nothing here is
> required to ship features; it is the work that makes the project
> *maintainable and diagnosable* at scale.

Ordered roughly by impact-per-effort: **1 → 2 → 3** are cheap and fix real
gaps today; **4 → 7** harden CI and the release pipeline; **8 → 10** are
larger, deliberate investments.

---

## 1. Actually wire up logging + a panic hook (fixes a silent no-op)

**Problem.** The backend calls `log::info!` / `log::warn!` / `log::error!` in
~10 places (`lib.rs`, `pty.rs`, `updater.rs`, `dictation/*`), but **no logger
backend is initialized anywhere** — `log = "0.4"` is a dependency but no
`env_logger` / `fern` / `simple_logger` / `tauri-plugin-log` is present. Every
one of those calls is silently dropped today. There is also no panic hook, so
a panicking thread just aborts with zero trace in the log.

**Design.**
- Add `tauri-plugin-log` (preferred: it already targets the Tauri lifecycle,
  can forward to the OS log *and* a file, and exposes a JS API) or
  `env_logger` + a `fern`-style file appender. Either way:
  - Initialize in `src-tauri/src/main.rs` (`main()`) before `hivefield_lib::run()`.
  - Write to `<app_log_dir>/hivefield.log` (Tauri v2 provides `app.log_dir()`)
    with rotation, plus stderr in debug builds. Cap the file (e.g. 2 MB × 3
    rotated) so it can't grow unbounded.
  - Respect `RUST_LOG`/`HF_LOG` env for level control in dev.
- Add a `std::panic::set_hook` that logs the panic payload + backtrace to the
  same log file (and shows a native error dialog on release builds), so a
  crash is never silent.
- Make the existing `log::` call sites level-appropriate (they already are);
  no call-site churn needed.

**Changes.**
- `src-tauri/Cargo.toml` — logger dep (+ `tauri-plugin-log` if chosen).
- `src-tauri/src/main.rs` — logger init + panic hook.
- `README.md` — note where logs live (`hivefield --doctor` output, see #2).

**Verification.** Run the app, trigger a logged path (dictation error, failed
git call), confirm the line lands in the log file; panic a thread in a test
build and confirm the hook fires.

---

## 2. Diagnostics command (`hivefield --doctor` style)

**Problem.** Bug reports today lack environment context: OS/arch, app version,
install dir, launch dir, git presence, settings schema version, worktree base
dir, which dictation engine, log file path. Collecting it by hand is tedious
and error-prone.

**Design.**
- New IPC command `diagnostics()` returning a flat JSON blob: `CARGO_PKG_VERSION`,
  OS/arch, install dir (`updater::install_dir()`), launch cwd, whether the
  launch dir is a git repo + its root, `SETTINGS_SCHEMA_VERSION`, the resolved
  worktree base dir, active dictation engine, and the log file path from #1.
- Frontend: a palette action "Copy diagnostics" that invokes it and puts the
  formatted text on the clipboard (reuses `clipboard.ts`), so pasting a bug
  report is one keypress.
- Optional CLI: `hivefield --doctor` prints the same blob to stdout (a `main.rs`
  arg check before `run()`), for users who can't open the UI.

**Changes.**
- `src-tauri/src/lib.rs` — `diagnostics` command + registration.
- `src/diagnostics.ts` (new) + `src/palette-items.ts` — palette action.
- `src-tauri/src/main.rs` — `--doctor` arg handling (optional).

**Verification.** Palette → Copy diagnostics → paste shows complete context;
`hivefield --doctor` prints the same.

---

## 3. Lint + format gates in CI (cargo fmt/clippy, frontend lint)

**Problem.** CI runs `bun run build`, `tsc --noEmit`, `bun test`, `cargo test`
— but **no linters and no formatter check**. `cargo clippy` and `cargo fmt
--check` are the community standard for Rust; the frontend has no linter at
all (only `tsc`). Drift is already visible (`#[allow(dead_code)]` in
`net.rs`, several `unwrap_or_else(|_| …)` fallbacks that clippy would flag).

**Design.**
- `test.yml`:
  - Backend job: add `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings`
    steps (clippy after `cargo test` so the cache is warm).
  - Frontend job: add a linter. Smallest footprint: add
    [Biome](https://biomejs.dev) (single binary, zero config drift) with
    `biome check` covering `src/`; or eslint if the team prefers the
    ecosystem. Start with `warn`-free CI (`--error-on-warnings`).
- Fix whatever the new gates surface (e.g. drop the `#[allow(dead_code)]` by
  adding a caller or an `#[expect]`).

**Changes.**
- `.github/workflows/test.yml` — new steps.
- `biome.json` (or eslint config) — new config.
- Small code cleanups surfaced by the gates.

**Verification.** CI is green with the gates on; a deliberate fmt violation
fails the job.

---

## 4. Cross-platform test matrix + more release platforms

**Problem.** The README advertises Linux/macOS/Windows, but CI only runs on
`ubuntu-24.04`. Platform-specific code exists and is untested: `open_url`'s
`rundll32` path on Windows, `updater.rs`'s `LOCALAPPDATA` fallback, the macOS
`open` path, `Info.plist`. The release workflow builds **Linux only** —
`release.yml` publishes just `hivefield-linux-x86_64*` updater assets, so the
README's update story is Linux-only in practice despite the platform badge.

**Design.**
- `test.yml`: make the backend job a matrix over `ubuntu-24.04`,
  `macos-14` (arm64 runner), and `windows-latest`. The frontend job can stay
  Linux-only (pure TS, no platform code) — but running it on the matrix costs
  little.
- `release.yml`: add `macos-14` and `windows-latest` build jobs that publish
  `hivefield-macos-{arch}.tar.gz` / `hivefield-windows-{arch}.exe` updater
  assets alongside the Linux ones. Unsigned macOS builds are fine to start
  (users right-click-open); note the notarization/signing gap in the README.
  Add `aarch64` Linux if a runner is available (ubuntu-24.04-arm).
- Mind the sync contract: `updater.rs` `asset_name()` and `install.sh`
  `asset_candidates()` already anticipate these names — the workflow just
  needs to produce them.

**Changes.**
- `.github/workflows/test.yml` — matrix.
- `.github/workflows/release.yml` — new build jobs + artifact collection.
- `README.md` — honest platform-support matrix.

**Verification.** All three OSes run `cargo test`; a master push publishes
macOS/Windows updater assets whose names match `asset_name()`.

---

## 5. Supply-chain hardening: updater checksums + dependabot

**Problem.** Two gaps:
1. The updater (`updater.rs`) and `install.sh` download the release binary
   over HTTPS and install it **with no integrity check** — no SHA-256, no
   signature. A compromised GitHub account, a compromised mirror, or a
   TLS-interposing proxy would install arbitrary code with the user's
   privileges.
2. There is no `dependabot.yml`, so `github-actions`, `bun.lock`, and
   `Cargo.lock` dependencies are never reviewed for updates.

**Design.**
- Publish a `checksums.txt` (SHA-256 per asset, `sha256sum` format) from
  `release.yml`, attached to the release alongside the binaries.
- `updater.rs` / `install.sh`: after download, fetch the release's
  `checksums.txt`, verify the asset's digest, and refuse to install on
  mismatch. Both already share the asset-name contract, so the checksum
  contract must too (single source of truth in the workflow).
- `.github/dependabot.yml`: weekly PRs for `github-actions`, `npm` (bun
  lockfile is npm-compatible for dependabot), and `cargo`. Configure
  `open-pull-requests-limit` and group minor/patch bumps.

**Changes.**
- `.github/workflows/release.yml` — checksum generation + attach.
- `src-tauri/src/updater.rs`, `install.sh` — verification step.
- `.github/dependabot.yml` — new file.

**Verification.** A release without a matching checksum fails to install;
dependabot opens its first batch of update PRs.

---

## 6. Version single-source + sync check

**Problem.** The app version lives in **three places** that must agree:
`package.json` (`0.1.1`), `src-tauri/Cargo.toml` (`0.1.1`), and
`src-tauri/tauri.conf.json` (`0.1.1`). `release.yml` reads it from
`tauri.conf.json`; nothing enforces the others match, and bumping is manual.

**Design.**
- Add a `scripts/bump-version.ts` (bun script) that takes a new version and
  rewrites all three files (Cargo.toml's `version`, tauri.conf.json's
  `version`, package.json's `version`) — the single blessed way to bump.
- Add a CI check in `test.yml` (frontend job): parse all three versions and
  fail when they differ. Cheap guard, prevents tag/release drift.
- Wire `bun run bump <version>` as a package.json script.

**Changes.**
- `scripts/bump-version.ts` (new), `package.json`.
- `.github/workflows/test.yml` — version-agreement step.

**Verification.** `bun run bump 0.2.0` leaves all three files at `0.2.0`; CI
fails if someone hand-edits one file out of sync.

---

## 7. Release workflow: manual trigger + reusable artifact check

**Problem.** `release.yml` only fires on `master` push. There is no
`workflow_dispatch`, so a maintainer can't cut a release without pushing a
commit, and there's no way to test the pipeline end-to-end without a real
tag. Release notes are boilerplate text — the changelog from commits is
discarded.

**Design.**
- Add `workflow_dispatch` to `release.yml` (optionally with a `version`
  input that runs `bump-version` first, or a `dry-run` input that skips the
  `action-gh-release` step).
- Generate the release body from commits since the last tag with
  `git-cliff` (or a simple `git log --oneline` between tags) instead of the
  hardcoded boilerplate.
- Optionally: a nightly/periodic `workflow_dispatch`-only "smoke release"
  on a fork repo to validate the pipeline.

**Changes.**
- `.github/workflows/release.yml` — triggers, body generation.
- `scripts/bump-version.ts` (from #6) — called when a version input is given.

**Verification.** A `workflow_dispatch` run with `dry-run: true` builds all
assets and skips publishing; a real run's release body lists the commits.

---

## 8. Coverage reporting with a CI gate

**Problem.** `bun test` and `cargo test` run, but there is no coverage
measurement — the repo can't see which modules are untested, and the
"improve test coverage" todo can't be tracked. Rough count: ~15 of ~40
frontend modules have no test file at all (`sessions.ts`, `sidebar.ts`,
`palette.ts`, `search.ts`, `workspace.ts`, `terminal.ts`, `dnd.ts`, `menus.ts`,
`keyboard.ts`, `listeners.ts`, `splash.ts`, `titles.ts`, `dictation.ts`,
`bell.ts`, `status-bar.ts`, `settings-ui.ts`, `updater.ts`, `windows.ts`,
`git-toast.ts`, `modal.ts`, `main.ts`).

**Design.**
- Rust: `cargo llvm-cov` (or `cargo-tarpaulin`) as a CI job uploading to
  Codecov/coveralls; gate at a floor (e.g. never below the current % minus
  slack) rather than an absolute target, so it ratchets up.
- Frontend: `bun test --coverage` (bun has built-in coverage via `--coverage`)
  in the frontend CI job.
- Use the numbers to drive new tests for the untested modules, prioritizing
  ones with real logic (sessions, workspace, sidebar, search, terminal).

**Changes.**
- `.github/workflows/test.yml` — coverage jobs.
- New test files for the untested modules (separate branch per module, per
  the repo's unit-of-work convention).

**Verification.** Coverage % visible in CI; the gate fails on regression
below the floor.

---

## 9. Security posture: CSP + IPC path scoping

**Problem.** Two hardening items:
1. `tauri.conf.json` has `"csp": null` — no Content-Security-Policy. The app
   loads only local content, so risk is low, but a strict CSP is the
   documented Tauri default posture and costs nothing for this app (no remote
   scripts; fonts are local/system).
2. `file_read` / `file_write` take **arbitrary paths from the webview**. Today
   the webview is trusted (no remote content), but these are the two commands
   a future XSS/compromised-webview bug would weaponize. Worth scoping while
   the surface is small.

**Design.**
- Set `"csp": "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src
  'self' data:"` (verify what xterm/dockview inline styles need; the
  `'unsafe-inline'` for styles is likely required for xterm.js).
- Scope `file_read`/`file_write`: either restrict to the launch directory +
  worktree base dir + settings dir, or move to the frontend having to pass a
  capability token the backend minted per allowed path. Simplest safe version:
  resolve the path and reject unless it's inside one of the known roots.
- Re-check `capabilities/default.json` permissions while touching security.

**Changes.**
- `src-tauri/tauri.conf.json` — CSP.
- `src-tauri/src/lib.rs` — path-scoping guard on `file_read`/`file_write`
  (+ tests).

**Verification.** App renders identically under the CSP; reading/writing
outside the allowed roots returns an error; unit tests cover the guard.

---

## 10. Dev-experience glue: pre-commit hook, editorconfig, changelog

**Problem.** `AGENTS.md` *mandates* running `bun run build`, `tsc`, and
`cargo test` before every commit, but nothing enforces it for human
contributors; there is no `.editorconfig`, so editor settings (indent, EOL)
drift; there is no `CHANGELOG.md` at all.

**Design.**
- A small `scripts/pre-commit` (shell) that runs the three checks and is
  installed via `bun run setup` (`git config core.hooksPath .githooks`), so
  the repo doesn't need husky. Keep it fast (skip the cargo build when the
  `--no-verify` flag is used, which the hook can't see — document that).
- `.editorconfig` — 2-space TS, 4-space Rust, LF endings.
- `CHANGELOG.md` generated by the #7 release flow (git-cliff), checked in
  with each release.

**Changes.**
- `.githooks/pre-commit`, `scripts/setup.ts` (or extend package.json scripts).
- `.editorconfig` (new), `CHANGELOG.md` (new).

**Verification.** `bun run setup` installs the hook; a commit with a tsc
error is blocked; editors pick up the editorconfig.

---

## Sequencing

1. **Logging + panic hook (1)** — small, fixes a real silent no-op; unblocks
   everything else's diagnosability.
2. **Diagnostics (2)** — builds on the log path from (1).
3. **Lint/format gates (3)** — mechanical; cleans the tree before larger work.
4. **Version single-source (6)** — prerequisite for a clean release flow.
5. **Release workflow triggers + changelog (7)** — uses (6).
6. **Updater checksums + dependabot (5)** — supply chain; independent.
7. **Cross-platform matrix + release platforms (4)** — larger; pairs with (5)
   (new platforms publish checksums from day one).
8. **Coverage (8)** — ongoing, ratcheting.
9. **CSP + path scoping (9)** — security; independent, can land anytime.
10. **DX glue (10)** — nice-to-have; slots anywhere.

## Non-goals (explicitly out of scope)

- Crash-reporting *services* (Sentry etc.) — self-hosted log files first;
  a hosted crash reporter can be layered on later.
- Telemetry/analytics of any kind (usage data collection).
- Code signing / notarization setup (macOS/Windows) — noted as a gap, but
  setting up certs is org-level, not repo-level.
- Migrating the frontend off `bun` or the backend off `tauri` — tooling
  changes only.
