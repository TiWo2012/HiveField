#!/bin/sh
# End-to-end test for the repo's install.sh, run on Linux and macOS CI.
#
# install.sh talks to GitHub over curl; this test stubs curl with a shim that
# serves a canned GitHub API response + release assets from a local mock
# directory, so the real resolve/download/extract/install logic runs with zero
# network access. It exercises:
#   - OS/arch detection (including the macOS "Darwin" path)
#   - version resolution (latest-release API *and* the HF_VERSION pin)
#   - asset-candidate probing + tarball extraction
#   - install-location resolution (HF_INSTALL_DIR) and binary placement
#
# Run from the repo root:  .github/scripts/test-install.sh
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MOCK="$(mktemp -d "${TMPDIR:-/tmp}/hivefield-install-test.XXXXXX")"
trap 'rm -rf "$MOCK"' EXIT INT TERM

# ---- platform under test (mirrors install.sh's detect_platform) ----
os_key="$(uname -s)"
case "$os_key" in
    Linux) os="linux" ;;
    Darwin) os="macos" ;;
    *) echo "unsupported test host: $os_key"; exit 1 ;;
esac
case "$(uname -m)" in
    x86_64|amd64) arch="x86_64" ;;
    aarch64|arm64) arch="aarch64" ;;
    *) echo "unsupported test arch: $(uname -m)"; exit 1 ;;
esac

# ---- build a fake release: GitHub API response + tarball asset ----
API_DIR="$MOCK/api"
ASSET_DIR="$MOCK/assets"
mkdir -p "$API_DIR" "$ASSET_DIR"

tag="v9.9.9-test"
asset="hivefield-$os-$arch.tar.gz"

# A fake "binary": a shell script that prints a marker. Tar it into the
# canonical asset name (a tarball containing a `hivefield` binary).
fake_bin="$MOCK/hivefield"
printf '#!/bin/sh\nprintf "%%s\\n" mock-hivefield-%s-%s\n' "$os" "$arch" > "$fake_bin"
chmod +x "$fake_bin"
tar -czf "$ASSET_DIR/$asset" -C "$MOCK" hivefield
rm -f "$fake_bin"

# Publish the SHA-256 manifest the installer verifies against (sha256sum
# format, asset name relative to the release).
if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$ASSET_DIR" && sha256sum "$asset" > checksums.txt )
else
    ( cd "$ASSET_DIR" && shasum -a 256 "$asset" > checksums.txt )
fi

cat > "$API_DIR/latest.json" <<EOF
{"tag_name":"$tag","assets":[{"name":"$asset","browser_download_url":"http://127.0.0.1:1/dl/$tag/$asset","size":123}]}
EOF

# ---- curl shim: serve the mock API + assets from local files ----
cat > "$MOCK/curl" <<'STUB'
#!/bin/sh
url=""
out=""
want_out=0
for arg in "$@"; do
    case "$arg" in
        http://*|https://*) url="$arg" ;;
        -o) want_out=1 ;;
        *)
            if [ "$want_out" = 1 ]; then out="$arg"; want_out=0; fi
            ;;
    esac
done
[ -n "$url" ] || exit 22
case "$url" in
    *"/releases/latest"*|*"/releases/tags/"*)
        cat "$MOCK_DIR/api/latest.json"
        exit 0
        ;;
esac
case "$url" in
    *"/releases/download/"*)
        file="$MOCK_DIR/assets/$(basename "$url")"
        if [ -f "$file" ]; then
            cp "$file" "$out"
            exit 0
        fi
        exit 22   # curl's "HTTP page not retrieved": probe the next candidate
        ;;
esac
exit 22
STUB
chmod +x "$MOCK/curl"

export MOCK_DIR="$MOCK"
export PATH="$MOCK:$PATH"

run_install() {
    dir="$1"
    HF_INSTALL_DIR="$dir" sh "$ROOT/install.sh" > "$dir/install.log" 2>&1
}

assert_installed() {
    dir="$1"
    if ! run_install "$dir"; then
        echo "FAIL: install.sh exited non-zero"
        cat "$dir/install.log"
        exit 1
    fi
    bin="$dir/hivefield"
    [ -x "$bin" ] || {
        echo "FAIL: no executable installed at $bin"
        cat "$dir/install.log"
        exit 1
    }
    got="$(sh "$bin")"
    expected="mock-hivefield-$os-$arch"
    [ "$got" = "$expected" ] || {
        echo "FAIL: installed binary output '$got' != '$expected'"
        exit 1
    }
    echo "PASS: install.sh -> $bin"
}

# 1. Latest-release resolution (no HF_VERSION: hits the mock /releases/latest).
dir1="$MOCK/install-latest"
mkdir -p "$dir1"
assert_installed "$dir1"

# 2. Pinned version (HF_VERSION skips the API query).
dir2="$MOCK/install-pinned"
mkdir -p "$dir2"
HF_VERSION="$tag" assert_installed "$dir2"

# 3. Tampered asset: a manifest with the wrong digest must abort the install
#    and leave no binary behind.
good_checksums="$(cat "$ASSET_DIR/checksums.txt")"
printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" "$asset" > "$ASSET_DIR/checksums.txt"
dir3="$MOCK/install-tampered"
mkdir -p "$dir3"
if HF_INSTALL_DIR="$dir3" sh "$ROOT/install.sh" > "$dir3/install.log" 2>&1; then
    echo "FAIL: install.sh accepted an asset with a mismatched SHA-256"
    cat "$dir3/install.log"
    exit 1
fi
if [ -e "$dir3/hivefield" ]; then
    echo "FAIL: install.sh installed a binary despite a checksum mismatch"
    exit 1
fi
grep -q 'SHA-256 mismatch' "$dir3/install.log" || {
    echo "FAIL: checksum mismatch message missing from install log"
    cat "$dir3/install.log"
    exit 1
}
echo "PASS: install.sh rejects a tampered asset"

# 4. Missing manifest: a release without checksums.txt must not install.
rm -f "$ASSET_DIR/checksums.txt"
dir4="$MOCK/install-no-checksums"
mkdir -p "$dir4"
if HF_INSTALL_DIR="$dir4" sh "$ROOT/install.sh" > "$dir4/install.log" 2>&1; then
    echo "FAIL: install.sh installed from a release with no checksums.txt"
    cat "$dir4/install.log"
    exit 1
fi
if [ -e "$dir4/hivefield" ]; then
    echo "FAIL: install.sh installed a binary with no checksum manifest"
    exit 1
fi
printf '%s\n' "$good_checksums" > "$ASSET_DIR/checksums.txt"
echo "PASS: install.sh rejects a release with no checksum manifest"

echo "install.sh end-to-end test PASSED on $os-$arch"
