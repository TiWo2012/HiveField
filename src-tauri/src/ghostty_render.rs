//! Ghostty-based terminal rendering: replaces xterm.js with the pure-Rust
//! VT emulation from `vtcode-ghostty-core` and a canvas-based frontend
//! renderer.
//!
//! Each PTY session gets a [`Terminal`] that processes output bytes and
//! maintains full terminal state (grid, cursor, attributes, scrollback).
//! On each update, the entire screen is sent to the frontend as structured
//! `ghostty://cells` events, which the frontend draws to an HTML canvas.
//!
//! PTY i/o stays in `pty.rs`; the frontend canvas renderer lives in
//! `ghostty-canvas.ts`.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use vtcode_ghostty_core::cell::Cell;
use vtcode_ghostty_core::color::Color;
use vtcode_ghostty_core::Terminal;

use crate::Unpoisoned;

/// Per-session ghostty rendering state.
pub struct GhosttySession {
    pub terminal: Terminal,
}

/// A single terminal cell as sent to the frontend.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellData {
    pub row: usize,
    pub col: usize,
    pub ch: String,
    pub fg: u32,
    pub bg: u32,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
}

/// Payload for the `ghostty://cells` event (full screen snapshot).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellsPayload {
    pub session_id: u64,
    pub cols: usize,
    pub rows: usize,
    pub cursor_row: usize,
    pub cursor_col: usize,
    pub cells: Vec<CellData>,
}

/// Payload for a title-change event.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhosttyTitlePayload {
    pub session_id: u64,
    pub title: String,
}

/// Managed state holding ghostty terminals alongside PTY sessions.
pub struct GhosttyState {
    pub sessions: Mutex<HashMap<u64, GhosttySession>>,
}

impl Default for GhosttyState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

/// Pack a Color into a u32 for the frontend.
///     bits  0-7: blue
///     bits  8-15: green
///     bits 16-23: red
///     bit 24: 0 = ANSI/default, 1 = RGB
/// Shortcut: we only pass RGB to the frontend; the frontend applies the
/// theme mapping.  For ANSI colors we send the theme-resolved RGB (the
/// backend doesn't know the active theme, so we tag the ANSI index and let
/// the frontend resolve it).
pub fn color_u32(c: Option<Color>) -> u32 {
    match c {
        None => 0xFF_000000, // default: tagged + white
        Some(Color::Rgb { r, g, b }) => {
            0x100_0000 | ((r as u32) << 16) | ((g as u32) << 8) | (b as u32)
        }
        Some(Color::Indexed(idx)) => {
            // 256-color palette: tag (bit24=1) + index in low 8 bits.
            0x100_0000 | (idx as u32)
        }
        Some(Color::Ansi(ac)) => {
            // 16 ANSI colors: tag as special (bit24=1, bit25=1 for ANSI).
            let idx = match ac {
                vtcode_ghostty_core::color::AnsiColor::Black => 0,
                vtcode_ghostty_core::color::AnsiColor::Red => 1,
                vtcode_ghostty_core::color::AnsiColor::Green => 2,
                vtcode_ghostty_core::color::AnsiColor::Yellow => 3,
                vtcode_ghostty_core::color::AnsiColor::Blue => 4,
                vtcode_ghostty_core::color::AnsiColor::Magenta => 5,
                vtcode_ghostty_core::color::AnsiColor::Cyan => 6,
                vtcode_ghostty_core::color::AnsiColor::White => 7,
                vtcode_ghostty_core::color::AnsiColor::BrightBlack => 8,
                vtcode_ghostty_core::color::AnsiColor::BrightRed => 9,
                vtcode_ghostty_core::color::AnsiColor::BrightGreen => 10,
                vtcode_ghostty_core::color::AnsiColor::BrightYellow => 11,
                vtcode_ghostty_core::color::AnsiColor::BrightBlue => 12,
                vtcode_ghostty_core::color::AnsiColor::BrightMagenta => 13,
                vtcode_ghostty_core::color::AnsiColor::BrightCyan => 14,
                vtcode_ghostty_core::color::AnsiColor::BrightWhite => 15,
            };
            // bit24=1, bit25=1 (ANSI flag), low 4 bits = index
            0x300_0000 | (idx as u32)
        }
    }
}

