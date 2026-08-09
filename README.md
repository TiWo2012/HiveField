# hiveField Terminal

A desktop terminal built with **Tauri v2** (Rust) and **xterm.js**, designed
for coding-agent workflows. Every session runs your real `$SHELL` in a PTY,
with first-class support for launching coding agents (opencode, pi, Codex,
Claude Code, Gemini CLI, Aider, Cursor, Cody, and more) in isolated git
worktrees — all inside a tabbed, split-pane interface.

[![CI](https://github.com/TiWo2012/HiveField/actions/workflows/test.yml/badge.svg)](https://github.com/TiWo2012/HiveField/actions/workflows/test.yml)
[![Platforms](https://img.shields.io/badge/platform-linux%20%7C%20macos%20%7C%20windows-blue)](#installation)

---

## Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
  - [Linux](#linux)
  - [macOS](#macos)
  - [Windows](#windows)
- [Features](#features)
  - [Sessions & Agents](#sessions--agents)
  - [Tabs, Splits & Navigation](#tabs-splits--navigation)
  - [Workspaces & Persistence](#workspaces--persistence)
  - [Sidebar & Session Info](#sidebar--session-info)
  - [Multiple Windows](#multiple-windows)
  - [Search, Copy & Paste](#search-copy--paste)
  - [Notifications & Terminal Bell](#notifications--terminal-bell)
  - [Appearance & Themes](#appearance--themes)
  - [Prompt Snippets](#prompt-snippets)
  - [Drag & Drop](#drag--drop)
  - [Dictation](#dictation)
  - [Keybindings](#keybindings)
  - [Configuration](#configuration)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Development](#development)
- [Build a Release](#build-a-release)
- [Updating](#updating)
- [IPC Contract](#ipc-contract)
- [Contributing](#contributing)
- [License](#license)

---

## Quick Start

Download the latest release from the [releases page](https://github.com/TiWo2012/HiveField/releases)
and launch it from your project directory:

```sh
cd my-project
hivefield
```

It opens in that directory and remembers your layout per project — the next
time you launch from `my-project`, your tabs and splits are restored.

To open a new window for a different project, press `Ctrl+Shift+N` or use
**File → New Window**.

---

## Installation

hiveField ships prebuilt binaries for **Linux**, **macOS**, and **Windows**
(every release is built by CI and tested on all three OSes). Choose your
platform:

### Linux

```sh
curl -fsSL https://raw.githubusercontent.com/TiWo2012/HiveField/master/install.sh | sh
```

The script downloads the latest release, installs `hivefield` to
`~/.local/bin` (or `$HF_INSTALL_DIR`), and prints a PATH hint when needed.
`.deb`, `.rpm`, and AppImage packages are also attached to each
[release](https://github.com/TiWo2012/HiveField/releases).

### macOS

The same installer works on macOS — both Intel (`x86_64`) and Apple Silicon
(`aarch64`) — it detects your architecture automatically:

```sh
curl -fsSL https://raw.githubusercontent.com/TiWo2012/HiveField/master/install.sh | sh
```

This installs the `hivefield` CLI to `~/.local/bin`. Prefer a GUI app?
Download the `.dmg` (drag `hiveField Terminal.app` into Applications) or the
`.app` zip from the [releases page](https://github.com/TiWo2012/HiveField/releases).

> **Note:** macOS binaries are currently **unsigned and not notarized**.
> The first time you launch the app, right-click it and choose **Open**
> (Gatekeeper), or run the raw binary from a terminal.

### Windows

Install from **PowerShell** (no git clone needed):

```powershell
irm https://raw.githubusercontent.com/TiWo2012/HiveField/master/install.ps1 | iex
```

The script downloads the latest release, installs `hivefield.exe` to
`%LOCALAPPDATA%\hivefield\bin`, and adds that directory to your **user PATH**
so `hivefield` works from any terminal. Open a new terminal afterwards for the
PATH change to take effect.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HF_VERSION` | latest release | Pin a release tag, e.g. `v0.2.0` |
| `HF_INSTALL_DIR` | `%LOCALAPPDATA%\hivefield\bin` | Install elsewhere |
| `HF_NO_PATH` | unset | Set to `1` to skip the PATH update |

Prefer an installer? Grab the **NSIS setup** (`.exe`) or **MSI** package from
the [releases page](https://github.com/TiWo2012/HiveField/releases); the
installer ensures WebView2 is present if missing.

> **Note:** Windows binaries are unsigned; SmartScreen may show a warning —
> choose **More info → Run anyway**.

---

## Features

### Sessions & Agents

- **Real PTY sessions** — your default `$SHELL` runs in a PTY, one per tab/pane
- **Coding-agent launcher** — drag an agent from the sidebar into the terminal
  area to open it as a split; `Ctrl+Shift+T` opens an agent as a tab
- **Built-in agents** — opencode, pi, Codex, GitHub Copilot, Claude Code,
  Gemini CLI, Aider, Cursor, Amp, Qwen Code, Goose, Crush, Cody, OpenHands,
  an Editor mode that runs `$EDITOR`, and a todotxt mode for task management
- **Raw shell sessions** — plain terminal with no agent auto-run, always available
- **Custom agents** — define your own in **Settings → Agents** with a name and
  full command line (e.g. `opencode --model gpt-5`); they appear in the
  sidebar, palette, and context menu just like built-ins
- **Isolated worktrees** — every agent session gets its own throwaway git
  worktree under the **Worktree base dir** setting (default `/tmp`), so
  parallel agents never share a checkout. Raw terms and the Editor agent run
  in the launch directory instead. Closing a tab force-deletes the worktree
- **Editor agent** — `$EDITOR` resolved at spawn (honors `.bashrc`/`.zshrc`
  profiles, falls back to `vi`/`notepad`), and runs in the launch directory
  so edited files are never swallowed by a throwaway worktree
- **todotxt agent** — opens `todo.txt` in the resolved editor for task
  management. Select a task and right-click → "Send selection to" to
  delegate it to any coding agent

### Tabs, Splits & Navigation

- **Tabbed & split-pane interface** via [dockview](https://dockview.dev)
- `Ctrl+Shift+T` — new terminal tab
- **Drag a tab** out of the tab bar to split it into its own pane group
- **Drag tabs between groups**, drag splitter handles to resize
- `Ctrl+H` / `Ctrl+J` / `Ctrl+K` / `Ctrl+L` — move focus left/down/up/right
  (vim-style); if no pane exists in that direction the key passes through to
  the shell (so `Ctrl+L` still clears the screen)
- `Ctrl+Tab` / `Ctrl+Shift+Tab` — cycle to the next/previous tab (panel) in
  the workspace, wrapping around; panels cycle in layout order (group by
  group, then left to right within a group)
- `Ctrl+F` — **fullscreen** the active split or tab: its group fills the whole
  terminal area (other splits/tabs hide); press again to restore the layout
- Every pane auto-resizes its PTY (`cols`/`rows` stay in sync)
- `Ctrl+Shift+W` (or the tab ✕) closes the active panel and kills its shell
- **Double-click a tab** (or `Ctrl+Shift+R`) to rename it; a custom name is
  never overwritten by program/OSC titles. Clearing the name reverts to
  automatic titles
- **Tab activity indicators** — a background tab whose session prints output
  gets a `●` prefix, flipping to `✓` once output goes quiet. Switching to the
  tab clears the indicator

### Workspaces & Persistence

- **Per-directory workspace restore** — the tab/split layout is saved per
  launch directory and restored the next time you start hiveField from that
  directory. A wiped layout falls back to a fresh session
- **Ten workspace slots** (`Ctrl+1`…`Ctrl+9`, `Ctrl+0`) — keep up to ten
  independent layouts per launch directory. Switching slots saves the current
  layout and restores the target slot's layout
- **Background sessions** — sessions in hidden slots keep running; their agents
  continue working and terminals retain scrollback. Switching back re-attaches
  them exactly as you left them. A finished background agent fires the usual
  completion notification
- **Splash screen** — every launch shows a welcome screen with:
  - **Continue latest** — resumes the saved layout for this directory
  - Quick-start session buttons for the current directory
  - **Recent projects** — every directory with a saved workspace, sorted by
    most recently opened
  - Click a project to open the default agent there; ✕ forgets a project
  - Drop a folder anywhere to dismiss the splash and continue
- **Default agent** (Settings → Agents) — the session that auto-opens on a
  fresh start (splash Skip / Continue with no saved layout), for the **New
  agent tab** shortcut (`Ctrl+Shift+T`), and when opening a recent project.
  Pick any built-in or custom agent, the raw shell, or **Nothing** to start
  with an empty workspace and choose a session yourself
- **Workspaces sidebar** — shows every non-empty workspace slot (active
  highlighted, green dot for saved layouts); click to switch, double-click to
  rename. A workspace that is completely empty — no open panels and no
  user-assigned name — goes away: it vanishes from the sidebar and command
  palette, its saved layout is dropped from disk, and pressing its digit
  again starts a fresh workspace there. Naming a workspace keeps it around
  even when all its panels are closed

### Sidebar & Session Info

- **Agent palette** — drag an agent or raw term into the terminal area to spawn
  it as a split (drop near an edge for split direction, middle for right-split)
- **Running sessions** — every open session listed with mode icon, tab title,
  working directory, and status glyph (active / `●` producing output / `✓`
  finished). Click to focus, hover to close
- **Workspace info** — shows the launch directory, git branch, number of repo
  worktrees, and open session count
- **Keyboard shortcut reminders** at the bottom of the sidebar
- **Right-click context menu** — right-click a terminal pane for a styled,
  keyboard-navigable menu: New session (every agent + raw term), New split
  (all four directions relative to the clicked pane), Copy/Paste, Find,
  Rename tab, and Close panel. Right-click a tab for split/rename/close.
  `↑`/`↓` navigate, `→`/`Enter` open, `←`/`Esc` go back
- **Command palette** (`Ctrl+Shift+P`) — fuzzy-find over every open pane and
  common actions (new agent/raw tab or split, find, focus panes, rename,
  close, send SIGINT to all panes, close all panes, settings). Live match
  highlighting, `↑`/`↓` or `Ctrl+P`/`Ctrl+N` to move, `Enter` to run, `Esc`
  to close

### Multiple Windows

- `Ctrl+Shift+N` (also **File → New Window** and the command palette) opens a
  new app window
- Every window is fully independent: its own tabs/splits, sessions, workspace
  slots, and saved layout
- A new window opens in the same launch directory as the one that created it
- Each window's workspace is keyed by its own directory — run several projects
  side by side
- Closing a window ends the sessions it spawned

### Search, Copy & Paste

- **Terminal search** (`Ctrl+Shift+F`) — searches the current pane's
  scrollback. Matches highlight live as you type; `Enter`/`Shift+Enter` jump
  next/previous match, `Alt+C` toggles case sensitivity, `Esc` closes.
  Match counter shows `current/total` and turns red on no matches
- **Copy** (`Ctrl+Shift+C`) — copies the active terminal's selection to the
  system clipboard. Falls through when nothing is selected, so it never
  clobbers `Ctrl+C`'s SIGINT
- **Paste** (`Ctrl+Shift+V`) — pastes the clipboard into the active terminal
  (bracketed-paste aware)
- `Ctrl+V`/`Ctrl+C` keep their native webview behavior
- **Hyperlinks** — URLs in output are underlined; `Ctrl+click` (Cmd+click on
  macOS) opens them in your system browser. Hover shows a hint tooltip

### Notifications & Terminal Bell

- **Agent-done notifications** — when a background agent finishes (or the
  window is unfocused), hiveField fires a desktop notification and/or an ntfy
  push notification (configurable in Settings)
- **ntfy push** — supports a custom server (default `https://ntfy.sh`), topic,
  and optional access-token auth. A "Test" button in Settings verifies each
  channel
- **Terminal bell** — when a session prints the BEL character, hiveField plays
  a synthesized bell tone (Web Audio, no audio files) and optionally raises a
  desktop notification naming the ringing tab. Both halves are togglable in
  **Settings → Terminal bell**. Notification bursts (e.g. `echo -e '\a\a\a'`)
  are throttled to one per few seconds

### Appearance & Themes

- **Color themes** — Catppuccin Mocha/Latte, Nord, Dracula, Monokai, One Dark,
  Gruvbox, Solarized Light, GitHub Dark/Light, and Abyss. Drives both the
  terminal palette and window chrome (sidebar, tabs, modals, search bar)
- **Background opacity** — below 1 makes the terminal translucent with a
  backdrop blur (requires a compositor with transparent window support)
- **Font** — configurable family, size, weight, line height, letter spacing
- **Font ligatures** — DOM renderer merges cells into spans with the `calt`
  OpenType feature enabled, so programming fonts (Fira Code, Maple Mono,
  JetBrains Mono, etc.) render `->`, `=>`, `!=` as joined glyphs. Toggle in
  Settings
- **Font-size zoom** — `Ctrl+=`/`Ctrl+-` adjust live (persisted); `Ctrl+0`
  resets to the configured default
- **Cursor blink** (on by default, toggle in Settings)
- Full **Unicode / UTF-8** support — incremental UTF-8 decoding on the Rust
  side, xterm.js Unicode 11 on the UI

### Prompt Snippets

- `Ctrl+Shift+P` → **Insert prompt…** opens a picker of named prompt snippets
- Picking one pastes its text into the active terminal (bracketed-paste aware)
- Ships with defaults (explain code, review changes, write/fix tests, debug,
  summarize changes) — all editable in **Settings → Snippets**
- Add, edit, and remove your own snippets; persisted in `settings.json`

### Drag & Drop

- **File/folder drop** — drop from your file manager onto a terminal pane. The
  pane lights up with a *release to insert path* hint, and paths are
  shell-quoted (single quotes with `'\''` escaping) at the cursor. Drops that
  miss every pane go to the active session
- **Splash screen drop** — dropping a folder anywhere dismisses the splash and
  continues (the folder lands in the resumed shell, or becomes the session
  directory when nothing is saved here)

### Dictation

- Built-in dictation support with selectable engine (Whisper, Vosk, or cloud)
- Configurable microphone selection in Settings

### Keybindings

- Every keyboard shortcut is rebindable in **Settings → Keybinds** — click a
  binding and press the new keys, `Backspace` unbinds, `Esc` cancels
- **Search keybindings** — the Keybinds tab has a live filter: type any part of
  an action name, group, or key combo (`ctrl t` finds `Ctrl+Shift+T`).
  **Command palette → Keybindings…** jumps straight there with the search field
  focused
- Changes apply instantly and persist
- Sidebar shortcuts, palette details, and context-menu hints follow the
  configured bindings

### Configuration

All settings are persisted in the app's config directory (`settings.json`)
with a `localStorage` fallback:

| Category | Options |
|----------|---------|
| **Font** | Family, size (6–48), weight (normal/bold), line height, letter spacing, ligatures |
| **Theme** | 11 built-in themes, background opacity |
| **Agents** | Show/hide built-in agents, define custom agents (name + command line), choose a default agent — or none, to open with an empty workspace |
| **Worktrees** | Base directory for auto-created worktrees (default `/tmp`) |
| **Notifications** | Desktop notifications on/off, ntfy server/topic/token |
| **Terminal Bell** | Sound on/off, notification on/off |
| **Dictation** | Engine selection, microphone device |
| **Keybinds** | Remap any shortcut |
| **Snippets** | Prompt snippet library |

### Diagnostics

- **Copy diagnostics** (command palette) — copies a flat environment context
  blob to the clipboard for pasting into bug reports: app version, OS/arch,
  install dir, launch dir, git repo/commit (when inside one), settings schema
  version, worktree base dir, dictation engine, and the log file path
- `hivefield --doctor` prints the same blob as pretty JSON to stdout and
  exits without opening the app (on Windows release builds the console is
  hidden, so use the palette action there)

---

## Architecture

```
┌──────────────────────────────────┐        IPC events / commands         ┌──────────────────────────────┐
│  Frontend  (dockview + xterm.js) │   pty://output / pty://exit          │  Backend  (Rust)             │
│  one xterm per sessionId, tabs/  │ ◄────────────────────────────────►   │  session registry:          │
│  splits managed by dockview      │   pty_spawn / pty_write /            │  HashMap<sessionId, Pty>    │
└──────────────────────────────────┘   pty_resize / pty_kill              └──────────────────────────────┘
```

The frontend (TypeScript, dockview + xterm.js) manages the UI: tabs, split
panes, the sidebar, command palette, and settings. Each terminal pane
corresponds to a PTY session on the Rust backend, addressed by a numeric
`sessionId`. Communication happens over Tauri IPC commands and events.

The Rust backend (`src-tauri/src/`) owns:
- **PTY lifecycle** — spawn, write, resize, kill (`pty.rs`)
- **Window management** — multi-window support (`windows.rs`)
- **Workspace persistence** — per-directory layout save/restore (`workspace.rs`)
- **Git worktrees** — create/remove throwaway worktrees for agent isolation
  (`git.rs`)
- **Settings** — read/write `settings.json` in the app config dir
  (`settings.rs`)
- **Notifications** — desktop and ntfy push notifications (`notifications.rs`)
- **Dictation** — Whisper, Vosk, and cloud speech-to-text engines
  (`dictation.rs`)
- **Font discovery** — system font enumeration (`fonts.rs`)

---

## Requirements

- **Rust** (stable) with Tauri v2 system dependencies
  ([see Tauri docs](https://v2.tauri.app/start/prerequisites/))
- **Node.js** 18+ with [Bun](https://bun.sh) (used as package manager and
  bundler)
- **Linux**: `libwebkit2gtk-4.1-dev`, `libxdo-dev`, `libssl-dev`,
  `libayatana-appindicator3-dev`, `librsvg2-dev`, `libasound2-dev`, and
  `libvosk.so` (for dictation; see CI workflow for download steps)
- **macOS**: Xcode Command Line Tools
- **Windows**: Microsoft Visual Studio C++ Build Tools, WebView2

---

## Development

```sh
# Install frontend dependencies
bun install

# Build the Rust backend
(cd src-tauri && cargo build)

# Launch in dev mode (hot-reload frontend, restart backend on changes)
bun run tauri dev
```

Run checks before committing:

```sh
bun run build          # bundle frontend
bunx tsc --noEmit      # typecheck
(cd src-tauri && cargo test)  # Rust tests
```

---

## Build a Release

```sh
bun run tauri build
```

Outputs are in `src-tauri/target/release/bundle/`.

---

## Updating

hiveField can update itself from the [TiWo2012/HiveField](https://github.com/TiWo2012/HiveField)
GitHub releases — the app checks the releases API, downloads the latest
release, and installs it. There are two ways to update:

**In-app (Settings → Updates)** — shows your current version, the latest
release with its changelog, and the install location; *Check for updates*
queries GitHub and *Download & install* fetches the release (with a progress
bar) and installs it. Restart hiveField to run the new version.

**Terminal** — the same install, from a shell:

```sh
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/TiWo2012/HiveField/master/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/TiWo2012/HiveField/master/install.ps1 | iex
```

Both install to the **same location** (the app's updater and the installers
share the rule):

1. `$HF_INSTALL_DIR` when set, otherwise
2. `$HOME/.local/bin` (unix) / `%LOCALAPPDATA%\hivefield\bin` (Windows)

Installing also registers hiveField in your OS's application launcher, and
the entry is (re)written on every install or update so it always points at
the current install location:

- **Linux** — a `.desktop` entry under
  `$XDG_DATA_HOME/applications/hivefield.desktop` (`~/.local/share/applications`
  by default) plus the app icon in the hicolor theme under the same data
  directory. If a release ships no icon, the entry falls back to a stock
  terminal icon.
- **macOS** — a minimal `hiveField Terminal.app` bundle in `~/Applications`
  (Launchpad, Spotlight, Finder) wrapping the installed binary, with the
  release's icon when it ships one.
- **Windows** — a `hiveField.lnk` Start Menu shortcut under
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs`.

All three are best-effort: a launcher entry that fails to write (read-only
data dirs, missing `HOME`/`APPDATA`) is skipped with a warning and never
undoes a successful install. `install.ps1` honors `HF_NO_SHORTCUT=1` to skip
the Start Menu shortcut (mirroring `HF_NO_PATH`).

`install.sh` / `install.ps1` also honor `HF_VERSION` to pin a release tag
(`HF_VERSION=v0.2.0`). The release assets are named
`hivefield-<os>-<arch>.tar.gz` (containing the `hivefield` binary) on unix and
`hivefield-windows-<arch>.exe` on Windows; the release workflow publishes them
automatically for Linux, macOS (x86_64 + aarch64), and Windows. If a release
lacks the tarball, a bare `hivefield-<os>-<arch>` binary is used instead.

## IPC Contract

All commands/events are addressed by a `sessionId` (a number allocated by the
backend for each spawned shell).

| Direction    | Name                       | Payload |
|-------------|----------------------------|---------|
| Rust → JS   | `pty://output`             | `{ sessionId, data }` (UTF-8 string) |
| Rust → JS   | `pty://exit`               | `{ sessionId, code }` |
| Rust → JS   | `updater://progress`       | `{ percent, total }` — update download progress |
| Rust → JS   | `updater://done`           | `{ version, path }` — update installed |
| JS → Rust   | `pty_spawn`                | `{ mode, cwd?, autorun? }` — `mode` is the agent id (`"opencode"`, `"pi"`, `"codex"`, `"copilot"`, `"claude"`, ...) or `"raw"`; `cwd` optionally pins the start directory (e.g. a worktree); `autorun` overrides the command when the CLI binary differs from the mode id → returns `sessionId` |
| JS → Rust   | `editor_command`           | () → the command the built-in Editor agent auto-runs: `$EDITOR` resolved with per-platform fallback (`${EDITOR:-vi}` on unix, `%EDITOR%`/`notepad` on Windows) |
| JS → Rust   | `pty_write`                | `{ sessionId, data }` |
| JS → Rust   | `pty_resize`               | `{ sessionId, cols, rows }` |
| JS → Rust   | `pty_kill`                 | `{ sessionId }` |
| JS → Rust   | `workspace_cwd`            | () → canonicalized launch directory of the *invoking window* — keys the window's workspace persistence |
| JS → Rust   | `window_new`               | `{ cwd? }` — open a new app window scoped to `cwd` (default: process cwd) → returns the new window's label |
| JS → Rust   | `workspace_get`            | `{ cwd }` → saved dockview layout (JSON) or `null` |
| JS → Rust   | `workspace_set`            | `{ cwd, layout }` — persist the dockview layout |
| JS → Rust   | `projects_list`            | () → recent projects: every cwd with a saved workspace as `{ cwd, lastOpened, exists }`, newest first |
| JS → Rust   | `project_touch`            | `{ cwd }` — bump a project's `lastOpened` stamp without touching its saved layout |
| JS → Rust   | `git_worktree_auto_create` | `{ name, baseDir }` → `{ path, branch }` — sanitize `name` into a branch, add a timestamp suffix, and check it out under `baseDir`. Called for every new agent session |
| JS → Rust   | `git_worktree_remove`      | `{ path, force? }` — remove a worktree; `force` runs `--force` |
| JS → Rust   | `git_worktrees`            | legacy listing command (kept for compatibility) |
| JS → Rust   | `git_worktree_create`      | legacy named-branch creation command (kept for compatibility) |
| JS → Rust   | `dir_exists`               | `{ path }` → whether the path exists (validates restored worktree paths) |
| JS → Rust   | `open_url`                 | `{ url }` — open `http`/`https`/`mailto` URLs in the system browser |
| JS → Rust   | `notify_desktop`           | `{ title, body }` — show a native desktop notification |
| JS → Rust   | `ntfy_send`                | `{ title, body }` — publish a push notification to the configured ntfy server/topic (no-op when disabled) |
| JS → Rust   | `updater_check`            | () → latest release info from TiWo2012/HiveField (`{ currentVersion, latestVersion, publishedAt, changelog, htmlUrl, assetName, assetUrl, assetSize, installDir, updateAvailable }`) |
| JS → Rust   | `updater_install`          | () → download the latest release and install it to the shared install dir; emits `updater://progress` / `updater://done` — returns `{ version, path }` |
| JS → Rust   | `diagnostics`              | () → flat diagnostics blob for bug reports: `{ app, version, os, arch, installDir, launchDir, gitRepo, gitCommit, settingsSchemaVersion, worktreeBaseDir, dictationEngine, logFile }` (same data as `hivefield --doctor`) |

Workspace persistence commands are keyed by the canonicalized launch directory
(`cwd`), not by session.

---

## Contributing

1. Create a feature branch from `master`
2. Make your changes, commit early and often
3. Run `bun run build`, `bunx tsc --noEmit`, and `cargo test` in `src-tauri/`
   before opening a PR
4. Open a pull request against `master`

See [AGENTS.md](AGENTS.md) for agent workflow conventions used in this repo.

---

## License

[MIT](LICENSE) (TODO: add license file)
