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
    // manifest's Common-Controls v6 dependency, `cargo test`'s --lib test
    // binary fails to start with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)
    // because it imports TaskDialogIndirect from comctl32, which only exists
    // in v6 — see tauri-apps/tauri#13419/#14580. Link the same resource object
    // into every artifact (including tests) so they get the manifest too.
    // (Check the TARGET os, not the host: this cross-compiles from Linux.)
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
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
