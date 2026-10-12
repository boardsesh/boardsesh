#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! docker image inspect caddy:2-alpine >/dev/null 2>&1; then
  echo "caddy:2-alpine must already exist locally; this smoke test never pulls images" >&2
  exit 2
fi
CADDY_BASE_REPO_DIGEST="$(docker image inspect --format '{{index .RepoDigests 0}}' caddy:2-alpine)"
if [[ ! "$CADDY_BASE_REPO_DIGEST" =~ ^caddy@sha256:[0-9a-f]{64}$ ]]; then
  echo "the local Caddy tag does not resolve to a supported immutable RepoDigest" >&2
  exit 2
fi

SUFFIX="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
TMP_BASE="${TMPDIR:-/tmp}"
TMP_ROOT="$(mktemp -d "$TMP_BASE/boardsesh-app-preview-smoke-${SUFFIX}.XXXXXX")"
IMAGE="boardsesh/app-preview-smoke:${SUFFIX}"
CONTAINER="boardsesh-app-preview-smoke-${SUFFIX}"
OWNER_LABEL="boardsesh.app-preview-smoke.owner"
RUN_LABEL="boardsesh.app-preview-smoke.run"
OWNER_LABEL_VALUE="local-serving-smoke"
IMAGE_CREATED=0
CONTAINER_CREATED=0
TMP_ROOT_CREATED=1
CONTAINER_ID=""

