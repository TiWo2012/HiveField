//! PTY backend for the hiveField Terminal.
//!
//! This module is responsible for the RUST side of the terminal:
//!
//! 1. Spawning a real shell (e.g. `$SHELL`, `bash`, `pwsh`) inside a
//!    pseudo-terminal using the `portable-pty` crate.
//! 2. Reading the shell's output and forwarding it to the frontend as
//!    `pty://output` events carrying UTF-8 strings.
//! 3. Writing user input received from the frontend into the PTY.
//! 4. Resizing the PTY when the xterm.js viewport changes.
//! 5. Emitting a `pty://exit` event (with the exit code) when the shell dies.
//!
//! # IPC contract (must match the frontend exactly)
//!
//! * Events emitted to the frontend:
//!   - `pty://output` payload: `{ sessionId: u64, data: String }`
//!   - `pty://exit`   payload: `{ sessionId: u64, code: i32 }`
//! * Commands invoked by the frontend (registered in `lib.rs`):
//!   - `pty_spawn`  () -> sessionId: u64
//!   - `pty_write`  (sessionId: u64, data: String)
//!   - `pty_resize` (sessionId: u64, cols: u16, rows: u16)
//!   - `pty_kill`   (sessionId: u64)
//!
//! # Unicode
//!
//! Shell output is raw bytes. Byte chunks can split a multi-byte UTF-8
//! sequence across reads, so decoding each chunk independently with
//! `String::from_utf8_lossy` would corrupt characters (mojibake). Use an
//! incremental decoder that buffers incomplete trailing bytes and only emits
//! complete characters (see [`Utf8StreamDecoder`]).
//!
//! * The spawned shell is given a UTF-8 locale (`LC_ALL`/`LC_CTYPE`/`LANG` set
//!   to `C.UTF-8`) when none is configured, so it emits full Unicode (emoji,
//!   CJK, Nerd Font codepoints, etc.).

use crate::PtyState;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// A live PTY session: the master end of the pseudo-terminal plus the shell
/// child process and a handle used to emit events to the frontend.
pub struct PtySession<R: tauri::Runtime = tauri::Wry> {
    session_id: u64,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    app: AppHandle<R>,
    /// Set once the frontend has contacted the backend (first write/resize).
    /// Until then, shell output is buffered so the initial prompt is not lost
    /// while the webview is still registering its event listeners.
    ready: Arc<AtomicBool>,
    /// Output buffered before the frontend was ready.
    buffer: Arc<Mutex<Vec<String>>>,
}

/// Payload for the `pty://output` event emitted to the frontend.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputPayload {
    session_id: u64,
    data: String,
}

/// Payload for the `pty://exit` event emitted to the frontend.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitPayload {
    session_id: u64,
    code: i32,
}

/// Incremental UTF-8 decoder: buffers trailing bytes that may be the prefix of
/// a multi-byte sequence, and returns only complete characters.
pub struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Default for Utf8StreamDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl Utf8StreamDecoder {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    /// Feed raw bytes, return the maximal prefix of complete UTF-8 characters.
    ///
    /// Incomplete trailing sequences are buffered and prepended to the next
    /// chunk; invalid bytes are replaced with U+FFFD.
    pub fn push(&mut self, bytes: &[u8]) -> String {
        if bytes.is_empty() {
            return String::new();
        }

        let mut combined = Vec::with_capacity(self.pending.len() + bytes.len());
        combined.extend_from_slice(&self.pending);
        combined.extend_from_slice(bytes);
        self.pending.clear();

        let mut out = String::new();
        let mut rest: &[u8] = &combined;

        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    if valid > 0 {
                        out.push_str(
                            std::str::from_utf8(&rest[..valid]).expect("validated prefix"),
                        );
                    }
                    match e.error_len() {
                        Some(_) => {
                            out.push('\u{FFFD}');
                            rest = &rest[valid + 1..];
                        }
                        None => {
                            self.pending.extend_from_slice(&rest[valid..]);
                            break;
                        }
                    }
                }
            }
        }

        out
    }
}

