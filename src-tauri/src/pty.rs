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

use crate::PtyState;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager};

/// A live PTY session: the master end of the pseudo-terminal plus the shell
/// child process and a handle used to emit events to the frontend.
pub struct PtySession {
    session_id: u64,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    app: AppHandle,
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
pub fn spawn(app: &AppHandle, session_id: u64) -> Result<(), Box<dyn std::error::Error>> {
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
    app.state::<crate::PtyState>()
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
            .state::<crate::PtyState>()
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

    // Auto-run `opencode` in every new session shortly after the shell starts,
    // so each tab opens straight into the agent. The shell stays alive
    // underneath, so quitting opencode returns to the prompt. Writes go through
    // the same sessions mutex as `pty_write`, so input cannot interleave.
    let autorun_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let state = autorun_app.state::<crate::PtyState>();
        let mut guard = state.sessions.lock().unwrap();
        if let Some(session) = guard.get_mut(&session_id) {
            let _ = session.writer.write_all(b"opencode\r\n");
            let _ = session.writer.flush();
        }
    });

    Ok(())
}

/// Send input from the frontend into the session's PTY.
pub fn write(state: &PtyState, session_id: u64, data: &str) -> io::Result<()> {
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
pub fn resize(state: &PtyState, session_id: u64, cols: u16, rows: u16) -> io::Result<()> {
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
pub fn kill(state: &PtyState, session_id: u64) -> io::Result<()> {
    let mut guard = state.sessions.lock().unwrap();
    if let Some(mut session) = guard.remove(&session_id) {
        let _ = session.child.kill();
    }
    Ok(())
}

/// Mark the frontend as ready (first contact) and flush any output that was
/// buffered before the webview finished registering its event listeners.
fn mark_ready(session: &mut PtySession) {
    if !session.ready.swap(true, Ordering::Relaxed) {
        let drained: Vec<String> = session.buffer.lock().unwrap().drain(..).collect();
        for s in drained {
            let _ = session
                .app
                .emit("pty://output", OutputPayload { session_id: session.session_id, data: s });
        }
    }
}
