#!/usr/bin/env bash
# Builds the app image with this checkout's API, worker and web app on top of the published image
# of the same release, so only the code changes.
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
(cd apps/web && RAKAZO_ALLOW_DEV_SECRETS=1 "${PNPM[@]}" run build)

# The repository's .dockerignore leaves out dist, so build from a context holding only it.
context=$(mktemp -d)
trap 'rm -rf "$context"' EXIT
mkdir -p "$context/apps/api" "$context/apps/worker" "$context/apps/web" "$context/packages/db"
cp -R apps/api/dist "$context/apps/api/dist"
cp -R apps/worker/dist "$context/apps/worker/dist"
cp -R apps/web/dist "$context/apps/web/dist"
# The schema and migrations the bundled database client was generated from.
cp -R packages/db/prisma "$context/packages/db/prisma"
cp infra/overlay/Dockerfile "$context/"

# A tag names every platform's image. With the containerd image store, the classic builder can
# take the host's layers for it while writing the requested platform's config, which makes an
# image that fails to load ("wrong diff id"). Pin the base to the requested platform's manifest.
if [[ "$BASE" != *@sha256:* ]]; then
  digest=$(docker manifest inspect "$BASE" | node -e '
    const [os, arch] = process.argv[1].split("/");
    const index = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const match = (index.manifests ?? []).find(
      (m) => m.platform?.os === os && m.platform?.architecture === arch,
    );
    if (!match) process.exit(1);
    console.log(match.digest);
  ' "$PLATFORM") || { echo "No $PLATFORM image for $BASE" >&2; exit 1; }
  BASE="${BASE%:*}@$digest"
fi

# Another platform's RUN step needs emulation (Docker Desktop and colima provide it).
if docker buildx version >/dev/null 2>&1; then
  docker buildx build --platform "$PLATFORM" --build-arg BASE="$BASE" -t "$IMAGE" --load "$context"
else
  docker pull --platform "$PLATFORM" "$BASE"
  docker build --platform "$PLATFORM" --build-arg BASE="$BASE" -t "$IMAGE" "$context"
fi
echo "Built $IMAGE ($PLATFORM) from $BASE"
