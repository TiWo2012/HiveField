#!/bin/sh
# hiveField installer — downloads and installs a hiveField Terminal release
# from GitHub (https://github.com/TiWo2012/HiveField) into a user-local bin
# directory.
#
# Usage (piped straight into sh, no clone needed):
#
#   curl -fsSL https://raw.githubusercontent.com/TiWo2012/HiveField/master/install.sh | sh
#
# Environment overrides (also honored by the app's built-in updater, see
# src-tauri/src/updater.rs — the two MUST agree on the install location):
#
#   HF_VERSION      release tag to install, e.g. "v0.2.0" or "0.2.0"
#                   (default: the latest release)
#   HF_INSTALL_DIR  directory to install into
#                   (default: $HOME/.local/bin, created if missing)
#
# On Linux the installer also registers a .desktop menu entry (and app
# icon) under $XDG_DATA_HOME (default ~/.local/share) so hiveField shows up
# in the application launcher — see install_desktop_entry(). On macOS it
# registers a minimal .app bundle in ~/Applications (Launchpad/Spotlight) —
# see install_app_bundle(). Both are best-effort and rewritten on every
# install/update.
#
# Prints where the binary was installed. Exits non-zero on any failure.
set -e

REPO="TiWo2012/HiveField"
BIN_NAME="hivefield"

say() { printf '%s\n' "$*"; }
die() { say "error: $*" >&2; exit 1; }

# Resolve the install directory. Must mirror updater.rs `install_dir()`.
install_dir() {
    if [ -n "${HF_INSTALL_DIR:-}" ]; then
        printf '%s' "$HF_INSTALL_DIR"
    elif [ -n "${HOME:-}" ]; then
        printf '%s' "$HOME/.local/bin"
    else
        die "HOME is not set; set HF_INSTALL_DIR to choose an install location"
    fi
}

# Linux only: install the app icon (when the release ships one) and write a
# .desktop menu entry so hiveField shows up in the application launcher. The
# entry lives in $XDG_DATA_HOME/applications (default
# $HOME/.local/share/applications) and the icon in the hicolor theme under
# the same data dir — the standard user-local locations, no root needed.
# Best-effort: a failure here must not undo a successful binary install.
# Must mirror updater.rs `register_desktop_entry()` — same paths, same entry.
install_desktop_entry() {
    bin_path="$1"
    stagedir="$2"

    if [ -z "${XDG_DATA_HOME:-}" ] && [ -z "${HOME:-}" ]; then
        return 1
    fi
    if [ -n "${XDG_DATA_HOME:-}" ]; then
        data_home="$XDG_DATA_HOME"
    else
        data_home="$HOME/.local/share"
    fi

    # New releases ship hivefield.png in the tarball next to the binary;
    # older releases / bare-binary assets have none, so fall back to a stock
    # terminal icon in the entry.
    icon_src=""
    for candidate in "$stagedir/hivefield.png" "$stagedir/128x128.png"; do
        [ -f "$candidate" ] && icon_src="$candidate" && break
    done
    if [ -z "$icon_src" ]; then
        icon_src="$(find "$stagedir" -type f \( -name 'hivefield.png' -o -name '128x128.png' \) 2>/dev/null | head -n1)"
    fi
    if [ -n "$icon_src" ]; then
        icon_dir="$data_home/icons/hicolor/128x128/apps"
        mkdir -p "$icon_dir" || return 1
        cp "$icon_src" "$icon_dir/hivefield.png" || return 1
        icon_name="hivefield"
        # Refresh icon caches when the tooling exists (best-effort) so the
        # launcher picks the icon up immediately.
        if command -v gtk-update-icon-cache >/dev/null 2>&1; then
            gtk-update-icon-cache -f -t "$data_home/icons/hicolor" >/dev/null 2>&1 || true
        fi
    else
        icon_name="utilities-terminal"
    fi

    apps_dir="$data_home/applications"
    mkdir -p "$apps_dir" || return 1
    desktop_file="$apps_dir/hivefield.desktop"
    {
        printf '[Desktop Entry]\n'
        printf 'Type=Application\n'
        printf 'Version=1.0\n'
        printf 'Name=hiveField Terminal\n'
        printf 'GenericName=Terminal\n'
        printf 'Comment=A desktop terminal for coding-agent workflows\n'
        printf 'Exec="%s"\n' "$bin_path"
        printf 'Icon=%s\n' "$icon_name"
        printf 'Terminal=false\n'
        printf 'Categories=TerminalEmulator;System;Utility;\n'
        printf 'Keywords=terminal;shell;console;\n'
        printf 'StartupNotify=true\n'
    } > "$desktop_file" || return 1
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$apps_dir" >/dev/null 2>&1 || true
    fi
    say "Registered a desktop menu entry ($desktop_file)"
}

