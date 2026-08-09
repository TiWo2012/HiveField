//! Built-in updater: checks the `TiWo2012/HiveField` GitHub repository for
//! releases, downloads the latest one, and installs it to the same location
//! the repo's `install.sh` installer uses (`curl | sh`, see the repo root).
//!
//! The install-location logic MUST stay in sync with `install.sh` — both
//! honor the `HF_INSTALL_DIR` environment variable and otherwise fall back to
//! `$HOME/.local/bin` (unix) / `%LOCALAPPDATA%\hivefield\bin` (Windows).
//! Release assets are expected to follow the naming convention
//! `hivefield-<os>-<arch>.tar.gz` (unix, containing a `hivefield` binary) and
//! `hivefield-windows-<arch>.exe` (Windows); a bare `hivefield-<os>-<arch>`
//! binary is accepted as a fallback. The `.github/workflows/release.yml`
//! workflow publishes exactly these assets.
//!
//! IPC surface:
//!
//!   - `updater_check()`  — query the latest release; return the version,
//!     changelog, matching asset, and the install directory (no download).
//!   - `updater_install()` — download the latest release and install it,
//!     emitting `updater://progress` while the download advances and
//!     `updater://done` once it is in place.
//!
//! Both honor the `HF_VERSION` env var to pin a specific release tag (used by
//! tests/CI and matching install.sh).
//!
//! Version comparison: release tags are `v<version>-build.<run_number>` (see
//! `.github/workflows/release.yml`), so the running binary embeds its own CI
//! build number at compile time (build.rs reads `HF_BUILD_NUMBER`) and reports
//! e.g. `0.1.1-build.9` as its version. Without the build number a freshly
//! installed release would compare as older than its own tag and the updater
//! would claim an update is available forever.

use std::cmp::Ordering;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::net::HttpClient;

/// GitHub Releases API base for `TiWo2012/HiveField`.
pub const API_BASE: &str = "https://api.github.com/repos/TiWo2012/HiveField/releases";
/// Env override shared with `install.sh`; wins over the platform default.
pub const INSTALL_DIR_ENV: &str = "HF_INSTALL_DIR";
/// Env override to pin a release tag (shared with `install.sh`).
pub const VERSION_ENV: &str = "HF_VERSION";
/// Name of the installed executable (`.exe` suffix added on Windows).
pub const BIN_NAME: &str = "hivefield";

/// Resolve the install directory: `HF_INSTALL_DIR` env override, else the
/// platform default. Mirrors `install.sh`'s `install_dir()`.
pub fn install_dir() -> Result<String, String> {
    if let Ok(dir) = std::env::var(INSTALL_DIR_ENV) {
        let dir = dir.trim();
        if !dir.is_empty() {
            return Ok(dir.to_string());
        }
    }
    default_install_dir(
        std::env::var("HOME").ok(),
        std::env::var("LOCALAPPDATA").ok(),
    )
}

/// The platform default install dir, parameterized for tests.
fn default_install_dir(home: Option<String>, local_app_data: Option<String>) -> Result<String, String> {
    if cfg!(target_os = "windows") {
        let base = local_app_data.ok_or_else(|| {
            format!("{INSTALL_DIR_ENV} is not set and LOCALAPPDATA is unavailable; set {INSTALL_DIR_ENV} to choose an install location")
        })?;
        Ok(Path::new(&base)
            .join("hivefield")
            .join("bin")
            .to_string_lossy()
            .into_owned())
    } else {
        let home = home.ok_or_else(|| {
            format!("{INSTALL_DIR_ENV} is not set and HOME is unavailable; set {INSTALL_DIR_ENV} to choose an install location")
        })?;
        Ok(Path::new(&home)
            .join(".local")
            .join("bin")
            .to_string_lossy()
            .into_owned())
    }
}

/// OS/arch keys used in release asset names (must match `install.sh`).
fn platform() -> Result<(&'static str, &'static str), String> {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        other => return Err(format!("unsupported architecture: {other}")),
    };
    Ok((os, arch))
}

/// The asset file name for a platform (must match `install.sh`'s `asset_name`).
fn asset_name(os: &str, arch: &str) -> String {
    if os == "windows" {
        format!("hivefield-windows-{arch}.exe")
    } else {
        format!("hivefield-{os}-{arch}.tar.gz")
    }
}

/// The installed executable's file name for a platform.
fn bin_name(os: &str) -> &'static str {
    if os == "windows" {
        "hivefield.exe"
    } else {
        BIN_NAME
    }
}

/// One release asset.
struct Asset {
    name: String,
    url: String,
    size: u64,
}

