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
//!   - `pty://output` payload: `{ data: String }`
//!   - `pty://exit`   payload: `{ code: i32 }`
//! * Commands invoked by the frontend (registered in `lib.rs`):
//!   - `pty_write`  (data: String)
//!   - `pty_resize` (cols: u16, rows: u16)
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

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager};

/// A live PTY session: the master end of the pseudo-terminal plus the shell
/// child process and a handle used to emit events to the frontend.
pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    app: AppHandle,
}

/// Payload for the `pty://output` event emitted to the frontend.
#[derive(Clone, serde::Serialize)]
pub struct OutputPayload {
    data: String,
}

/// Payload for the `pty://exit` event emitted to the frontend.
#[derive(Clone, serde::Serialize)]
pub struct ExitPayload {
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

/// Spawn the user's default shell in a fresh PTY, store the session in Tauri
/// state, and start a reader thread that forwards output to the frontend.
pub fn spawn(app: AppHandle) -> Result<(), Box<dyn std::error::Error>> {
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
    let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    if let Ok(home) = std::env::var(home_var) {
        let dir = std::path::Path::new(&home);
        if std::fs::read_dir(dir).is_ok() {
            cmd.cwd(dir);
        }
    }

    let child = slave.spawn_command(cmd)?;
    let mut reader = master.try_clone_reader()?;
    let writer = master.take_writer()?;

    let session = PtySession {
        master,
        child,
        writer,
        app: app.clone(),
    };
    *app.state::<crate::PtyState>().0.lock().unwrap() = Some(session);

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
                        let _ = reader_app.emit("pty://output", OutputPayload { data });
                    }
                }
                Err(_) => break,
            }
        }

        let session = reader_app
            .state::<crate::PtyState>()
            .0
            .lock()
            .unwrap()
            .take();
        match session {
            Some(mut session) => {
                let code = session
                    .child
                    .wait()
                    .ok()
                    .map(|status| status.exit_code())
                    .unwrap_or(0) as i32;
                let _ = session.app.emit("pty://exit", ExitPayload { code });
            }
            None => {
                let _ = reader_app.emit("pty://exit", ExitPayload { code: 0 });
            }
        }
    });

    Ok(())
}

/// Send input from the frontend into the PTY.
pub fn write(state: &PtyState, data: &str) -> io::Result<()> {
    let mut guard = state.0.lock().unwrap();
    let session = guard
        .as_mut()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no pty session"))?;
    session.writer.write_all(data.as_bytes())?;
    session.writer.flush()
}

/// Resize the PTY to match the frontend terminal viewport.
pub fn resize(state: &PtyState, cols: u16, rows: u16) -> io::Result<()> {
    let mut guard = state.0.lock().unwrap();
    let session = guard
        .as_mut()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no pty session"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(io::Error::other)
}
