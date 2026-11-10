#!/usr/bin/env bash
# Builds the app image with this checkout's API and worker on top of the published image of the
# same release, so only the server code changes.
# Usage: infra/overlay/build.sh <image:tag> [platform]   (platform default: linux/amd64)
#   BASE  published image to start from (default ghcr.io/elie222/rakazo/app:v0.9.0)
set -euo pipefail

IMAGE="${1:?usage: infra/overlay/build.sh <image:tag> [platform]}"
PLATFORM="${2:-linux/amd64}"
BASE="${BASE:-ghcr.io/elie222/rakazo/app:v0.9.0}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PNPM=(npx -y pnpm@12.18.0)

cd "$ROOT"
"${PNPM[@]}" install --frozen-lockfile --ignore-scripts
"${PNPM[@]}" --filter @rakazo/db generate
(cd apps/api && "${PNPM[@]}" run build)
(cd apps/worker && "${PNPM[@]}" run build)

# The repository's .dockerignore leaves out dist, so build from a context holding only it.
context=$(mktemp -d)
trap 'rm -rf "$context"' EXIT
mkdir -p "$context/apps/api" "$context/apps/worker"
cp -R apps/api/dist "$context/apps/api/dist"
cp -R apps/worker/dist "$context/apps/worker/dist"
cp infra/overlay/Dockerfile "$context/"

# Another platform's RUN step needs emulation (Docker Desktop and colima provide it).
if docker buildx version >/dev/null 2>&1; then
  docker buildx build --platform "$PLATFORM" --build-arg BASE="$BASE" -t "$IMAGE" --load "$context"
else
  docker pull --platform "$PLATFORM" "$BASE"
  docker build --platform "$PLATFORM" --build-arg BASE="$BASE" -t "$IMAGE" "$context"
fi
echo "Built $IMAGE ($PLATFORM) from $BASE"
