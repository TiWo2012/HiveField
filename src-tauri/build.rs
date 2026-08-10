fn main() {
    // Embed the CI build number (release.yml sets HF_BUILD_NUMBER to
    // github.run_number) so the running binary knows its full version, e.g.
    // "0.1.1-build.9". Release tags are v<version>-build.<run_number> and the
    // built-in updater compares against them (src-tauri/src/updater.rs); a
    // binary that only knows "0.1.1" sorts below every tagged build and the
    // updater would report an update is available even right after installing.
    if let Ok(build) = std::env::var("HF_BUILD_NUMBER") {
        let build = build.trim();
        if !build.is_empty() {
            println!("cargo:rustc-env=HF_BUILD_NUMBER={build}");
        }
    }
    // Rebuild when the variable changes so `option_env!` stays accurate.
    println!("cargo:rerun-if-env-changed=HF_BUILD_NUMBER");
    tauri_build::build();

    // tauri-build embeds the Windows resource (app manifest + icon + version)
    // only into the main binary: tauri-winres -> embed-resource emits
    // `cargo:rustc-link-arg-bins`, which excludes test binaries. Without the
    // manifest's Common-Controls v6 dependency, the `cargo test --lib` harness
    // fails to start with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139) because it
    // imports TaskDialogIndirect from comctl32, which only exists in v6 — see
    // tauri-apps/tauri#13419/#14580. Link the same resource object into every
    // artifact (tests included) via the generic `rustc-link-arg`.
    //
    // This is opt-in via the `test-manifest` feature so normal builds
    // (tauri dev / tauri build) never double-link the resource into the app
    // binary (which already gets it via tauri-build's link-arg-bins and would
    // fail with CVT1100 duplicate resource). CI runs
    // `cargo test --lib --features test-manifest`, which builds only the lib
    // and its test harness — no bins — so there is exactly one copy per
    // artifact. Check the TARGET os, not the host: this cross-compiles.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_FEATURE_TEST_MANIFEST").is_ok()
    {
        let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR is set by cargo");
        // embed-resource names it resource.lib on MSVC and libresource.a on
        // GNU (prefix = "resource" from tauri-winres' resource.rc).
        let out_dir_path = std::path::Path::new(&out_dir);
        let resource = [out_dir_path.join("resource.lib"), out_dir_path.join("libresource.a")]
            .into_iter()
            .find(|p| p.exists());
        if let Some(resource) = resource {
            println!("cargo:rustc-link-arg={}", resource.display());
        }
    }
}