# macOS only: create/refresh a minimal .app bundle in $HOME/Applications so
# hiveField shows up in Launchpad, Spotlight, and Finder's Applications. The
# bundle wraps a copy of the installed binary plus an Info.plist (the
# release tarball optionally ships the icon as hivefield.icns). It is
# rewritten on every install/update so it always runs the current binary.
# Best-effort: a failure here must not undo a successful binary install.
# Must mirror updater.rs `register_app_bundle()` — same paths, same plist.
install_app_bundle() {
    bin_path="$1"
    stagedir="$2"
    version="${3#v}"

    [ -n "${HOME:-}" ] || return 1
    apps_dir="$HOME/Applications"
    app_dir="$apps_dir/hiveField Terminal.app"
    tmp_app="$apps_dir/hiveField Terminal.app.new.$$"

    mkdir -p "$apps_dir" || return 1
    rm -rf "$tmp_app"
    mkdir -p "$tmp_app/Contents/MacOS" "$tmp_app/Contents/Resources" || { rm -rf "$tmp_app"; return 1; }

    cp "$bin_path" "$tmp_app/Contents/MacOS/hivefield" || { rm -rf "$tmp_app"; return 1; }
    chmod +x "$tmp_app/Contents/MacOS/hivefield" 2>/dev/null || true

    # New releases ship hivefield.icns in the tarball; older releases have
    # none, in which case Launchpad shows a generic icon.
    icns=""
    for candidate in "$stagedir/hivefield.icns" "$stagedir/icon.icns"; do
        [ -f "$candidate" ] && icns="$candidate" && break
    done
    if [ -z "$icns" ]; then
        icns="$(find "$stagedir" -type f -name '*.icns' 2>/dev/null | head -n1)"
    fi
    if [ -n "$icns" ]; then
        cp "$icns" "$tmp_app/Contents/Resources/icon.icns" || true
    fi

    # Finder/About show the short version (drop the "-build.N" suffix);
    # CFBundleVersion carries the full tag so Launchpad can tell builds apart.
    short_version="${version%%-build.*}"
    cat > "$tmp_app/Contents/Info.plist" <<EOF || { rm -rf "$tmp_app"; return 1; }
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>hiveField</string>
  <key>CFBundleDisplayName</key>
  <string>hiveField Terminal</string>
  <key>CFBundleIdentifier</key>
  <string>dev.hivefield.terminal</string>
  <key>CFBundleExecutable</key>
  <string>hivefield</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>$version</string>
  <key>CFBundleShortVersionString</key>
  <string>$short_version</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.13</string>
</dict>
</plist>
EOF

    # Swap the new bundle in (rename over a non-empty dir fails on unix, so
    # drop the old one first; Launchpad re-indexes ~/Applications).
    rm -rf "$app_dir" && mv "$tmp_app" "$app_dir" || { rm -rf "$tmp_app"; return 1; }
    say "Registered the app in Launchpad ($app_dir)"
}

# Map `uname` output to the OS/arch keys used in release asset names.
detect_platform() {
    os="$(uname -s 2>/dev/null || printf 'unknown')"
    mach="$(uname -m 2>/dev/null || printf 'unknown')"
    case "$os" in
        Linux) os_key="linux" ;;
        Darwin) os_key="macos" ;;
        MINGW*|MSYS*|CYGWIN*) os_key="windows" ;;
        *) die "unsupported OS: $os" ;;
    esac
    case "$mach" in
        x86_64|amd64) arch="x86_64" ;;
        aarch64|arm64) arch="aarch64" ;;
        *) die "unsupported architecture: $mach" ;;
    esac
}