/// Pick the release asset matching this platform: the canonical
/// `hivefield-<os>-<arch>.tar.gz` (or `.exe` on Windows) first, then a bare
/// `hivefield-<os>-<arch>` binary, then a plain `hivefield` binary (what the
/// repo's earlier releases publish). Must mirror install.sh's `asset_candidates`.
fn select_asset(release: &serde_json::Value, os: &str, arch: &str) -> Option<Asset> {
    let assets = release.get("assets")?.as_array()?;
    let mut wanted = vec![
        asset_name(os, arch),
        format!("hivefield-{os}-{arch}"),
        BIN_NAME.to_string(),
    ];
    // De-duplicate in case a fallback equals the primary (never for the
    // current convention, but cheap insurance).
    wanted.dedup();
    for name in wanted {
        for asset in assets {
            // Skip malformed entries instead of aborting the whole search.
            let Some(asset_name) = asset.get("name").and_then(serde_json::Value::as_str) else {
                continue;
            };
            if asset_name != name {
                continue;
            }
            return Some(Asset {
                name: asset_name.to_string(),
                url: asset
                    .get("browser_download_url")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                size: asset.get("size").and_then(serde_json::Value::as_u64).unwrap_or(0),
            });
        }
    }
    None
}

/// Fetch the release JSON: the latest release, or the release for a pinned
/// tag when `version` is set (`v` prefix optional).
fn fetch_release(client: &HttpClient, version: Option<&str>) -> Result<serde_json::Value, String> {
    let url = match version {
        Some(v) => format!("{API_BASE}/tags/{}", v.trim_start_matches('v')),
        None => format!("{API_BASE}/latest"),
    };
    let text = client.get_text(&url)?;
    serde_json::from_str(&text).map_err(|e| format!("failed to parse GitHub release JSON: {e}"))
}

/// Split a version string into its numeric components, ignoring separators
/// and non-numeric suffixes: `"v0.1.1-build.5"` → `[0, 1, 1, 5]`.
fn parse_version(version: &str) -> Vec<u64> {
    version
        .trim()
        .trim_start_matches('v')
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

/// Compare two version strings numerically, component by component (missing
/// components count as 0). `"0.1.1" < "0.1.1-build.5"` because the build
/// number makes the latter's component list longer.
fn version_cmp(a: &str, b: &str) -> Ordering {
    let mut left = parse_version(a);
    let mut right = parse_version(b);
    let len = left.len().max(right.len());
    left.resize(len, 0);
    right.resize(len, 0);
    left.cmp(&right)
}

/// Build a version string from a package version and an optional build
/// number: `("0.1.1", Some("9"))` → `"0.1.1-build.9"`, `("0.1.1", None)`
/// → `"0.1.1"`. Blank build numbers are treated as absent (local/dev builds).
fn full_version(pkg_version: &str, build: Option<&str>) -> String {
    match build.map(str::trim) {
        Some(b) if !b.is_empty() => format!("{pkg_version}-build.{b}"),
        _ => pkg_version.to_string(),
    }
}

/// The full version of the running binary: `CARGO_PKG_VERSION` plus the CI
/// build number embedded by build.rs (`HF_BUILD_NUMBER`), when present.
fn current_version() -> String {
    full_version(env!("CARGO_PKG_VERSION"), option_env!("HF_BUILD_NUMBER"))
}

/// The `updater_check` result: what the latest release is, which asset
/// matches this platform, and where it would be installed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub published_at: String,
    pub changelog: String,
    pub html_url: String,
    pub asset_name: String,
    pub asset_url: String,
    pub asset_size: u64,
    pub install_dir: String,
    pub update_available: bool,
}

/// Download progress for `updater://progress` events.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub percent: u8,
    pub total: u64,
}

/// Result of a completed install for `updater://done` events / the command
/// return value.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDone {
    pub version: String,
    pub path: String,
}

/// IPC command: check for updates. Returns the latest release info from
/// `TiWo2012/HiveField` plus the install directory; does not download
/// anything. Async + `spawn_blocking`: the GitHub query is a network call and
/// must not block the webview's IPC thread.
#[tauri::command]
pub async fn updater_check() -> Result<UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(|| check_blocking())
        .await
        .map_err(|e| format!("update check task failed: {e}"))?
}

