# End-to-end test for the repo's install.ps1, run on Windows CI.
#
# install.ps1 talks to GitHub over Invoke-RestMethod / Invoke-WebRequest; this
# test starts a local HttpListener that serves a canned GitHub API response +
# release asset, and points install.ps1 at it via the HF_API_BASE /
# HF_DOWNLOAD_BASE overrides, so the real resolve/download/install logic runs
# with zero network access. It exercises:
#   - architecture detection (x86_64 on CI runners)
#   - version resolution (latest-release API *and* the HF_VERSION pin)
#   - install-location resolution (HF_INSTALL_DIR) and exe placement
#   - the HF_NO_PATH escape hatch (no registry writes in CI)
#
# Run from the repo root:  .github/scripts/test-install.ps1
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$mock = Join-Path $env:TEMP ("hivefield-install-test-" + [guid]::NewGuid().ToString('N'))
$apiDir = Join-Path $mock 'api'
$assetDir = Join-Path $mock 'assets'
New-Item -ItemType Directory -Force -Path $apiDir, $assetDir | Out-Null

# ---- build a fake release: GitHub API response + exe asset ----
$tag = 'v9.9.9-test'
$asset = 'hivefield-windows-x86_64.exe'
Set-Content -Path (Join-Path $assetDir $asset) -Value 'mock-hivefield-exe' -NoNewline

$latestJson = @{
    tag_name = $tag
    assets   = @(@{
        name                 = $asset
        browser_download_url = "http://127.0.0.1:18765/dl/$tag/$asset"
        size                 = 42
    })
} | ConvertTo-Json -Depth 4
Set-Content -Path (Join-Path $apiDir 'latest.json') -Value $latestJson

# ---- minimal mock GitHub: /releases/latest -> API json, /releases/download/* -> asset ----
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add('http://127.0.0.1:18765/')
$listener.Start()
# Serve the mock in a Start-ThreadJob (bundled with PowerShell 7): the job gives
# the scriptblock a real runspace. [Task]::Run([Action]{...}) cannot run a
# scriptblock on a thread-pool thread in pwsh — it dies with "There is no
# Runspace available to run scripts in this thread" before serving a single
# request, which made this test fail on every CI run.
$serverJob = Start-ThreadJob -ArgumentList $listener, $apiDir, $assetDir -ScriptBlock {
    param($listener, $apiDir, $assetDir)
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        try {
            $path = $ctx.Request.Url.AbsolutePath
            if ($path -like '*/releases/latest') {
                $file = Join-Path $apiDir 'latest.json'
            } elseif ($path -like '*/releases/download/*') {
                $file = Join-Path $assetDir ([IO.Path]::GetFileName($path))
            } else {
                $ctx.Response.StatusCode = 404
                continue
            }
            if (-not (Test-Path $file)) {
                $ctx.Response.StatusCode = 404
            } else {
                $bytes = [IO.File]::ReadAllBytes($file)
                $ctx.Response.ContentType = 'application/octet-stream'
                $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        } catch {
            $ctx.Response.StatusCode = 500
        } finally {
            $ctx.Response.Close()
        }
    }
}

try {
    $env:HF_API_BASE = 'http://127.0.0.1:18765/mock'
    $env:HF_DOWNLOAD_BASE = 'http://127.0.0.1:18765/releases/download'
    $env:HF_INSTALL_DIR = Join-Path $mock 'install'
    $env:HF_NO_PATH = '1'
    Remove-Item Env:HF_VERSION -ErrorAction SilentlyContinue

    # 1. Latest-release resolution (no HF_VERSION).
    & (Join-Path $root 'install.ps1')
    $exe = Join-Path $env:HF_INSTALL_DIR 'hivefield.exe'
    if (-not (Test-Path $exe)) { throw "install.ps1 did not install $exe" }
    if ((Get-Content -Raw $exe) -notlike '*mock-hivefield-exe*') { throw 'installed exe content mismatch' }
    Write-Host "PASS: install.ps1 (latest resolution) -> $exe"

    # 2. Pinned version (HF_VERSION skips the API query).
    $env:HF_VERSION = $tag
    & (Join-Path $root 'install.ps1')
    if (-not (Test-Path $exe)) { throw "install.ps1 (pinned) did not install $exe" }
    Write-Host "PASS: install.ps1 (HF_VERSION pin) -> $exe"

    Write-Host 'install.ps1 end-to-end test PASSED'
} finally {
    $listener.Stop()
    $serverJob | Wait-Job -Timeout 5 | Out-Null
    Remove-Job -Force $serverJob
    Remove-Item Env:HF_API_BASE, Env:HF_DOWNLOAD_BASE, Env:HF_INSTALL_DIR, Env:HF_NO_PATH, Env:HF_VERSION -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $mock -ErrorAction SilentlyContinue
}
