//! Logging backend and panic hook.
//!
//! The backend already logs through the `log` crate, but until now nothing
//! installed a `log::Log` implementation, so every `log::info!` / `warn!` /
//! `error!` was silently dropped. This module wires up `tauri-plugin-log`:
//!
//!   - a rotated file at `<app_log_dir>/hivefield.log` (the path the
//!     diagnostics blob reports), capped at 2 MB per file with 3 archived
//!     files kept;
//!   - stderr as a second target in debug builds;
//!   - `HF_LOG` / `RUST_LOG` level control (`info`, `hivefield_lib=debug`,
//!     `hivefield_lib::pty=trace`, ...).
//!
//! [`install_panic_hook`] chains the platform's default hook so a panicking
//! thread records its payload, location, thread name and a forced backtrace
//! in the same log file before the process continues to unwind / abort.

use std::sync::Once;

use log::LevelFilter;
use tauri::plugin::TauriPlugin;
use tauri::Runtime;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

/// Log file stem — `tauri-plugin-log` appends the `.log` extension.
pub const LOG_FILE_STEM: &str = "hivefield";
/// The rotated log file name reported by diagnostics (`--doctor` and palette).
pub const LOG_FILE_NAME: &str = "hivefield.log";

/// Rotate at 2 MB so an app left running for months cannot fill the disk.
const MAX_LOG_FILE_SIZE: u128 = 2 * 1024 * 1024;
/// Number of archived (`hivefield_<timestamp>.log`) files to keep.
const ROTATED_FILES_TO_KEEP: usize = 3;

/// Build the logging plugin. Add it to the Tauri builder before any other
/// plugin whose setup logs, so the global logger exists by then.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    let (level, directives) = env_filter();

    let mut builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .level(level)
        .max_file_size(MAX_LOG_FILE_SIZE)
        .rotation_strategy(RotationStrategy::KeepSome(ROTATED_FILES_TO_KEEP))
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .target(Target::new(TargetKind::LogDir {
            file_name: Some(LOG_FILE_STEM.to_string()),
        }));

    // Release builds are GUI-only (and on Windows have no console), so write
    // to the file only. Debug builds also mirror the log to stderr.
    #[cfg(debug_assertions)]
    {
        builder = builder.target(Target::new(TargetKind::Stderr));
    }

    for module in module_filter_prefixes(directives) {
        builder = builder.level_for(module.0, module.1);
    }

    builder.build()
}

/// Install the panic hook that appends panic details to the log.
///
/// Safe to call more than once (only the first call installs a hook); the
/// previous hook is chained so the normal stderr message is preserved.
pub fn install_panic_hook() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let payload = panic_payload(info);
            let location = info
                .location()
                .map(|loc| format!("{}:{}:{}", loc.file(), loc.line(), loc.column()))
                .unwrap_or_else(|| "<unknown location>".to_string());
            let thread = std::thread::current();
            let thread_name = thread.name().unwrap_or("<unnamed thread>");
            let backtrace = std::backtrace::Backtrace::force_capture();
            log::error!(
                target: "hivefield_lib::panic",
                "thread '{thread_name}' panicked at {location}: {payload}\n\
                 stack backtrace:\n{backtrace}"
            );
            previous_hook(info);
        }));
    });
}

/// Extract the human-readable message from a panic payload.
fn panic_payload(info: &std::panic::PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

/// Resolve the global level and per-module directives from `HF_LOG` (which
/// wins) or `RUST_LOG`.
fn env_filter() -> (LevelFilter, Vec<(String, LevelFilter)>) {
    let raw = std::env::var("HF_LOG")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            std::env::var("RUST_LOG")
                .ok()
                .filter(|s| !s.trim().is_empty())
        });
    match raw {
        Some(raw) => parse_filter(&raw),
        None => (default_level(), Vec::new()),
    }
}

/// The level used when no environment override is present: verbose in debug
/// builds, `info` in release.
fn default_level() -> LevelFilter {
    if cfg!(debug_assertions) {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    }
}

