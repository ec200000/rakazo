#!/usr/bin/env bash
# Builds the computer image with build, test and deploy tools on top of the published one.
# Usage: infra/overlay/build-computer.sh <image:tag> [platform]   (platform default: linux/amd64)
#   BASE  published computer image to start from (default ghcr.io/elie222/rakazo/computer:v0.9.0)
set -euo pipefail

IMAGE="${1:?usage: infra/overlay/build-computer.sh <image:tag> [platform]}"
PLATFORM="${2:-linux/amd64}"
BASE="${BASE:-ghcr.io/elie222/rakazo/computer:v0.9.0}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Pin the base to the requested platform's manifest (see build.sh for why).
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
  BASE="${BASE%%:*}@$digest"
fi
arch="${PLATFORM#*/}"
# The classic builder does not set TARGETARCH, so pass it.
if [[ "$arch" != "$(docker version --format '{{.Server.Arch}}')" ]] && docker buildx version >/dev/null 2>&1; then
  docker buildx build --platform "$PLATFORM" --build-arg BASE="$BASE" --build-arg TARGETARCH="$arch" \
    -t "$IMAGE" --load "$ROOT/infra/overlay/computer"
else
  docker pull --platform "$PLATFORM" "$BASE"
  docker build --platform "$PLATFORM" --build-arg BASE="$BASE" --build-arg TARGETARCH="$arch" \
    -t "$IMAGE" "$ROOT/infra/overlay/computer"
fi
echo "Built $IMAGE ($PLATFORM) from $BASE"
