#!/usr/bin/env bash
# Build the proxy image locally and ship it to the NAS, leaving no source there.
#
# The NAS cannot pull the base layers (its registry proxy stalls), and the image
# carries the application code, so the code travels as the image rather than as a
# checkout. Only docker-compose.yml and ./data stay on the NAS.
#
#   ./scripts/deploy-nas.sh            build, ship, reload
#   ./scripts/deploy-nas.sh --no-build ship the current local image as-is
#
# Where it goes is configuration, not a constant:
#
#   REMOTE      ssh alias of the machine        (default nas)
#   DIR         service directory on it         (default /srv/buddy-proxy)
#   IMAGE       image name in the compose file  (default buddy-proxy:latest)
set -euo pipefail

REMOTE=${REMOTE:-nas}
DIR=${DIR:-/srv/buddy-proxy}
IMAGE=${IMAGE:-buddy-proxy:latest}
LOCAL_REF=${LOCAL_REF:-localhost/buddy-proxy:latest}
HOST=${HOST:-$REMOTE}

cd "$(dirname "$0")/.."

if [[ "${1:-}" != "--no-build" ]]; then
  echo "==> building $LOCAL_REF"
  # --format docker, not the default OCI: podman drops HEALTHCHECK in OCI images,
  # and the health status is what tells us the service is actually serving.
  podman build --format docker -t "$LOCAL_REF" .
  echo "==> tagging $IMAGE"
  podman tag "$LOCAL_REF" "$IMAGE"
fi

# podman save refuses to overwrite an existing archive, so each run gets a fresh name.
STAMP=$(date +%Y%m%d-%H%M%S)
TAR="/tmp/buddy-proxy-${STAMP}.tar"

echo "==> exporting $IMAGE -> $TAR"
podman save --format docker-archive -o "$TAR" "$LOCAL_REF"

cleanup() { rm -f "$TAR"; }
trap cleanup EXIT

echo "==> copying to $HOST:$DIR"
ssh "$HOST" "mkdir -p '$DIR/data'"
scp -q "$TAR" "$HOST:$DIR/image.tar"
scp -q docker-compose.yml "$HOST:$DIR/docker-compose.yml"

echo "==> loading image on $HOST"
# `docker load` tags the image localhost/buddy-proxy:latest, but the compose
# file refers to buddy-proxy:latest. Without this retag the compose file would
# keep resolving to the previous image and the new one would never be used.
ssh "$HOST" "docker load -i '$DIR/image.tar' \
  && rm -f '$DIR/image.tar' \
  && docker tag localhost/buddy-proxy:latest $IMAGE \
  && docker image inspect $IMAGE --format 'loaded: {{.Id}}'"

# The NAS keeps the compose file and the data directory, and nothing else. Any
# source that a previous deployment left behind is removed here.
echo "==> pruning source files on $HOST"
ssh "$HOST" "cd '$DIR' && rm -rf lib scripts *.ts *.mjs Dockerfile .dockerignore \
  package.json pnpm-lock.yaml package-lock.json free_models.json README.md LICENSE \
  .gitignore tsconfig.json mise.toml .env api-keys.json docker-compose.yml.bak"

echo "==> reloading the service"
# `down` first: a container from an older compose file keeps its name, and the new
# one cannot create a container with that name until the old one is gone. The data
# directory is a bind mount, so nothing is lost.
ssh "$HOST" "cd '$DIR' && docker compose down --remove-orphans 2>&1 | tail -3; docker compose up -d"

echo "==> status"
ssh "$HOST" "cd '$DIR' && docker compose ps && ls -la '$DIR'"
