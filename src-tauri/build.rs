fn main() {
    // On Windows the app needs Common Controls v6 (Tauri's dialogs call into it).
    // tauri-build embeds that manifest in the app binary only, so every test
    // binary linked from this crate died at launch with
    // STATUS_ENTRYPOINT_NOT_FOUND. Embed it ourselves, for every target.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let manifest =
            std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default())
                .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        tauri_build::try_build(
            tauri_build::Attributes::new()
                .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
        )
        .expect("tauri build");
    } else {
        tauri_build::build();
    }
}
