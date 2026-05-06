# Encode the local code-signing PFX to base64 for storing as a GitHub Actions
# secret.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/export_pfx_for_github.ps1
#
# Output: prints the base64 string AND copies it to your clipboard.
#
# Then in GitHub:
#   Repository → Settings → Secrets and variables → Actions → New secret
#     Name:  WIN_CODESIGN_PFX_BASE64
#     Value: <paste from clipboard>
#
#   Add another secret:
#     Name:  WIN_CODESIGN_PFX_PASSWORD
#     Value: <your PFX password>
#
# After both secrets are set, the build-windows workflow will sign the
# Windows installer automatically. Without them, builds still succeed but
# ship unsigned binaries.

$ErrorActionPreference = "Stop"
$pfxPath = Join-Path $PSScriptRoot "..\build\codesign.pfx" | Resolve-Path
$bytes = [IO.File]::ReadAllBytes($pfxPath)
$b64 = [Convert]::ToBase64String($bytes)

Write-Host "PFX size:    $($bytes.Length) bytes"
Write-Host "Base64 size: $($b64.Length) chars"
Write-Host ""
Write-Host "----- BEGIN BASE64 -----"
Write-Host $b64
Write-Host "----- END BASE64 -----"

try {
    $b64 | Set-Clipboard
    Write-Host ""
    Write-Host "Copied to clipboard." -ForegroundColor Green
} catch {
    Write-Host "Could not copy to clipboard automatically — copy the block above manually." -ForegroundColor Yellow
}