/// Spawn a shell in a fresh PTY, store the session in Tauri state under
/// `session_id`, and start a reader thread that forwards output to the frontend.
///
/// `mode` is `"opencode"` to auto-run `opencode` in the session, or `"raw"`
/// for a plain shell.
pub fn spawn<R: Runtime>(
    app: &AppHandle<R>,
    session_id: u64,
    mode: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let shell = if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "bash".to_string())
    };

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 30,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let (master, slave) = (pair.master, pair.slave);

    let mut cmd = CommandBuilder::new(shell);
    cmd.env("TERM", "xterm-256color");

    // Ensure a UTF-8 locale is visible to the shell so it emits full Unicode
    // (emoji, CJK, Nerd Font codepoints, etc.). Only set vars the user has not
    // configured, so an explicit locale is never clobbered.
    for var in ["LC_ALL", "LC_CTYPE", "LANG"] {
        if std::env::var_os(var).is_none() {
            cmd.env(var, "C.UTF-8");
        }
    }

    // Start the shell in the directory the app was launched from (the process
    // cwd), falling back to the user's home directory if that is gone or
    // unreadable.
    let start_dir = std::env::current_dir()
        .ok()
        .filter(|d| std::fs::read_dir(d).is_ok())
        .or_else(|| {
            let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
            std::env::var(home_var)
                .ok()
                .map(std::path::PathBuf::from)
                .filter(|d| std::fs::read_dir(d).is_ok())
        });
    if let Some(dir) = start_dir {
        cmd.cwd(dir);
    }

    let child = slave.spawn_command(cmd)?;
    let mut reader = master.try_clone_reader()?;
    let writer = master.take_writer()?;

    let ready = Arc::new(AtomicBool::new(false));
    let buffer = Arc::new(Mutex::new(Vec::new()));
    let session = PtySession {
        session_id,
        master,
        child,
        writer,
        app: app.clone(),
        ready: ready.clone(),
        buffer: buffer.clone(),
    };
    app.state::<crate::PtyState<R>>()
        .sessions
        .lock()
        .unwrap()
        .insert(session_id, session);

    let reader_app = app.clone();
    std::thread::spawn(move || {
        let mut decoder = Utf8StreamDecoder::new();
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = decoder.push(&buf[..n]);
                    if !data.is_empty() {
                        // Emit once the frontend is ready; otherwise buffer.
                        // The push + check + drain all happen under the buffer
                        // lock so no output is lost when `ready` flips.
                        let mut pending = buffer.lock().unwrap();
                        pending.push(data);
                        if ready.load(Ordering::Relaxed) {
                            for s in pending.drain(..) {
                                let _ = reader_app.emit(
                                    "pty://output",
                                    OutputPayload {
                                        session_id,
                                        data: s,
                                    },
                                );
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }

        let session = reader_app
            .state::<crate::PtyState<R>>()
            .sessions
            .lock()
            .unwrap()
            .remove(&session_id);
        match session {
            Some(mut session) => {
                let code = session
                    .child
                    .wait()
                    .ok()
                    .map(|status| status.exit_code())
                    .unwrap_or(0) as i32;
                let _ = session
                    .app
                    .emit("pty://exit", ExitPayload { session_id, code });
            }
            None => {
                // Session was killed/removed via `pty_kill`: no spurious exit.
            }
        }
    });

    // For `opencode` sessions, auto-run `opencode` shortly after the shell
    // starts so each tab opens straight into the agent. The shell stays alive
    // underneath, so quitting opencode returns to the prompt. Writes go
    // through the same sessions mutex as `pty_write`, so input cannot
    // interleave. `raw` sessions skip this entirely.
    if mode == "opencode" {
        let autorun_app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let state = autorun_app.state::<crate::PtyState<R>>();
            let mut guard = state.sessions.lock().unwrap();
            if let Some(session) = guard.get_mut(&session_id) {
                let _ = session.writer.write_all(b"opencode\r\n");
                let _ = session.writer.flush();
            }
        });
    }

    Ok(())
}

/// Send input from the frontend into the session's PTY.
pub fn write<R: Runtime>(state: &PtyState<R>, session_id: u64, data: &str) -> io::Result<()> {
    let mut guard = state.sessions.lock().unwrap();
    let session = guard.get_mut(&session_id).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!("no pty session with id {session_id}"),
        )
    })?;
    session.writer.write_all(data.as_bytes())?;
    session.writer.flush()?;
    mark_ready(session);
    Ok(())
}

/// Resize the session's PTY to match the frontend terminal viewport.
pub fn resize<R: Runtime>(state: &PtyState<R>, session_id: u64, cols: u16, rows: u16) -> io::Result<()> {
    let mut guard = state.sessions.lock().unwrap();
    let session = guard.get_mut(&session_id).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!("no pty session with id {session_id}"),
        )
    })?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(io::Error::other)?;
    mark_ready(session);
    Ok(())
}

/// Kill the session's shell process and remove the session. Idempotent: a
/// session that is already gone (or was never created) is not an error.
pub fn kill<R: Runtime>(state: &PtyState<R>, session_id: u64) -> io::Result<()> {
    let mut guard = state.sessions.lock().unwrap();
    if let Some(mut session) = guard.remove(&session_id) {
        let _ = session.child.kill();
    }
    Ok(())
}

