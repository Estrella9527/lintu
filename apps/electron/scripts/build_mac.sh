#!/usr/bin/env bash
# macOS-only end-to-end build for 灵图.
#
# Usage:
#   cd apps/electron
#   ./scripts/build_mac.sh
#
# Output:
#   apps/electron/release/灵图-<version>-arm64.dmg   (user-facing installer)
#   apps/electron/release/灵图-<version>-arm64-mac.zip  (auto-update payload)
#   apps/electron/release/latest-mac.yml              (electron-updater manifest)
#
# Prereqs:
#   - Node.js 20+ (with npm)
#   - Python 3.12+ + uv  (curl -LsSf https://astral.sh/uv/install.sh | sh)
#   - For SIGNED + NOTARIZED builds, set these env vars before running:
#       export CSC_LINK=/path/to/codesign.p12
#       export CSC_KEY_PASSWORD=<p12 password>
#       export APPLE_ID=<your apple id email>
#       export APPLE_APP_SPECIFIC_PASSWORD=<app-specific password>
#       export APPLE_TEAM_ID=<10-char team id>
#     If any of those are missing, electron-builder ships an UNSIGNED dmg
#     that Gatekeeper will refuse to launch. Useful for quick local
#     verification, not for distribution.

set -euo pipefail

ELECTRON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIDECAR_DIR="$(cd "$ELECTRON_DIR/../sidecar" && pwd)"
REPO_ROOT="$(cd "$ELECTRON_DIR/../.." && pwd)"

step() { printf "\n\033[36m=== %s ===\033[0m\n" "$1"; }

# ── 0. Toolchain check ──────────────────────────────────────────────────────
step "Toolchain check"
command -v node >/dev/null || { echo "Node.js not installed"; exit 1; }
command -v npm  >/dev/null || { echo "npm not installed";    exit 1; }

if ! command -v uv >/dev/null; then
  if [ -x "$HOME/.local/bin/uv" ]; then
    export PATH="$HOME/.local/bin:$PATH"
  else
    echo "uv not found. Install via: curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
  fi
fi
echo "node $(node --version) | npm $(npm --version) | uv $(uv --version)"

# ── 1. Sidecar (PyInstaller) ────────────────────────────────────────────────
step "Sync sidecar deps"
(cd "$SIDECAR_DIR" && uv sync)

step "Add PyInstaller (idempotent)"
(cd "$SIDECAR_DIR" && uv add --dev pyinstaller)

step "Clean previous PyInstaller output"
rm -rf "$SIDECAR_DIR/dist" "$SIDECAR_DIR/build"

step "Run PyInstaller"
(cd "$SIDECAR_DIR" && uv run pyinstaller sidecar.spec --noconfirm --clean)

if [ ! -f "$SIDECAR_DIR/dist/sidecar/sidecar" ]; then
  echo "PyInstaller did not produce dist/sidecar/sidecar"
  exit 1
fi
chmod +x "$SIDECAR_DIR/dist/sidecar/sidecar"
echo "Sidecar bundled: $SIDECAR_DIR/dist/sidecar/sidecar"

# ── 2. Generate .icns from .png if missing ──────────────────────────────────
# macOS expects icon.icns (Apple's container format with multiple resolutions).
# We auto-generate it from build/icon.png the first time.
ICNS="$ELECTRON_DIR/build/icon.icns"
PNG="$ELECTRON_DIR/build/icon.png"
if [ ! -f "$ICNS" ] && [ -f "$PNG" ]; then
  step "Generate icon.icns from icon.png"
  TMP="$ELECTRON_DIR/build/_icon.iconset"
  rm -rf "$TMP"; mkdir -p "$TMP"
  for size in 16 32 64 128 256 512; do
    sips -z "$size" "$size"   "$PNG" --out "$TMP/icon_${size}x${size}.png"     >/dev/null
    sips -z "$((size*2))" "$((size*2))" "$PNG" --out "$TMP/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$TMP" -o "$ICNS"
  rm -rf "$TMP"
  echo "Created $ICNS"
fi

# ── 3. Electron deps ────────────────────────────────────────────────────────
step "Install npm deps via workspaces"
(cd "$REPO_ROOT" && npm install --no-fund --no-audit)

# ── 4. Frontend / main / preload bundles ────────────────────────────────────
BIN="$REPO_ROOT/node_modules/.bin"

step "Bundle main process"
(cd "$ELECTRON_DIR" && "$BIN/esbuild" src/main/index.ts --bundle --platform=node --format=cjs --outfile=dist/main.cjs --external:electron)

step "Bundle preload"
(cd "$ELECTRON_DIR" && "$BIN/esbuild" src/preload/index.ts --bundle --platform=node --format=cjs --outfile=dist/preload.cjs --external:electron)

step "Build renderer (Vite)"
(cd "$ELECTRON_DIR" && "$BIN/vite" build --config vite.config.ts)

# ── 5. electron-builder ─────────────────────────────────────────────────────
step "Run electron-builder for macOS (arm64)"

# Surface signing/notarization status so the user knows what they're getting.
if [ -n "${CSC_LINK:-}" ] && [ -n "${APPLE_ID:-}" ]; then
  echo "Mode: SIGNED + NOTARIZED (will call Apple notary; takes ~3-5 min)"
elif [ -n "${CSC_LINK:-}" ]; then
  echo "Mode: SIGNED only (no notarization — Gatekeeper will still warn)"
else
  echo "Mode: UNSIGNED (Gatekeeper will refuse to launch on other Macs)"
fi

(cd "$ELECTRON_DIR" && "$BIN/electron-builder" --mac --arm64 --config electron-builder.yml --publish never)

step "Done"
ls -lh "$ELECTRON_DIR/release/"灵图-*.dmg "$ELECTRON_DIR/release/"灵图-*-mac.zip "$ELECTRON_DIR/release/latest-mac.yml" 2>/dev/null || true
