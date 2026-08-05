/**
 * Frontend entry point for the hiveField Terminal.
 *
 * Wire up xterm.js to the Tauri backend:
 *   - Listen for "pty://output" events and write them into the terminal.
 *   - Forward keystrokes to the backend via the "pty_write" command.
 *   - Keep the PTY size in sync via the "pty_resize" command.
 *
 * This file is the FRONTEND half of the work. The backend (src-tauri) exposes:
 *   Events:  pty://output  { data: string }  - shell output (UTF-8, already decoded)
 *            pty://exit    { code: number }  - shell exited
 *   Commands: pty_write(data: string)        - send input to the shell
 *             pty_resize(cols: number, rows: number)
 */
