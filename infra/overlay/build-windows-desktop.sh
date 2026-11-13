#!/usr/bin/env bash
# Builds the unsigned Windows installer of the desktop app for a self-hosted server, the way Echo
# ships its desktop app: the installer, latest.yml and the blockmap land in apps/desktop/out, and
# infra/overlay/build.sh serves them from the server at /desktop-updates/win/, where installed apps
# look for updates.
# Usage: infra/overlay/build-windows-desktop.sh <version>   e.g. 0.9.13 (must grow with each build)
set -euo pipefail

VERSION="${1:?usage: infra/overlay/build-windows-desktop.sh <version, e.g. 0.9.13>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PNPM=(npx -y pnpm@12.18.0)
cd "$ROOT"
"${PNPM[@]}" install --frozen-lockfile --ignore-scripts
(cd apps/web && RAKAZO_ALLOW_DEV_SECRETS=1 "${PNPM[@]}" run build)
(cd apps/desktop && node scripts/build.mjs && node scripts/copy-static.mjs)

# electron-builder's macOS makensis is an Intel binary. On Apple silicon without Rosetta, run
# Homebrew's native makensis (brew install makensis) with its own stubs instead.
if [[ "$(uname -s)" == Darwin ]] && ! arch -x86_64 /usr/bin/true 2>/dev/null; then
  command -v makensis >/dev/null || { echo "Run: brew install makensis" >&2; exit 1; }
  # A first run downloads electron-builder's NSIS files (its makensis then fails); reuse them.
  if ! ls -d "$HOME"/Library/Caches/electron-builder/nsis-3.0.4.1/nsis-3.0.4.1-*/ >/dev/null 2>&1; then
    (cd apps/desktop && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win nsis --x64 \
      --publish never -c.extraMetadata.version="$VERSION" >/dev/null 2>&1) || true
  fi
  cached=$(ls -d "$HOME"/Library/Caches/electron-builder/nsis-3.0.4.1/nsis-3.0.4.1-*/ | head -n 1)
  native=$(mktemp -d)
  trap 'rm -rf "$native"' EXIT
  cp -R "$cached" "$native/nsis"
  cat > "$native/nsis/mac/makensis" <<WRAP
#!/bin/sh
export NSISDIR="$(brew --prefix makensis)/share/nsis"
exec "$(command -v makensis)" "\$@"
WRAP
  chmod +x "$native/nsis/mac/makensis"
  export ELECTRON_BUILDER_NSIS_DIR="$native/nsis"
fi

rm -rf apps/desktop/out
(cd apps/desktop && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win nsis --x64 \
  --publish never -c.extraMetadata.version="$VERSION")
ls -la apps/desktop/out/latest.yml "apps/desktop/out/Rakazo-Setup-$VERSION.exe"
