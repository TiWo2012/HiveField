# hiveField Terminal

A desktop terminal built with **Tauri v2** (Rust) and **xterm.js**.

## Features

- Real shell session (your default `$SHELL`) running in a PTY — one per tab/pane
- **Opens in the directory it was launched from** (falls back to `$HOME` if the
  launch dir is gone/unreadable)
- **Session sidebar**: drag an **opencode** or **raw term** entry from the left
  sidebar into the terminal area — it opens there (split or as a tab), with a
  fresh shell in the launch dir. `opencode` sessions auto-run the agent; `raw`
  sessions are a plain shell.
- **Tabs & split panes** via [dockview](https://dockview.dev):
  - `Ctrl+Shift+T` spawns a new terminal tab
  - Drag a tab **out of the tab bar** to split it into its own pane group
  - Drag tabs between groups, drag splitter handles to resize
  - **`Ctrl+H` / `Ctrl+J` / `Ctrl+K` / `Ctrl+L`** move focus to the pane
    left / down / up / right (vim-style); if no pane exists in that direction
    the key passes through to the shell (so `Ctrl+L` still clears the screen)
  - Every pane auto-resizes its PTY (`cols`/`rows` stay in sync)
  - `Ctrl+Shift+W` (or the tab ✕) closes the active panel and kills its shell
- Full **Unicode / UTF-8** support (incremental UTF-8 decoding on the Rust side
  so multi-byte characters survive split reads; xterm.js Unicode 11 on the UI)
- Copy/paste, cursor blink, scrollback, window resize → PTY resize
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