impl GhosttyState {
    pub fn create(&self, session_id: u64, cols: usize, rows: usize) {
        let mut guard = self.sessions.lock_unpoisoned();
        let mut t = Terminal::new(cols, rows);
        t.set_max_scrollback(10_000);
        guard.insert(session_id, GhosttySession { terminal: t });
    }

    /// Feed bytes without emitting cells (for pre-ready buffering).
    pub fn feed_bytes(&self, session_id: u64, data: &[u8]) {
        let mut guard = self.sessions.lock_unpoisoned();
        if let Some(session) = guard.get_mut(&session_id) {
            session.terminal.write(data);
        }
    }

    /// Feed PTY output bytes into the terminal, then emit the full screen
    /// state to the frontend via `ghostty://cells` (broadcast).
    pub fn feed_and_flush<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        session_id: u64,
        data: &[u8],
    ) {
        let mut guard = self.sessions.lock_unpoisoned();
        let Some(session) = guard.get_mut(&session_id) else {
            return;
        };

        session.terminal.write(data);

        // Collect full screen.
        let cols = session.terminal.cols();
        let rows = session.terminal.rows();
        let cursor = session.terminal.cursor();
        let grid = session.terminal.grid().to_vec(); // clone – cheap (cells are Copy)

        let cells: Vec<CellData> = grid
            .iter()
            .enumerate()
            .map(|(i, cell)| CellData {
                row: i / cols,
                col: i % cols,
                ch: cell_to_string(cell),
                fg: color_u32(cell.style().fg),
                bg: color_u32(cell.style().bg),
                bold: cell.style().bold,
                italic: cell.style().italic,
                underline: cell.style().underline,
                inverse: cell.style().inverse,
            })
            .collect();

        let payload = CellsPayload {
            session_id,
            cols,
            rows,
            cursor_row: cursor.row,
            cursor_col: cursor.col,
            cells,
        };

        let _ = app.emit("ghostty://cells", payload);
    }

    /// Flush current screen state without feeding new data (used after
    /// resize to update the frontend).
    pub fn flush<R: Runtime>(&self, app: &AppHandle<R>, session_id: u64) {
        let mut guard = self.sessions.lock_unpoisoned();
        let Some(session) = guard.get_mut(&session_id) else {
            return;
        };
        let cols = session.terminal.cols();
        let rows = session.terminal.rows();
        let cursor = session.terminal.cursor();
        let grid = session.terminal.grid().to_vec();

        let cells: Vec<CellData> = grid
            .iter()
            .enumerate()
            .map(|(i, cell)| CellData {
                row: i / cols,
                col: i % cols,
                ch: cell_to_string(cell),
                fg: color_u32(cell.style().fg),
                bg: color_u32(cell.style().bg),
                bold: cell.style().bold,
                italic: cell.style().italic,
                underline: cell.style().underline,
                inverse: cell.style().inverse,
            })
            .collect();

        let payload = CellsPayload {
            session_id,
            cols,
            rows,
            cursor_row: cursor.row,
            cursor_col: cursor.col,
            cells,
        };
        let _ = app.emit("ghostty://cells", payload);
    }

    /// Resize a session's terminal.
    pub fn resize(&self, session_id: u64, cols: usize, rows: usize) {
        let mut guard = self.sessions.lock_unpoisoned();
        if let Some(session) = guard.get_mut(&session_id) {
            session.terminal.resize(cols, rows);
        }
    }

    /// Remove a session.
    pub fn remove(&self, session_id: u64) {
        let mut guard = self.sessions.lock_unpoisoned();
        guard.remove(&session_id);
    }

    /// Check if a session had a bell since last check.
    pub fn take_bell(&self, session_id: u64) -> bool {
        let mut guard = self.sessions.lock_unpoisoned();
        if let Some(session) = guard.get_mut(&session_id) {
            let count = session.terminal.bell_count();
            // Note: bell_count is cumulative; frontend handles throttling.
            count > 0
        } else {
            false
        }
    }

    /// Get the terminal title.
    pub fn title(&self, session_id: u64) -> Option<String> {
        let guard = self.sessions.lock_unpoisoned();
        guard
            .get(&session_id)
            .and_then(|s| s.terminal.title().map(|t| t.to_string()))
    }
}

fn cell_to_string(cell: &Cell) -> String {
    let ch = cell.ch();
    if ch == '\0' {
        " ".to_string()
    } else {
        ch.to_string()
    }
}
