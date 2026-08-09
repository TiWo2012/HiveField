<#
.SYNOPSIS
    hiveField Terminal installer for Windows.

.DESCRIPTION
    Downloads a hiveField Terminal release from GitHub and installs it to
    %LOCALAPPDATA%\hivefield\bin (unless HF_INSTALL_DIR overrides), then adds
    that directory to the user PATH so `hivefield` runs from any shell.

    Usage (piped straight into PowerShell, no git clone needed):

        irm https://raw.githubusercontent.com/TiWo2012/HiveField/master/install.ps1 | iex

    The install location, asset naming, and env overrides mirror the repo's
    install.sh and the app's built-in updater (src-tauri/src/updater.rs) —
    the three MUST agree.

    Environment overrides:
        HF_VERSION        release tag to install, e.g. "v0.2.0" (default: latest)
        HF_INSTALL_DIR    directory to install into
                          (default: %LOCALAPPDATA%\hivefield\bin, created if missing)
        HF_NO_PATH        set to "1" to skip adding the install dir to the user PATH
        HF_REPO           GitHub repo to fetch from (default: TiWo2012/HiveField)
        HF_API_BASE       GitHub API base URL override (testing only)
        HF_DOWNLOAD_BASE  download base URL override (testing only)

    Prints where the binary was installed. Exits non-zero on any failure.
#>

$ErrorActionPreference = 'Stop'
# Skip progress-bar rendering (dramatically speeds up downloads on PS 5.1).
$ProgressPreference = 'SilentlyContinue'
# Ensure TLS 1.2 on older Windows PowerShell builds.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$repo = if ($env:HF_REPO) { $env:HF_REPO } else { 'TiWo2012/HiveField' }
$apiBase = if ($env:HF_API_BASE) { $env:HF_API_BASE } else { "https://api.github.com/repos/$repo" }
$downloadBase = if ($env:HF_DOWNLOAD_BASE) { $env:HF_DOWNLOAD_BASE } else { "https://github.com/$repo/releases/download" }
$binName = 'hivefield.exe'
$headers = @{ 'User-Agent' = 'hivefield-installer/1.0' }

function Write-Step { param([string]$Message) Write-Host "==> $Message" }

# Resolve the install directory. Must mirror updater.rs `install_dir()` and
# install.sh's `install_dir()`.
function Resolve-InstallDir {
    if ($env:HF_INSTALL_DIR) { return $env:HF_INSTALL_DIR }
    if ($env:LOCALAPPDATA) { return (Join-Path $env:LOCALAPPDATA 'hivefield\bin') }
    throw 'HF_INSTALL_DIR is not set and LOCALAPPDATA is unavailable; set HF_INSTALL_DIR to choose an install location'
}

# Map the processor architecture to the keys used in release asset names
# (PROCESSOR_ARCHITEW6432 covers 32-bit PowerShell on a 64-bit OS).
function Resolve-Arch {
    $proc = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    switch ($proc) {
        'AMD64' { return 'x86_64' }
        'ARM64' { return 'aarch64' }
        default { throw "unsupported architecture: $proc" }
    }
}

# Resolve the release tag: HF_VERSION override, else the latest release.
function Resolve-Version {
    if ($env:HF_VERSION) {
        $v = $env:HF_VERSION.TrimStart('v')
        Write-Step "Installing hiveField v$v"
        return $v
    }
    Write-Step 'Checking GitHub for the latest hiveField release...'
    $latest = Invoke-RestMethod -Uri "$apiBase/releases/latest" -Headers $headers
    $v = $latest.tag_name.TrimStart('v')
    Write-Step "Latest release: v$v"
    return $v
}

$arch = Resolve-Arch
$installDir = Resolve-InstallDir
$version = Resolve-Version

$asset = "hivefield-windows-$arch.exe"
$url = "$downloadBase/v$version/$asset"
Write-Step "Downloading $asset..."
$tmpDir = Join-Path $env:TEMP "hivefield-install-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
$tmpExe = Join-Path $tmpDir $asset
try {
    Invoke-WebRequest -Uri $url -OutFile $tmpExe -Headers $headers -UseBasicParsing
} catch {
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
    throw "failed to download $url : $($_.Exception.Message)"
}

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$dest = Join-Path $installDir $binName
Copy-Item -Path $tmpExe -Destination $dest -Force
Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "Installed hiveField v$version to $dest"

if ($env:HF_NO_PATH -eq '1') {
    Write-Host 'PATH update skipped (HF_NO_PATH=1). Add the install dir to PATH yourself.'
    return
}

# Add the install dir to the *user* PATH (registry) when missing, so it
# survives across sessions. Current terminals keep their old PATH — a fresh
# one is needed before `hivefield` resolves.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -and ($userPath.Split(';') -contains $installDir)) {
    Write-Host "$installDir is already on your user PATH."
} else {
    $newPath = if ($userPath) { "$userPath;$installDir" } else { $installDir }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Host "Added $installDir to your user PATH."
    Write-Host 'Open a new terminal for the change to take effect, then run: hivefield'
}