fn check_blocking() -> Result<UpdateInfo, String> {
    let client = HttpClient::default();
    let pinned = pinned_version();
    let release = fetch_release(&client, pinned.as_deref())?;
    let (os, arch) = platform()?;
    let asset = select_asset(&release, os, arch).ok_or_else(|| {
        format!(
            "no release asset for {os}-{arch} (expected {})",
            asset_name(os, arch)
        )
    })?;
    let latest = release
        .get("tag_name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    let current = current_version();
    let update_available = version_cmp(&latest, &current) == Ordering::Greater;
    Ok(UpdateInfo {
        current_version: current,
        latest_version: latest,
        published_at: release
            .get("published_at")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string(),
        changelog: release
            .get("body")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string(),
        html_url: release
            .get("html_url")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string(),
        asset_name: asset.name,
        asset_url: asset.url,
        asset_size: asset.size,
        install_dir: install_dir()?,
        update_available,
    })
}

/// IPC command: download the latest release and install it to the shared
/// install directory. Emits `updater://progress` while downloading and
/// `updater://done` once the binary is in place. Runs on a background thread;
/// the frontend must not invoke a second install while one is running.
#[tauri::command]
pub async fn updater_install(app: AppHandle) -> Result<UpdateDone, String> {
    tauri::async_runtime::spawn_blocking(move || install_blocking(&app))
        .await
        .map_err(|e| format!("update install task failed: {e}"))?
}

/// The pinned release tag from `HF_VERSION`, if any (shared with install.sh).
fn pinned_version() -> Option<String> {
    std::env::var(VERSION_ENV)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn install_blocking(app: &AppHandle) -> Result<UpdateDone, String> {
    let client = HttpClient::default();
    let pinned = pinned_version();
    let release = fetch_release(&client, pinned.as_deref())?;
    let version = release
        .get("tag_name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    let (os, arch) = platform()?;
    let asset = select_asset(&release, os, arch).ok_or_else(|| {
        format!(
            "no release asset for {os}-{arch} (expected {})",
            asset_name(os, arch)
        )
    })?;

    let install_dir = install_dir()?;
    let install_path = PathBuf::from(&install_dir).join(bin_name(os));
    fs::create_dir_all(Path::new(&install_dir))
        .map_err(|e| format!("failed to create install dir {install_dir}: {e}"))?;

    // Stream the asset to a temp file in the system temp dir (never a
    // half-written file in the install dir).
    let archive_path = std::env::temp_dir().join(format!(
        "hivefield-update-{version}-{}",
        asset.name
    ));
    let _ = fs::remove_file(&archive_path);
    {
        let app = app.clone();
        let total = asset.size;
        client
            .get_to_file(&asset.url, &archive_path, move |percent| {
                let _ = app.emit(
                    "updater://progress",
                    UpdateProgress { percent, total },
                );
            })
            .map_err(|e| {
                let _ = fs::remove_file(&archive_path);
                e
            })?;
    }

    // Stage the new binary under a temp name, then rename it over the live
    // one: an interrupted install never leaves a truncated binary behind, and
    // the swap is atomic on unix. On Windows replacing a running exe fails;
    // the error tells the user to close the app and retry.
    let staged = install_path.with_file_name(format!(".{}.new", bin_name(os)));
    let _ = fs::remove_file(&staged);
    let stage_result = (|| -> Result<(), String> {
        if archive_path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("gz") || e.eq_ignore_ascii_case("tgz"))
        {
            extract_binary_from_tar_gz(&archive_path, &staged, os)?;
        } else {
            fs::copy(&archive_path, &staged)
                .map_err(|e| format!("failed to copy downloaded binary: {e}"))?;
        }
        // Keep the executable bit (no-op on Windows).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&staged)
                .map_err(|e| format!("failed to stat staged binary: {e}"))?
                .permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&staged, perms)
                .map_err(|e| format!("failed to chmod staged binary: {e}"))?;
        }
        Ok(())
    })();
    if let Err(e) = stage_result {
        let _ = fs::remove_file(&staged);
        let _ = fs::remove_file(&archive_path);
        return Err(e);
    }

    fs::rename(&staged, &install_path).map_err(|e| {
        let _ = fs::remove_file(&staged);
        format!(
            "failed to install to {}: {e} (close any running hiveField windows and retry)",
            install_path.display()
        )
    })?;
    let _ = fs::remove_file(&archive_path);

    let done = UpdateDone {
        version: version.clone(),
        path: install_path.to_string_lossy().into_owned(),
    };
    let _ = app.emit("updater://done", done.clone());
    log::info!(
        "installed hiveField {version} to {}",
        install_path.display()
    );
    Ok(done)
}

