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
    tauri_build::build()
}
