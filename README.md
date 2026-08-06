# hiveField Terminal

A desktop terminal built with **Tauri v2** (Rust) and **xterm.js**.

## Features

- Real shell session (your default `$SHELL`) running in a PTY — one per tab/pane
- **Opens in the directory it was launched from** (falls back to `$HOME` if the
  launch dir is gone/unreadable)
- **Per-directory workspace restore**: the tab/split layout (which sessions are
  open and their modes) is saved per launch directory and restored the next time
  you start hiveField from that directory. A fully-wiped layout falls back to a
  fresh opencode session
- **Session sidebar**: drag an **opencode**, **pi agent**, or **raw term**
  entry from the left sidebar into the terminal area — it opens there as a
  **split** (drop near an edge to choose the split direction, drop in the
  middle to split to the right). `opencode` and `pi` sessions auto-run the
  agent; `raw` sessions are a plain shell. Use `Ctrl+Shift+T` to open a
  session as a tab instead.
- **Isolated sessions**: every agent session (`opencode` / `pi`) automatically
  gets its own throwaway git worktree (branch + directory minted from a
  codename, checked out under the **Worktree base dir** setting, default
  `/tmp`), so parallel agents never share a checkout. Closing the tab
  force-deletes the worktree. When the launch directory isn't a git repo, the
  agent runs in the launch dir. Raw terms always run in the launch dir.