# Resolve the release tag: HF_VERSION override, else the latest release.
resolve_version() {
    if [ -n "${HF_VERSION:-}" ]; then
        version="$HF_VERSION"
        case "$version" in v*) ;; *) version="v$version" ;; esac
        say "Installing hiveField $version"
        return
    fi
    say "Checking GitHub for the latest hiveField release…"
    json="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")" \
        || die "failed to query GitHub releases for $REPO"
    version="$(printf '%s' "$json" \
        | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 \
        | cut -d'"' -f4)"
    [ -n "$version" ] || die "could not determine the latest release version"
    say "Latest release: $version"
}

# Asset candidates for this platform, in order of preference. Must mirror
# updater.rs `select_asset()`: canonical tarball, bare platform binary, then
# the plain `hivefield` binary older releases publish.
asset_candidates() {
    if [ "$os_key" = "windows" ]; then
        printf '%s\n' "hivefield-windows-$arch.exe"
        return
    fi
    printf '%s\n' "hivefield-$os_key-$arch.tar.gz"
    printf '%s\n' "hivefield-$os_key-$arch"
    printf '%s\n' "$BIN_NAME"
}

download_and_install() {
    INSTALL_DIR="$(install_dir)"

    tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/hivefield-install.XXXXXX")"
    trap 'rm -rf "$tmpdir"' EXIT INT TERM

    # Try each candidate until one downloads; a failed probe must not abort
    # the whole install (curl -f exits non-zero on 404 and writes nothing).
    asset=""
    for candidate in $(asset_candidates); do
        url="https://github.com/$REPO/releases/download/$version/$candidate"
        if curl -fsSL --max-time 120 "$url" -o "$tmpdir/$candidate" 2>/dev/null; then
            asset="$candidate"
            say "Downloading $candidate…"
            break
        fi
    done
    [ -n "$asset" ] || die "no downloadable asset for $os_key-$arch in release $version"

    # Extract tarballs (the canonical linux/macos asset); a raw binary is
    # used as-is.
    case "$asset" in
        *.tar.gz|*.tgz)
            tar -xzf "$tmpdir/$asset" -C "$tmpdir" || die "failed to extract $asset"
            ;;
    esac

    # Locate the binary — a tarball may nest it in a directory.
    bin=""
    for candidate in "$tmpdir/$BIN_NAME" "$tmpdir/$BIN_NAME.exe"; do
        [ -f "$candidate" ] && bin="$candidate" && break
    done
    if [ -z "$bin" ]; then
        bin="$(find "$tmpdir" -type f \( -name "$BIN_NAME" -o -name "$BIN_NAME.exe" \) | head -n1)"
    fi
    [ -n "$bin" ] || die "release $version does not contain a '$BIN_NAME' binary"

    mkdir -p "$INSTALL_DIR" || die "failed to create $INSTALL_DIR"
    dest="$INSTALL_DIR/$BIN_NAME"
    [ "$os_key" = "windows" ] && dest="$INSTALL_DIR/$BIN_NAME.exe"
    cp "$bin" "$dest" || die "failed to install to $dest"
    chmod +x "$dest" 2>/dev/null || true

    # Linux: register a .desktop menu entry so the app shows up in the
    # application launcher (best-effort, see install_desktop_entry).
    if [ "$os_key" = "linux" ]; then
        install_desktop_entry "$dest" "$tmpdir" || \
            say "warning: could not register a desktop menu entry — hivefield is still installed and runnable"
    fi

    # macOS: register a Launchpad .app bundle (best-effort, see
    # install_app_bundle).
    if [ "$os_key" = "macos" ]; then
        install_app_bundle "$dest" "$tmpdir" "$version" || \
            say "warning: could not register the app in Launchpad — hivefield is still installed and runnable"
    fi

    say ""
    say "Installed hiveField $version to $dest"
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) ;;
        *)
            say "Note: $INSTALL_DIR is not on your PATH — add it with:"
            say "  export PATH=\"$INSTALL_DIR:\$PATH\""
            ;;
    esac
}

detect_platform
resolve_version
download_and_install