cleanup() {
  if [[ "$CONTAINER_CREATED" == 1 && -n "$CONTAINER_ID" ]]; then
    ownership="$(docker inspect --format "{{.Name}} {{index .Config.Labels \"$OWNER_LABEL\"}} {{index .Config.Labels \"$RUN_LABEL\"}}" "$CONTAINER_ID" 2>/dev/null || true)"
    if [[ "$ownership" == "/$CONTAINER $OWNER_LABEL_VALUE $SUFFIX" ]]; then
      if docker rm -f "$CONTAINER_ID" >/dev/null 2>&1; then
        echo "Removed owned smoke container ${CONTAINER_ID:0:12}"
      fi
    fi
  fi

  if [[ "$IMAGE_CREATED" == 1 ]]; then
    image_ownership="$(docker image inspect --format "{{index .Config.Labels \"$OWNER_LABEL\"}} {{index .Config.Labels \"$RUN_LABEL\"}}" "$IMAGE" 2>/dev/null || true)"
    if [[ "$image_ownership" == "$OWNER_LABEL_VALUE $SUFFIX" ]]; then
      if docker image rm "$IMAGE" >/dev/null 2>&1; then
        echo "Removed owned smoke image $IMAGE"
      fi
    fi
  fi

  if [[ "$TMP_ROOT_CREATED" == 1 && -d "$TMP_ROOT" && "$TMP_ROOT" == "$TMP_BASE"/boardsesh-app-preview-smoke-"$SUFFIX".* ]]; then
    if rm -rf -- "$TMP_ROOT"; then
      echo "Removed owned synthetic fixture directory"
    fi
  fi
}
trap cleanup EXIT

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "refusing to reuse existing image $IMAGE" >&2
  exit 1
fi
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "refusing to reuse existing container $CONTAINER" >&2
  exit 1
fi

mkdir -p "$TMP_ROOT/context/app-standalone/_expo/static/js/web" \
  "$TMP_ROOT/context/app-standalone/assets" "$TMP_ROOT/context/app-standalone/wasm"
cp "$ROOT_DIR/deploy/app-preview/Caddyfile" "$TMP_ROOT/context/Caddyfile"
base_instruction_count="$(grep -Ec '^FROM caddy:2-alpine$' "$ROOT_DIR/Dockerfile.app-web")"
if [[ "$base_instruction_count" != 1 ]]; then
  echo "Dockerfile.app-web must contain exactly one FROM caddy:2-alpine instruction" >&2
  exit 1
fi
sed "s|^FROM caddy:2-alpine$|FROM $CADDY_BASE_REPO_DIGEST|" \
  "$ROOT_DIR/Dockerfile.app-web" > "$TMP_ROOT/context/Dockerfile.app-web"
if [[ "$(grep -Ec "^FROM $CADDY_BASE_REPO_DIGEST$" "$TMP_ROOT/context/Dockerfile.app-web")" != 1 ]]; then
  echo "the temporary Dockerfile did not pin the reviewed Caddy digest" >&2
  exit 1
fi
cat > "$TMP_ROOT/context/app-standalone/index.html" <<'HTML'
<!doctype html><html><head><title>Boardsesh preview smoke</title></head><body><div id="root">preview shell</div></body></html>
HTML
printf 'globalThis.boardseshPreviewSmoke = true;\n' > "$TMP_ROOT/context/app-standalone/_expo/static/js/web/smoke.012345.js"
printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>\n' > "$TMP_ROOT/context/app-standalone/assets/icon.012345.svg"
# Minimal valid WebAssembly module header; the check exercises Caddy's real MIME mapping.
printf '\000asm\001\000\000\000' > "$TMP_ROOT/context/app-standalone/wasm/smoke.wasm"

docker build \
  --file "$TMP_ROOT/context/Dockerfile.app-web" \
  --tag "$IMAGE" \
  --label "$OWNER_LABEL=$OWNER_LABEL_VALUE" \
  --label "$RUN_LABEL=$SUFFIX" \
  "$TMP_ROOT/context"
IMAGE_CREATED=1
echo "Built the synthetic test image from $CADDY_BASE_REPO_DIGEST"

CID_FILE="$TMP_ROOT/container.id"
run_status=0
docker run --detach \
  --cidfile "$CID_FILE" \
  --name "$CONTAINER" \
  --label "$OWNER_LABEL=$OWNER_LABEL_VALUE" \
  --label "$RUN_LABEL=$SUFFIX" \
  --publish 127.0.0.1::80 \
  --network bridge \
  --cap-drop ALL \
  --cap-add NET_BIND_SERVICE \
  --security-opt no-new-privileges \
  --read-only \
  --tmpfs /data:rw,noexec,nosuid,size=4m \
  --tmpfs /config:rw,noexec,nosuid,size=1m \
  "$IMAGE" >/dev/null || run_status=$?

if [[ -s "$CID_FILE" ]]; then
  CONTAINER_ID="$(cat "$CID_FILE")"
  ownership="$(docker inspect --format "{{.Name}} {{.Config.Image}} {{index .Config.Labels \"$OWNER_LABEL\"}} {{index .Config.Labels \"$RUN_LABEL\"}}" "$CONTAINER_ID" 2>/dev/null || true)"
  if [[ "$ownership" == "/$CONTAINER $IMAGE $OWNER_LABEL_VALUE $SUFFIX" ]]; then
    CONTAINER_CREATED=1
    echo "Verified owned smoke container ${CONTAINER_ID:0:12} and image $IMAGE"
  fi
fi
if (( run_status != 0 )); then
  echo "docker run failed with status $run_status" >&2
  exit "$run_status"
fi
if [[ "$CONTAINER_CREATED" != 1 ]]; then
  echo "docker did not create the uniquely labeled smoke container" >&2
  exit 1
fi

PORT_BINDING="$(docker port "$CONTAINER_ID" 80/tcp)"
if [[ ! "$PORT_BINDING" =~ ^127\.0\.0\.1:([0-9]+)$ ]]; then
  echo "Docker did not publish the owned container on a loopback-only port: $PORT_BINDING" >&2
  exit 1
fi
PORT="${BASH_REMATCH[1]}"
echo "Verified loopback-only app port 127.0.0.1:$PORT"
BASE_URL="http://127.0.0.1:$PORT"

wait_for_root() {
  local attempt
  local deadline=$((SECONDS + 30))
  for attempt in {1..20}; do
    if curl --connect-timeout 1 --max-time 2 --fail --silent --show-error \
      "$BASE_URL/" -o "$TMP_ROOT/root.html" 2>/dev/null; then
      return 0
    fi
    if (( SECONDS >= deadline )); then
      break
    fi
    sleep 0.5
  done
  docker logs "$CONTAINER" >&2 || true
  echo "Caddy did not serve the root route" >&2
  return 1
}

wait_for_root
cmp "$TMP_ROOT/root.html" "$TMP_ROOT/context/app-standalone/index.html"
curl --connect-timeout 1 --max-time 5 --fail --silent --show-error \
  "$BASE_URL/some/deep/route" -o "$TMP_ROOT/deep.html"
cmp "$TMP_ROOT/deep.html" "$TMP_ROOT/context/app-standalone/index.html"

JS_PATH="/_expo/static/js/web/smoke.012345.js"
WASM_PATH="/wasm/smoke.wasm"
curl --connect-timeout 1 --max-time 5 --fail --silent --show-error \
  "$BASE_URL$JS_PATH" -o "$TMP_ROOT/served-smoke.js"
cmp "$TMP_ROOT/context/app-standalone$JS_PATH" "$TMP_ROOT/served-smoke.js"
curl --connect-timeout 1 --max-time 5 --fail --silent --show-error \
  "$BASE_URL$WASM_PATH" -o "$TMP_ROOT/served-smoke.wasm"
cmp "$TMP_ROOT/context/app-standalone$WASM_PATH" "$TMP_ROOT/served-smoke.wasm"

assert_header() {
  local path="$1"
  local header="$2"
  local expected="$3"
  local headers_file="$TMP_ROOT/headers"
  curl --connect-timeout 1 --max-time 5 --fail --silent --show-error \
    -D "$headers_file" -o /dev/null "$BASE_URL$path"
  if ! tr -d '\r' < "$headers_file" | grep -Eiq "^${header}:.*${expected}"; then
    echo "missing expected $header: $expected for $path" >&2
    cat "$headers_file" >&2
    return 1
  fi
}

assert_header /_expo/static/js/web/smoke.012345.js Content-Type '(text|application)/javascript'
assert_header /_expo/static/js/web/smoke.012345.js Cache-Control 'max-age=31536000, immutable'
assert_header /assets/icon.012345.svg Cache-Control 'max-age=31536000, immutable'
assert_header /wasm/smoke.wasm Content-Type 'application/wasm'
assert_header / X-Robots-Tag 'noindex'
assert_header / X-Content-Type-Options 'nosniff'
echo "Caddy root/deep routes, JS/WASM bytes and MIME, immutable assets and privacy headers passed"