- **Tabs & split panes** via [dockview](https://dockview.dev):
  - `Ctrl+Shift+T` spawns a new terminal tab
  - Drag a tab **out of the tab bar** to split it into its own pane group
  - Drag tabs between groups, drag splitter handles to resize
  - **`Ctrl+H` / `Ctrl+J` / `Ctrl+K` / `Ctrl+L`** move focus to the pane
    left / down / up / right (vim-style); if no pane exists in that direction
    the key passes through to the shell (so `Ctrl+L` still clears the screen)
  - Every pane auto-resizes its PTY (`cols`/`rows` stay in sync)
  - `Ctrl+Shift+W` (or the tab ✕) closes the active panel and kills its shell
  - **Double-click a tab** (or `Ctrl+Shift+R`) to rename it; a custom name is
    never overwritten by program/OSC titles, and clearing it reverts to
    automatic titles
- **Command palette**: press **`Ctrl+Shift+P`** for a fuzzy-finder over every
  open pane (jump straight to it) and common actions (new opencode/pi/raw tab
  or split, find, focus panes, rename, close, settings). Type to fuzzy-filter with
  live match highlighting, `↑`/`↓` (or `Ctrl+P` / `Ctrl+N`, or `Ctrl+K` /
  `Ctrl+J`) to move, `Enter` to jump/run, `Esc` to close.
- **Terminal search**: press **`Ctrl+Shift+F`** to search the current pane's
  scrollback. Matches highlight live as you type; `Enter` / `Shift+Enter` jump
  to the next / previous match, `Alt+C` toggles case sensitivity, and `Esc`
  closes the bar (focus returns to the terminal). The match counter shows
  `current/total` and turns red when there are no matches.
- **Hyperlinks**: URLs in output are underlined and **Ctrl+click** (or
  Cmd+click) opens them in your system browser (`http`, `https`, `mailto`).
  Hover shows a hint tooltip.
- **Tab activity / completion indicator**: a background tab whose session
  prints output gets a `●` prefix, flipping to `✓` once the output goes quiet
  (or immediately when shell integration emits an OSC 133 `D` finish marker).
  Switching to the tab clears the indicator.
- **Notifications**: when a background agent session (opencode / pi) finishes — or the window is unfocused — hiveField fires a **desktop notification** and/or an **ntfy push notification** (configurable in Settings): ntfy supports a custom server (default `https://ntfy.sh`), topic, and optional username/password Basic auth (stored unencrypted in `settings.json`, as configured). A "Test" button in Settings verifies each channel.
- **Font-size zoom**: `Ctrl+=` / `Ctrl+-` adjust the font size of every
  terminal live (persisted in settings); `Ctrl+0` resets it.
- **Themes**: a color theme setting drives both the terminal palette and the
  window chrome (sidebar, tabs, modals, search bar). Includes Catppuccin
  Mocha/Latte, Nord, Dracula, Monokai, One Dark, Gruvbox, Solarized Light,
  GitHub Dark/Light, and Abyss. A **background opacity** setting below 1 makes
  the terminal translucent with a backdrop blur (requires a compositor that
  supports transparent windows).
- Full **Unicode / UTF-8** support (incremental UTF-8 decoding on the Rust side
  so multi-byte characters survive split reads; xterm.js Unicode 11 on the UI)
- Copy/paste, cursor blink, scrollback, window resize → PTY resize
- **Font ligatures** (on by default) — the DOM renderer merges cells into
  spans and the `calt` OpenType feature is enabled, so fonts with programming
  ligatures (Fira Code, Maple Mono, JetBrains Mono, …) render `->`, `=>`,
  `!=` etc. as joined glyphs. Toggle in Settings
- **OSC-based tab titles**: when a program sets the terminal title via an OSC
  sequence (`ESC]0;…`, `ESC]2;…`), the pane's tab reflects it. OSC titles win
  over the input-line-derived titles, which remain as a fallback for sessions
  that never emit one; a manually renamed tab wins over both.
- Cross-platform (Linux/macOS/Windows) via `portable-pty`

## Architecture

```
┌──────────────────────────────────┐        IPC events / commands         ┌──────────────────────────────┐
│  Frontend  (dockview + xterm.js) │   pty://output / pty://exit          │  Backend  (Rust)             │
│  one xterm per sessionId, tabs/  │ ◄────────────────────────────────►   │  session registry:          │
│  splits managed by dockview      │   pty_spawn / pty_write /            │  HashMap<sessionId, Pty>    │
└──────────────────────────────────┘   pty_resize / pty_kill              └──────────────────────────────┘
```

## Requirements

- Rust (stable) + Tauri v2 system deps (webkit2gtk-4.1 etc.)
- Node 18+ with `bun` (used as package manager + bundler)

## Develop

```sh
bun install           # install frontend deps (in repo root)
cargo build           # in src-tauri/
bun run tauri dev     # build frontend + launch the app window
```

## Build a release bundle

```sh
bun run tauri build
```

## IPC contract

All commands/events are addressed by a `sessionId` (a number allocated by the
backend for each spawned shell).

| Direction | Name            | Payload                                       |
|-----------|-----------------|-----------------------------------------------|
| Rust → JS | `pty://output`  | `{ sessionId, data }` (data is UTF-8 string)  |
| Rust → JS | `pty://exit`    | `{ sessionId, code }`                         |
| JS → Rust | `pty_spawn`     | `{ mode, cwd? }` (`"opencode"` \| `"pi"` \| `"raw"`, default opencode; `cwd` optionally pins the start directory, e.g. a worktree) → returns `sessionId` |
| JS → Rust | `pty_write`     | `{ sessionId, data }`                         |
| JS → Rust | `pty_resize`    | `{ sessionId, cols, rows }`                   |
| JS → Rust | `pty_kill`      | `{ sessionId }`                               |
| JS → Rust | `workspace_cwd` | () → canonicalized launch directory (`String`) |
| JS → Rust | `workspace_get` | `{ cwd }` → saved dockview layout (JSON) or `null` |
| JS → Rust | `workspace_set` | `{ cwd, layout }` — persist the dockview layout |
| JS → Rust | `git_worktree_auto_create` | `{ name, baseDir }` → `{ path, branch }` — sanitize `name` into a branch, add a timestamp suffix, and check it out under `baseDir` (e.g. `/tmp/<repo>-<sanitized>-<ts>`). Called for every new agent session (`opencode` / `pi`) |
| JS → Rust | `git_worktree_remove` | `{ path, force? }` — remove a worktree; `force` runs `--force` (used when closing an auto-created session worktree) |
| JS → Rust | `git_worktrees` / `git_worktree_create` | legacy listing / named-branch creation commands (no longer used by the UI, kept for compatibility) |
| JS → Rust | `dir_exists`   | `{ path }` → whether the path exists (lets restored sessions detect stale worktree paths) |
| JS → Rust | `open_url`     | `{ url }` — open `http`/`https`/`mailto` URLs in the system browser |
| JS → Rust | `notify_desktop` | `{ title, body }` — show a native desktop notification |
| JS → Rust | `ntfy_send`    | `{ title, body }` — publish a push notification to the configured ntfy server/topic (config read from settings: `ntfyEnabled`, `ntfyServer`, `ntfyTopic`, `ntfyUser`, `ntfyPass`; no-op when disabled) |

The workspace persistence commands are keyed by the canonicalized launch
directory (`cwd`), not by a session.