/// Mark the frontend as ready (first contact) and flush any output that was
/// buffered before the webview finished registering its event listeners.
fn mark_ready<R: Runtime>(session: &mut PtySession<R>) {
    if !session.ready.swap(true, Ordering::Relaxed) {
        let drained: Vec<String> = session.buffer.lock().unwrap().drain(..).collect();
        for s in drained {
            let _ = session
                .app
                .emit("pty://output", OutputPayload { session_id: session.session_id, data: s });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PtyState;
    use tauri::test::MockRuntime;

    // ---- PTY session registry (error paths, no real PTY needed) ----

    fn empty_state() -> PtyState<MockRuntime> {
        PtyState::<MockRuntime>::default()
    }

    #[test]
    fn write_to_unknown_session_returns_not_found() {
        let state = empty_state();
        let err = write(&state, 42, "hello").expect_err("write should fail");
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert!(err.to_string().contains("42"), "unexpected error: {err}");
    }

    #[test]
    fn resize_unknown_session_returns_not_found() {
        let state = empty_state();
        let err = resize(&state, 42, 80, 24).expect_err("resize should fail");
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn kill_unknown_session_is_idempotent() {
        let state = empty_state();
        assert!(kill(&state, 42).is_ok(), "first kill should be a no-op");
        assert!(kill(&state, 42).is_ok(), "second kill should also be a no-op");
    }

    #[test]
    fn session_map_starts_empty() {
        assert!(empty_state().sessions.lock().unwrap().is_empty());
    }

    // ---- Utf8StreamDecoder ----

    #[test]
    fn decoder_passes_ascii_through() {
        let mut d = Utf8StreamDecoder::new();
        assert_eq!(d.push(b"hello world"), "hello world");
    }

    #[test]
    fn decoder_empty_input_returns_empty() {
        let mut d = Utf8StreamDecoder::new();
        assert_eq!(d.push(b""), "");
    }

    #[test]
    fn decoder_buffers_split_two_byte_sequence() {
        let mut d = Utf8StreamDecoder::new();
        // 'é' = 0xC3 0xA9
        assert_eq!(d.push(b"caf"), "caf");
        assert_eq!(d.push(&[0xC3]), "", "incomplete lead byte is buffered");
        assert_eq!(d.push(&[0xA9]), "é");
    }

    #[test]
    fn decoder_buffers_split_three_byte_sequence() {
        let mut d = Utf8StreamDecoder::new();
        // '中' = 0xE4 0xB8 0xAD
        assert_eq!(d.push(&[0xE4]), "");
        assert_eq!(d.push(&[0xB8]), "");
        assert_eq!(d.push(&[0xAD]), "中");
    }

    #[test]
    fn decoder_buffers_split_four_byte_emoji() {
        let mut d = Utf8StreamDecoder::new();
        // '😀' = 0xF0 0x9F 0x98 0x80
        assert_eq!(d.push(&[0xF0]), "");
        assert_eq!(d.push(&[0x9F, 0x98]), "");
        assert_eq!(d.push(&[0x80]), "😀");
    }

    #[test]
    fn decoder_replaces_invalid_bytes() {
        let mut d = Utf8StreamDecoder::new();
        assert_eq!(d.push(b"a\xFFb"), "a\u{FFFD}b");
    }

    #[test]
    fn decoder_handles_invalid_continuation_after_pending_lead() {
        let mut d = Utf8StreamDecoder::new();
        assert_eq!(d.push(&[0xC3]), "");
        // 0xFF is not a valid continuation for a 2-byte lead: both bytes
        // decode to U+FFFD.
        assert_eq!(d.push(&[0xFF]), "\u{FFFD}\u{FFFD}");
    }

    #[test]
    fn decoder_handles_truncated_lead_followed_by_invalid_byte() {
        let mut d = Utf8StreamDecoder::new();
        // 0xF0 starts a 4-byte sequence; 0x41 ('A') is not a continuation.
        assert_eq!(d.push(&[0xF0]), "");
        assert_eq!(d.push(b"A"), "\u{FFFD}A");
    }

    #[test]
    fn decoder_mixed_stream_with_splits() {
        let mut d = Utf8StreamDecoder::new();
        assert_eq!(d.push(b"h"), "h");
        assert_eq!(d.push(&[0xF0]), "");
        assert_eq!(d.push(&[0x9F, 0x98, 0x80]), "😀");
        assert_eq!(d.push(b"!"), "!");
        assert_eq!(d.push("世界".as_bytes()), "世界");
    }

    /// Feed bytes one at a time (the worst-case chunking) and reconstruct.
    fn decode_bytewise(input: &[u8]) -> String {
        let mut d = Utf8StreamDecoder::new();
        let mut out = String::new();
        for b in input {
            out.push_str(&d.push(&[*b]));
        }
        out.push_str(&d.push(b""));
        out
    }

    #[test]
    fn decoder_bytewise_reconstructs_utf8() {
        for case in ["hello", "café", "中文", "😀", "👨\u{200D}👩\u{200D}👧", "aé中😀"] {
            assert_eq!(decode_bytewise(case.as_bytes()), case, "round-trip failed for {case:?}");
        }
    }

    #[test]
    fn decoder_bytewise_zwj_family_emoji() {
        let fam = "👨\u{200D}👩\u{200D}👧";
        assert_eq!(decode_bytewise(fam.as_bytes()), fam);
    }
}
