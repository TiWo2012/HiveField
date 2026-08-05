# hiveField Terminal

A basic desktop terminal built with **Tauri v2** (Rust) and **xterm.js**.

## Features

- Real shell session (your default `$SHELL`) running in a PTY
- Full **Unicode / UTF-8** support (incremental UTF-8 decoding on the Rust side
  so multi-byte characters survive split reads; xterm.js Unicode 11 on the UI)
- Copy/paste, cursor blink, scrollback, window resize → PTY resize
- Cross-platform (Linux/macOS/Windows) via `portable-pty`

## Architecture

```
┌──────────────────────────────┐        IPC events / commands        ┌───────────────────────┐
│  Frontend  (xterm.js + TS)   │   pty://output / pty://exit         │  Backend  (Rust)      │
│  dist/ bundled by bun        │ ◄────────────────────────────────►  │  portable-pty + shell │
└──────────────────────────────┘   pty_write / pty_resize            └───────────────────────┘
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

| Direction | Name            | Payload                          |
|-----------|-----------------|----------------------------------|
| Rust → JS | `pty://output`  | `{ data: string }` (UTF-8)       |
| Rust → JS | `pty://exit`    | `{ code: number }`               |
| JS → Rust | `pty_write`     | `{ data: string }`               |
| JS → Rust | `pty_resize`    | `{ cols: number, rows: number }` |
