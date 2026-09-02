#!/usr/bin/env bash
# A BuildKit daemon that OUTLIVES the ephemeral job container.
#
# The runner containers are started `--rm` with `--ephemeral` registration, so
# ~/.docker/buildx and anything a job's builder writes die with the job. That is
# the entire reason `RUN --mount=type=cache,id=pnpm-store` has never survived a
# CI run: cache mounts live in the BUILDER's state, and the builder was always
# discarded. The host docker socket is bind-mounted into the job container, so
# the daemon can instead be a SIBLING container on the host, keeping
# /var/lib/buildkit in a named volume that every later job on this host dials.
#
# `remote` driver, NOT `docker-container`: docker/setup-buildx-action's post
# step runs `docker buildx rm <name>`, which for the docker-container driver
# would DELETE this daemon and its cache. For the remote driver Rm() removes
# only the local instance record, so a stray cleanup — or a job that dies before
# its post step — cannot wipe the cache for every later deploy.
#
# DELIBERATELY separate from any CI builder. A job whose Dockerfile is
# attacker-controlled and which shared this daemon could write a trojaned
# package into the shared pnpm store cache mount, and the next production image
# build would install it — into a published, attested image. Anything that is
# not already trusted with Production secrets gets its own daemon name.
#
# NOTE FOR WHOEVER IS FREEING DISK: `docker system prune -af` reclaims NONE of
# this. The state lives in a docker VOLUME held by a running container. See the
# reclaim commands at the bottom of this file.
set -euo pipefail

name="${BUILDKITD_NAME:-boardsesh-buildkitd-deploy}"
state_volume="${name}-state"
config_volume="${name}-config"
# Pinned by digest, same as postgres-image-publisher.yml. This container is
# long-lived; it must not change under a production deploy.
image="${BUILDKITD_IMAGE:-moby/buildkit:v0.32.2@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config="$(cat "${script_dir}/buildkitd.toml")"
config_hash="$(printf '%s' "$config" | sha256sum | cut -d' ' -f1)"

current_image="$(docker inspect -f '{{.Config.Image}}' "$name" 2>/dev/null || true)"
current_hash="$(docker inspect -f '{{index .Config.Labels "boardsesh.buildkitd.config"}}' "$name" 2>/dev/null || true)"
running="$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo false)"

if [ -n "$current_image" ] && { [ "$current_image" != "$image" ] || [ "$current_hash" != "$config_hash" ]; }; then
  # Recreate on drift, but KEEP the state volume: a version or config bump
  # should not cost a cold build. BuildKit migrates its own state.
  echo "buildkitd image or config changed; recreating (state volume kept)"
  docker rm -f "$name" >/dev/null 2>&1 || true
  running=false
fi

if [ "$running" != 'true' ]; then
  # The config has to arrive over stdin into a named volume. The job container's
  # filesystem is NOT visible to the host daemon (sibling containers, not
  # nested), so `-v "$PWD/scripts/ci:/etc/buildkit"` would silently mount a host
  # path that does not exist and the daemon would start with default (unbounded)
  # GC. This is the single most likely way to get this script wrong.
  printf '%s' "$config" | docker run --rm -i -v "${config_volume}:/cfg" \
    --entrypoint sh "$image" -c 'cat > /cfg/buildkitd.toml'

  # `docker run` on an existing name fails; the `||` branch is what makes two
  # deploy jobs landing on this host in the same second safe.
  docker run -d \
    --name "$name" \
    --restart unless-stopped \
    --privileged \
    --label "boardsesh.buildkitd.config=${config_hash}" \
    -v "${state_volume}:/var/lib/buildkit" \
    -v "${config_volume}:/etc/buildkit" \
    "$image" --config /etc/buildkit/buildkitd.toml \
    >/dev/null 2>&1 \
    || docker start "$name" >/dev/null
fi

# Prove the exact endpoint buildx will dial actually answers, here, rather than
# discovering it half way through build-push-action. Fails the job on purpose:
# a production deploy going red with a clear error beats one that quietly falls
# back to a cold local builder and looks fine.
for _ in $(seq 1 30); do
  if docker exec "$name" buildctl debug workers >/dev/null 2>&1; then
    echo "buildkitd '${name}' ready on $(hostname)"
    docker exec "$name" buildctl du 2>/dev/null | tail -1 || true
    exit 0
  fi
  sleep 1
done

echo "::error::buildkitd '${name}' did not become ready on $(hostname) within 30s" >&2
exit 1

# Reclaiming space by hand (buildkitd state is invisible to `docker system df`):
#
#   docker exec boardsesh-buildkitd-deploy buildctl du -v
#   docker exec boardsesh-buildkitd-deploy buildctl prune --reserved-space 10GB --verbose
#   docker exec boardsesh-buildkitd-deploy buildctl prune --all
#
# Nuclear (next deploy on this host is cold, nothing else breaks):
#
#   docker rm -f boardsesh-buildkitd-deploy
#   docker volume rm boardsesh-buildkitd-deploy-state boardsesh-buildkitd-deploy-config
