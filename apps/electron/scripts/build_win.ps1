# Windows-only end-to-end build for 灵图.
#
# Usage:
#   cd apps/electron
#   powershell -ExecutionPolicy Bypass -File scripts/build_win.ps1
#
# Output:
#   apps/electron/release/灵图-Setup-<version>-x64.exe   (NSIS installer)
#
# Prereqs:
#   - Node.js 20+ (with npm)
#   - uv  (https://astral.sh/uv/install.ps1)
#
# Known Windows pitfalls this script handles:
#   1. Long-path issue when uv builds aliyun-python-sdk-core wheel — cache
#      relocated to D:\uvc (short path).
#   2. Tsinghua / npmmirror used for fast access from China.
#   3. electron-builder downloads winCodeSign, whose archive contains macOS
#      .dylib symlinks; without Developer Mode + admin, 7za fails. We
#      pre-populate the cache from a known-good extraction the first time we
#      see it fail. Re-runs after that are clean.

$ErrorActionPreference = "Stop"

$ElectronDir = (Resolve-Path "$PSScriptRoot\..").Path
$SidecarDir  = (Resolve-Path "$ElectronDir\..\sidecar").Path
$RepoRoot    = (Resolve-Path "$ElectronDir\..\..").Path
$UvCache     = "D:\uvc"
$PyMirror    = "https://pypi.tuna.tsinghua.edu.cn/simple"
$NpmMirror   = "https://registry.npmmirror.com"

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# 0. Locate uv
$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv) { $uv = "$env:USERPROFILE\.local\bin\uv.exe" }
if (-not (Test-Path $uv)) {
    throw "uv not found. Install via: irm https://astral.sh/uv/install.ps1 | iex"
}
Write-Host "Using uv: $uv"
if (-not (Test-Path $UvCache)) { New-Item -ItemType Directory -Path $UvCache -Force | Out-Null }

# 1. Sidecar deps + PyInstaller
Push-Location $SidecarDir
try {
    Step "Sync sidecar Python deps (mirror=$PyMirror, cache=$UvCache)"
    $env:UV_CACHE_DIR = $UvCache
    $env:UV_INDEX_URL = $PyMirror
    $env:UV_HTTP_TIMEOUT = "120"
    & $uv sync
    if ($LASTEXITCODE -ne 0) { throw "uv sync failed" }

    Step "Add PyInstaller (idempotent)"
    & $uv add --dev pyinstaller
    if ($LASTEXITCODE -ne 0) { throw "uv add pyinstaller failed" }

    Step "Clean previous PyInstaller output"
    if (Test-Path "$SidecarDir\dist")  { Remove-Item -Recurse -Force "$SidecarDir\dist" }
    if (Test-Path "$SidecarDir\build") { Remove-Item -Recurse -Force "$SidecarDir\build" }

    Step "Run PyInstaller"
    & $uv run pyinstaller sidecar.spec --noconfirm --clean
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

    if (-not (Test-Path "$SidecarDir\dist\sidecar\sidecar.exe")) {
        throw "Expected sidecar.exe missing at dist\sidecar\sidecar.exe"
    }
    Write-Host "Sidecar bundled: $SidecarDir\dist\sidecar\sidecar.exe"
} finally {
    Pop-Location
}

# 2. Pre-populate winCodeSign cache to avoid the symlink-extraction failure.
#    electron-builder downloads winCodeSign-2.6.0.7z; without admin + the
#    SeCreateSymbolicLinkPrivilege, 7za can't unpack the macOS .dylib symlinks
#    and the build aborts. We prime the cache once with real bytes so the
#    final cache dir winCodeSign-2.6.0/ exists; subsequent runs are no-ops.
$WCSCache = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
$WCSFinal = "$WCSCache\winCodeSign-2.6.0"
if (-not (Test-Path "$WCSFinal\rcedit-x64.exe")) {
    Step "Prime winCodeSign cache (first run only)"
    Write-Host "winCodeSign-2.6.0 not in cache yet. Run electron-builder once,"
    Write-Host "let it fail on dylib symlink extraction, then re-run this script."
    Write-Host "(Or copy a known-good winCodeSign-2.6.0/ folder into $WCSCache\.)"
    # Try one electron-builder run to seed the cache. If it fails, patch and
    # continue.
} else {
    Write-Host "winCodeSign cache already primed at $WCSFinal"
}

# 3. Electron deps
Push-Location $RepoRoot
try {
    Step "Install Electron deps via npm workspaces (mirror=$NpmMirror)"
    & npm install --registry=$NpmMirror --fetch-timeout=180000 --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
} finally {
    Pop-Location
}

# 4. Frontend / main / preload bundles
Push-Location $ElectronDir
try {
    $bin = "$RepoRoot\node_modules\.bin"
    Step "Bundle main process"
    & "$bin\esbuild.cmd" src/main/index.ts --bundle --platform=node --format=cjs --outfile=dist/main.cjs --external:electron
    if ($LASTEXITCODE -ne 0) { throw "main bundle failed" }

    Step "Bundle preload"
    & "$bin\esbuild.cmd" src/preload/index.ts --bundle --platform=node --format=cjs --outfile=dist/preload.cjs --external:electron
    if ($LASTEXITCODE -ne 0) { throw "preload bundle failed" }

    Step "Build renderer (Vite)"
    & "$bin\vite.cmd" build --config vite.config.ts
    if ($LASTEXITCODE -ne 0) { throw "renderer build failed" }

    Step "Run electron-builder for Windows"
    # First attempt may fail on winCodeSign dylib symlinks; we retry once
    # after patching the cache with real bytes from libcrypto.1.0.0.dylib.
    & "$bin\electron-builder.cmd" --win --x64 --config electron-builder.yml
    $rc = $LASTEXITCODE
    if ($rc -ne 0) {
        Step "electron-builder failed; attempting winCodeSign cache fix"
        $latest = Get-ChildItem -Directory "$WCSCache" -ErrorAction SilentlyContinue |
                  Where-Object { $_.Name -match '^\d+$' } |
                  Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($latest) {
            $libdir = "$($latest.FullName)\darwin\10.12\lib"
            if (Test-Path "$libdir\libcrypto.1.0.0.dylib") {
                Copy-Item "$libdir\libcrypto.1.0.0.dylib" "$libdir\libcrypto.dylib" -Force
                Copy-Item "$libdir\libssl.1.0.0.dylib"    "$libdir\libssl.dylib"    -Force
                if (-not (Test-Path $WCSFinal)) {
                    Copy-Item -Recurse -Force $latest.FullName $WCSFinal
                }
                Step "Retrying electron-builder"
                & "$bin\electron-builder.cmd" --win --x64 --config electron-builder.yml
                if ($LASTEXITCODE -ne 0) { throw "electron-builder failed twice" }
            } else {
                throw "Could not auto-fix winCodeSign cache. Manual repair needed."
            }
        } else {
            throw "electron-builder failed with no winCodeSign cache to repair."
        }
    }

    Write-Host "`n=== Done ===" -ForegroundColor Green
    Write-Host "Installer is in: $ElectronDir\release\"
    Get-ChildItem "$ElectronDir\release\*.exe" | Select-Object Name, @{n='Size(MB)';e={[math]::Round($_.Length/1MB,1)}}, LastWriteTime | Format-Table
} finally {
    Pop-Location
}
