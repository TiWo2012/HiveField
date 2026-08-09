// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `hivefield --doctor`: print the diagnostics blob (same data as the
    // palette's "Copy diagnostics") to stdout and exit without booting the
    // app — for users who can't open the UI. Note: release builds hide the
    // console on Windows (`windows_subsystem`), so there the palette action
    // is the way to get diagnostics.
    if std::env::args().any(|a| a == "--doctor" || a == "doctor") {
        let blob = hivefield_lib::diagnostics_cli();
        println!(
            "{}",
            serde_json::to_string_pretty(&blob).expect("diagnostics blob must serialize")
        );
        return;
    }
    hivefield_lib::run();
}
