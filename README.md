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
- **Session sidebar**: drag an **opencode** or **raw term** entry from the left
  sidebar into the terminal area — it opens there as a **split** (drop near an
  edge to choose the split direction, drop in the middle to split to the
  right), with a fresh shell in the launch dir. `opencode` sessions auto-run
  the agent; `raw` sessions are a plain shell. Use `Ctrl+Shift+T` to open a
  session as a tab instead.
- **Tabs & split panes** via [dockview](https://dockview.dev):
  - `Ctrl+Shift+T` spawns a new terminal tab
  - Drag a tab **out of the tab bar** to split it into its own pane group
  - Drag tabs between groups, drag splitter handles to resize
  - **`Ctrl+H` / `Ctrl+J` / `Ctrl+K` / `Ctrl+L`** move focus to the pane
    left / down / up / right (vim-style); if no pane exists in that direction
    the key passes through to the shell (so `Ctrl+L` still clears the screen)
  - Every pane auto-resizes its PTY (`cols`/`rows` stay in sync)
  - `Ctrl+Shift+W` (or the tab ✕) closes the active panel and kills its shell
- **Terminal search**: press **`Ctrl+Shift+F`** to search the current pane's
  scrollback. Matches highlight live as you type; `Enter` / `Shift+Enter` jump
  to the next / previous match, `Alt+C` toggles case sensitivity, and `Esc`
  closes the bar (focus returns to the terminal). The match counter shows
  `current/total` and turns red when there are no matches.
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
  that never emit one.
- Catppuccin Mocha theme end-to-end
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
| JS → Rust | `pty_spawn`     | `{ mode }` (`"opencode"` \| `"raw"`, default opencode) → returns `sessionId` |
| JS → Rust | `pty_write`     | `{ sessionId, data }`                         |
| JS → Rust | `pty_resize`    | `{ sessionId, cols, rows }`                   |
| JS → Rust | `pty_kill`      | `{ sessionId }`                               |
| JS → Rust | `workspace_cwd` | () → canonicalized launch directory (`String`) |
| JS → Rust | `workspace_get` | `{ cwd }` → saved dockview layout (JSON) or `null` |
| JS → Rust | `workspace_set` | `{ cwd, layout }` — persist the dockview layout |

The workspace persistence commands are keyed by the canonicalized launch
directory (`cwd`), not by a session.
