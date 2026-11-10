# The published app image with this checkout's API and worker (the deployment file feature) and
# git, which reads plugins and marketplaces from git hosts other than github.com. Node carries
# its own CAs, so the image has no system ones; git needs them.
# Built by infra/overlay/build.sh; the web app and everything else stay the published ones.
ARG BASE
FROM ${BASE}
# COPY before RUN: the classic builder loses the platform of an emulated RUN's result.
COPY apps/api/dist /app/apps/api/dist
COPY apps/worker/dist /app/apps/worker/dist
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
USER node
