# Changelog

All notable changes to hiveField Terminal are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Release builds also carry a build number (for example `v0.1.2-build.11`), which
is part of the release tag rather than the app version.

## [Unreleased]

### Added

- Open Directory (`Ctrl+Shift+O` and **File → Open Directory…**) to start a
  session in a chosen folder.
- Cross-platform CI: tests on Linux, macOS, and Windows, with release
  executables and launcher entries for every platform (`.desktop` entry on
  Linux, Start Menu on Windows, Launchpad on macOS).
- `CHANGELOG.md` and `.editorconfig` to keep release notes and editor settings
  consistent.

### Fixed

- Windows test binaries now embed and link the app manifest, fixing
  `STATUS_ENTRYPOINT_NOT_FOUND` at startup.
- Output from busy terminals no longer floods the UI when many sessions stream
  at once. PTY reads are coalesced into short batches before crossing into the
  webview, the sidebar re-renders at most once per frame, unchanged tab titles
  no longer trigger a full re-render, and per-tab quiet timers are no longer
  re-armed for every output chunk.

## [0.1.2] - 2026-08-09

### Added

- Configurable default agent (**Settings → Agents**), including an option to
  open no agent.
- Built-in updater that checks GitHub releases, shows the release changelog,
  and installs the latest build with a progress bar.
- `hivefield --doctor` diagnostics command and a **Copy diagnostics** command
  palette entry.
- Keybinding search in Settings and the command palette.
- Tab cycling with `Ctrl+Tab` / `Ctrl+Shift+Tab`.
- Fullscreen a split or tab with `Ctrl+F`.
- Pane maximize/zoom with `Ctrl+Shift+M`.
- Custom `todo.txt` renderer with live refresh when the file changes.
- Search-copy-paste improvements, configurable prompt snippets, and pane
  layouts that persist per project.
- Built-in dictation, with cloud dictation as the default engine and local
  Whisper support as an optional feature.

### Changed

- Terminal rendering moved back to xterm.js after the ghostty canvas
  experiment.
- Version is now single-sourced across `package.json`, `Cargo.toml`, and
  `tauri.conf.json`.

### Fixed

- The updater no longer reports a spurious update when only the build number
  differs.
- Sending a task or selection now targets the newly created agent session
  instead of a stale one.
- Numerous terminal rendering, PTY sizing, focus, and paste issues.
- Settings schema is versioned so existing settings are no longer silently
  corrupted.

## [0.1.1] - 2026-08-09

### Added

- Initial public release: tabbed, split-pane terminal with sessions running
  `$SHELL` in a PTY, isolated git worktrees for coding agents, workspace
  persistence, themes, search, notifications, and drag & drop.
- Support for launching coding agents (opencode, pi, Codex, Claude Code,
  Gemini CLI, Aider, Cursor, Cody, and others).
- Linux, macOS, and Windows installation via `install.sh` / `install.ps1`.

### Changed

- Frontend decomposed from a single `main.ts` monolith into feature modules,
  with tests and documentation drift guards.

## [0.1.0] - 2026-08-06

### Added

- First tagged build of hiveField Terminal.

[Unreleased]: https://github.com/TiWo2012/HiveField/compare/v0.1.2-build.11...dev
[0.1.2]: https://github.com/TiWo2012/HiveField/compare/v0.1.1-build.10...v0.1.2-build.11
[0.1.1]: https://github.com/TiWo2012/HiveField/compare/v0.1.0-build.7...v0.1.1-build.10
[0.1.0]: https://github.com/TiWo2012/HiveField/releases/tag/v0.1.0-build.3