/// Parse an `env_logger`-style filter string: a bare level sets the global
/// filter, `module=level` sets a per-module filter, and a bare module name
/// means "everything from that module" (matching `RUST_LOG` conventions).
fn parse_filter(raw: &str) -> (LevelFilter, Vec<(String, LevelFilter)>) {
    let mut global = default_level();
    let mut global_set = false;
    let mut directives = Vec::new();

    for part in raw.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((module, level)) = part.split_once('=') {
            let module = module.trim();
            if module.is_empty() {
                continue;
            }
            if let Some(level) = parse_level(level) {
                directives.push((module.replace('-', "_"), level));
            }
        } else if let Some(level) = parse_level(part) {
            global = level;
            global_set = true;
        } else {
            directives.push((part.replace('-', "_"), LevelFilter::Trace));
        }
    }

    // An override that only names modules still needs a sensible global
    // threshold, so keep the build default instead of turning everything off.
    if !global_set && directives.is_empty() {
        global = default_level();
    }

    (global, directives)
}

/// Parse a single level name (case-insensitive; numeric values match the
/// `log` crate's ordering).
fn parse_level(raw: &str) -> Option<LevelFilter> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "off" | "0" => Some(LevelFilter::Off),
        "error" | "1" => Some(LevelFilter::Error),
        "warn" | "warning" | "2" => Some(LevelFilter::Warn),
        "info" | "3" => Some(LevelFilter::Info),
        "debug" | "4" => Some(LevelFilter::Debug),
        "trace" | "5" => Some(LevelFilter::Trace),
        _ => None,
    }
}

/// Expand user-facing module prefixes to the names log records actually use.
/// The crate is packaged as `hivefield` but its lib target (where all backend
/// modules live) is `hivefield_lib`, so accept both spellings.
fn module_filter_prefixes(directives: Vec<(String, LevelFilter)>) -> Vec<(String, LevelFilter)> {
    let mut expanded = Vec::with_capacity(directives.len() * 2);
    for (module, level) in directives {
        if module == "hivefield" {
            expanded.push(("hivefield_lib".to_string(), level));
        }
        expanded.push((module, level));
    }
    expanded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_names_are_case_insensitive_and_accept_numbers() {
        assert_eq!(parse_level(" INFO "), Some(LevelFilter::Info));
        assert_eq!(parse_level("Debug"), Some(LevelFilter::Debug));
        assert_eq!(parse_level("warning"), Some(LevelFilter::Warn));
        assert_eq!(parse_level("0"), Some(LevelFilter::Off));
        assert_eq!(parse_level("5"), Some(LevelFilter::Trace));
        assert_eq!(parse_level("verbose"), None);
        assert_eq!(parse_level(""), None);
    }

    #[test]
    fn bare_level_sets_the_global_filter() {
        let (global, directives) = parse_filter("warn");
        assert_eq!(global, LevelFilter::Warn);
        assert!(directives.is_empty());
    }

    #[test]
    fn module_directives_are_parsed_without_changing_the_default() {
        let (global, directives) = parse_filter("hivefield_lib=debug,tauri=trace");
        assert_eq!(global, default_level());
        assert_eq!(
            directives,
            vec![
                ("hivefield_lib".to_string(), LevelFilter::Debug),
                ("tauri".to_string(), LevelFilter::Trace),
            ]
        );
    }

    #[test]
    fn bare_module_names_default_to_trace() {
        let (_, directives) = parse_filter("my-crate");
        assert_eq!(
            directives,
            vec![("my_crate".to_string(), LevelFilter::Trace)]
        );
    }

    #[test]
    fn malformed_directives_are_ignored() {
        let (_, directives) = parse_filter("=debug,foo=nonsense,,");
        assert!(directives.is_empty());
    }

    #[test]
    fn hivefield_module_prefix_also_covers_the_lib_target() {
        let expanded = module_filter_prefixes(vec![("hivefield".to_string(), LevelFilter::Debug)]);
        assert!(expanded.contains(&("hivefield_lib".to_string(), LevelFilter::Debug)));
        assert!(expanded.contains(&("hivefield".to_string(), LevelFilter::Debug)));
    }
}