/// Extract the `hivefield` (or `hivefield.exe`) binary from a `.tar.gz`
/// archive into `dest`, wherever it is nested inside the archive.
fn extract_binary_from_tar_gz(archive_path: &Path, dest: &Path, os: &str) -> Result<(), String> {
    let file = fs::File::open(archive_path)
        .map_err(|e| format!("failed to open downloaded archive: {e}"))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let wanted = bin_name(os);
    let mut bytes: Option<Vec<u8>> = None;
    for entry in archive
        .entries()
        .map_err(|e| format!("failed to read archive: {e}"))?
    {
        let mut entry = entry.map_err(|e| format!("failed to read archive entry: {e}"))?;
        let name = entry
            .path()
            .ok()
            .and_then(|p| p.file_name().map(|f| f.to_string_lossy().into_owned()))
            .unwrap_or_default();
        if name == wanted {
            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|e| format!("failed to extract {wanted}: {e}"))?;
            bytes = Some(buf);
            break;
        }
    }
    let bytes = bytes.ok_or_else(|| format!("archive does not contain a {wanted} binary"))?;
    fs::write(dest, bytes).map_err(|e| format!("failed to write staged binary: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_install_dir_is_home_local_bin_on_unix() {
        // Windows resolves LOCALAPPDATA instead; the unix branch is the one
        // exercised by install.sh's curl|sh flow.
        #[cfg(not(target_os = "windows"))]
        assert_eq!(
            default_install_dir(Some("/home/u".to_string()), None).unwrap(),
            "/home/u/.local/bin"
        );
    }

    #[test]
    fn default_install_dir_requires_home() {
        #[cfg(not(target_os = "windows"))]
        assert!(default_install_dir(None, None).is_err());
    }

    #[test]
    fn asset_name_matches_convention() {
        assert_eq!(asset_name("linux", "x86_64"), "hivefield-linux-x86_64.tar.gz");
        assert_eq!(asset_name("linux", "aarch64"), "hivefield-linux-aarch64.tar.gz");
        assert_eq!(asset_name("macos", "aarch64"), "hivefield-macos-aarch64.tar.gz");
        assert_eq!(asset_name("windows", "x86_64"), "hivefield-windows-x86_64.exe");
    }

    #[test]
    fn bin_name_gets_exe_suffix_on_windows() {
        assert_eq!(bin_name("windows"), "hivefield.exe");
        assert_eq!(bin_name("linux"), "hivefield");
        assert_eq!(bin_name("macos"), "hivefield");
    }

    #[test]
    fn parse_version_ignores_prefixes_and_suffixes() {
        assert_eq!(parse_version("0.1.1"), vec![0, 1, 1]);
        assert_eq!(parse_version("v0.1.1"), vec![0, 1, 1]);
        assert_eq!(parse_version("0.1.1-build.5"), vec![0, 1, 1, 5]);
        assert_eq!(parse_version("0.10.0"), vec![0, 10, 0]);
    }

    #[test]
    fn version_cmp_compares_numerically() {
        assert_eq!(version_cmp("0.1.1", "0.1.1"), Ordering::Equal);
        assert_eq!(version_cmp("0.1.1", "0.1.2"), Ordering::Less);
        assert_eq!(version_cmp("0.2.0", "0.10.0"), Ordering::Less);
        assert_eq!(version_cmp("0.1.2", "0.1.1"), Ordering::Greater);
        assert_eq!(version_cmp("0.1.1-build.5", "0.1.1"), Ordering::Greater);
        assert_eq!(version_cmp("v0.1.1", "0.1.1"), Ordering::Equal);
    }

    #[test]
    fn full_version_appends_build_number_when_present() {
        assert_eq!(full_version("0.1.1", Some("9")), "0.1.1-build.9");
        assert_eq!(full_version("0.1.1", Some(" 12 ")), "0.1.1-build.12");
    }

    #[test]
    fn full_version_omits_build_suffix_when_absent() {
        assert_eq!(full_version("0.1.1", None), "0.1.1");
        assert_eq!(full_version("0.1.1", Some("")), "0.1.1");
        assert_eq!(full_version("0.1.1", Some("   ")), "0.1.1");
    }

    #[test]
    fn current_version_always_starts_with_the_package_version() {
        assert!(current_version().starts_with(env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn current_version_matches_the_embedded_build_number() {
        // Verifies build.rs wiring: when HF_BUILD_NUMBER is set at compile
        // time, current_version() must carry the same suffix release tags do.
        // Vacuously true when the env var is absent (local/dev builds).
        if let Some(build) = option_env!("HF_BUILD_NUMBER") {
            assert_eq!(
                current_version(),
                format!("{}-build.{}", env!("CARGO_PKG_VERSION"), build.trim())
            );
        }
    }

    #[test]
    fn same_release_tag_compares_equal_when_build_number_is_embedded() {
        // Regression: a release tag "v0.1.1-build.9" used to compare Greater
        // than the running "0.1.1" (no build number), so the updater claimed
        // an update was available even right after installing that release.
        // A binary built from the release embeds the build number and must
        // compare equal to its own tag.
        assert_eq!(
            version_cmp("0.1.1-build.9", &full_version("0.1.1", Some("9"))),
            Ordering::Equal
        );
        // A newer build of the same version still counts as an update.
        assert_eq!(
            version_cmp("0.1.1-build.10", &full_version("0.1.1", Some("9"))),
            Ordering::Greater
        );
        // And a newer version series wins over an older, higher build.
        assert_eq!(
            version_cmp("0.1.2-build.1", &full_version("0.1.1", Some("50"))),
            Ordering::Greater
        );
        // Without an embedded build number the tag still reads as newer — the
        // old bug, kept here to document what build.rs's HF_BUILD_NUMBER
        // embedding fixes.
        assert_eq!(
            version_cmp("0.1.1-build.9", &full_version("0.1.1", None)),
            Ordering::Greater
        );
    }

    fn release_json(assets: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "tag_name": "v0.2.0",
            "assets": assets.iter().map(|name| serde_json::json!({
                "name": name,
                "browser_download_url": format!("https://github.com/TiWo2012/HiveField/releases/download/v0.2.0/{name}"),
                "size": 1234,
            })).collect::<Vec<_>>(),
        })
    }

    #[test]
    fn select_asset_prefers_the_canonical_tarball() {
        let release = release_json(&[
            "hivefield-linux-x86_64.tar.gz",
            "hivefield-linux-x86_64",
            "hivefield-linux-x86_64.deb",
            "hivefield-linux-x86_64.AppImage",
        ]);
        let asset = select_asset(&release, "linux", "x86_64").expect("asset found");
        assert_eq!(asset.name, "hivefield-linux-x86_64.tar.gz");
        assert!(asset.url.starts_with("https://github.com/TiWo2012/HiveField"));
    }

    #[test]
    fn select_asset_falls_back_to_a_bare_binary() {
        let release = release_json(&["hivefield-macos-aarch64"]);
        let asset = select_asset(&release, "macos", "aarch64").expect("asset found");
        assert_eq!(asset.name, "hivefield-macos-aarch64");
    }

    #[test]
    fn select_asset_falls_back_to_a_plain_hivefield_binary() {
        // The repo's earlier releases publish the raw binary as `hivefield`.
        let release = release_json(&["hivefield", "hiveField.Terminal_0.1.1_amd64.AppImage"]);
        let asset = select_asset(&release, "linux", "x86_64").expect("asset found");
        assert_eq!(asset.name, "hivefield");
    }

    #[test]
    fn select_asset_prefers_windows_exe() {
        let release = release_json(&["hivefield-windows-x86_64.exe", "hivefield-windows-x86_64"]);
        let asset = select_asset(&release, "windows", "x86_64").expect("asset found");
        assert_eq!(asset.name, "hivefield-windows-x86_64.exe");
    }

    #[test]
    fn select_asset_returns_none_when_platform_is_missing() {
        let release = release_json(&["hivefield-linux-aarch64.tar.gz"]);
        assert!(select_asset(&release, "linux", "x86_64").is_none());
        assert!(select_asset(&release, "windows", "x86_64").is_none());
    }

    #[test]
    fn select_asset_ignores_unrelated_assets() {
        let release = release_json(&["hivefield_0.2.0_amd64.deb", "hivefield-linux-x86_64.AppImage"]);
        assert!(select_asset(&release, "linux", "x86_64").is_none());
    }

    #[test]
    fn select_asset_matches_the_real_repo_release() {
        // Snapshot of the asset list TiWo2012/HiveField's latest release
        // published (v0.1.1-build.9) when the updater was written.
        let release = serde_json::json!({
            "tag_name": "v0.1.1-build.9",
            "assets": [
                { "name": "hivefield", "browser_download_url": "https://github.com/TiWo2012/HiveField/releases/download/v0.1.1-build.9/hivefield", "size": 21294736 },
                { "name": "hiveField.Terminal-0.1.1-1.x86_64.rpm", "browser_download_url": "https://example.com/x.rpm", "size": 6380059 },
                { "name": "hiveField.Terminal_0.1.1_amd64.AppImage", "browser_download_url": "https://example.com/x.AppImage", "size": 80579064 },
                { "name": "hiveField.Terminal_0.1.1_amd64.deb", "browser_download_url": "https://example.com/x.deb", "size": 6376710 },
            ],
        });
        let asset = select_asset(&release, "linux", "x86_64").expect("asset found");
        assert_eq!(asset.name, "hivefield");
        assert_eq!(asset.size, 21294736);
    }
}
