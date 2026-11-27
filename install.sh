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
