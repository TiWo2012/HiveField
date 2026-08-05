mod pty;

use std::sync::Mutex;

use tauri::State;

/// Managed state holding the live PTY session (spawned lazily in `setup`).
pub struct PtyState(pub Mutex<Option<pty::PtySession>>);

/// IPC command: send input (keystrokes) from the frontend to the shell's PTY.
#[tauri::command]
fn pty_write(state: State<'_, PtyState>, data: String) -> Result<(), String> {
    pty::write(&state, &data).map_err(|e| e.to_string())
}

/// IPC command: resize the PTY to match the frontend terminal's viewport.
#[tauri::command]
fn pty_resize(state: State<'_, PtyState>, cols: u16, rows: u16) -> Result<(), String> {
    pty::resize(&state, cols, rows).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PtyState(Mutex::new(None)))
        .setup(|app| {
            pty::spawn(app.handle().clone())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![pty_write, pty_resize])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
