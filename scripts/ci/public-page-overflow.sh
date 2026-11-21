#!/usr/bin/env bash
# Serve the typecheck job's production web build and a real backend against the seeded CI database.
set -euo pipefail
repo=$(git rev-parse --show-toplevel)
cd "$repo"
[[ -s packages/web/.next/BUILD_ID ]] || { echo 'Missing production web build from typecheck' >&2; exit 1; }
log_dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/public-page-overflow-XXXXXXXX")
printf 'Public page browser logs: %s\n' "$log_dir"
database_container=
runtime_dir=
backend_pid=
web_pid=
cleanup() {
  for pid in "$web_pid" "$backend_pid"; do
    if [[ -n "$pid" ]]; then kill -TERM -- "-$pid" 2>/dev/null || true; fi
  done
  if [[ -n "$database_container" ]]; then docker stop "$database_container" >/dev/null || true; fi
  if [[ -n "$runtime_dir" ]]; then rm -rf -- "$runtime_dir"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The renderer rewrite is baked for localhost:8080. Refuse to reuse any other
# checkout's server. The hosted runner supplies a separate network namespace.
for port in 3000 8080; do
  if (echo >/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
    echo "Public page check requires free loopback port $port" >&2; exit 1
  fi
done
image=$(docker compose -f docker-compose.yml config --images postgres)
[[ "$image" =~ ^ghcr.io/boardsesh/boardsesh-dev-db@sha256:[0-9a-f]{64}$ ]] || {
  echo 'Expected the digest-pinned seeded database from docker-compose.yml' >&2; exit 1;
}
database_container=$(docker run -d --rm --shm-size=256m -p 127.0.0.1::5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=password -e POSTGRES_DB=main "$image")
db_binding=$(docker port "$database_container" 5432/tcp)
[[ "$db_binding" =~ ^127\.0\.0\.1:[0-9]+$ ]]
export DATABASE_URL="postgresql://postgres:password@$db_binding/main"
export READ_REPLICA_URL='' ADMIN_DATABASE_URL="$DATABASE_URL" WEB_DATABASE_URL=''
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$database_container" pg_isready -h 127.0.0.1 -U postgres -d main >/dev/null; then break; fi
  sleep 1
done
docker exec "$database_container" pg_isready -h 127.0.0.1 -U postgres -d main
SYNC_CUTOFF_ADMIN_DATABASE_URL="$DATABASE_URL" SYNC_CUTOFF_DEVELOPMENT_BOOTSTRAP=true \
  vp exec tsx packages/db/scripts/bootstrap-sync-deletions-cutoff-development.ts --apply
(cd packages/db && vp exec drizzle-kit migrate)
vp exec tsx packages/db/scripts/ensure-dev-job-queue-schema.ts

# Package the same standalone entry as deployment, including browser chunks and public assets.
runtime_dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/public-web-runtime-XXXXXXXX")
rsync -a --exclude='.env*' --exclude='.next/cache' packages/web/.next/standalone/ "$runtime_dir/"
web_dir="$runtime_dir/packages/web"
cmp packages/web/.next/BUILD_ID "$web_dir/.next/BUILD_ID"
rsync -a packages/web/.next/static/ "$web_dir/.next/static/"
rsync -a packages/web/public/ "$web_dir/public/"

export NEXTAUTH_URL=http://127.0.0.1:3000 NEXTAUTH_SECRET=public-overflow-ci-only
export IRON_SESSION_PASSWORD=public-overflow-ci-only-no-authentication
export NEXT_PUBLIC_WS_URL=ws://127.0.0.1:8080/graphql BACKEND_INTERNAL_URL=http://127.0.0.1:8080/graphql
export REDIS_URL='' BOARDSESH_E2E=1 SENTRY_DSN='' POSTHOG_API_KEY=''
(cd packages/backend && exec setsid env PORT=8080 vp exec tsx src/index.ts) >"$log_dir/backend.log" 2>&1 &
backend_pid=$!
(cd "$web_dir" && exec setsid env HOSTNAME=127.0.0.1 PORT=3000 node server.js) >"$log_dir/web.log" 2>&1 &
web_pid=$!
for url in http://127.0.0.1:8080/health "$NEXTAUTH_URL/docs"; do
  deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    if ! kill -0 "$backend_pid" || ! kill -0 "$web_pid"; then tail -30 "$log_dir"/*.log >&2; exit 1; fi
    if curl --noproxy '*' -fsS --max-time 3 "$url" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  curl --noproxy '*' -fsS --max-time 5 "$url" >/dev/null
done
# The first catalog read queues the real board-config refresh. Setter SSR
# deliberately omits climb links until that refresh has populated this fixture.
catalog_query='{"query":"{ popularBoardConfigs(input: {boardType: \"kilter\", limit: 1}) { configs { boardType } } }"}'
deadline=$((SECONDS + 180))
until curl --noproxy '*' -fsS --max-time 5 -H 'Content-Type: application/json' \
  --data "$catalog_query" "$BACKEND_INTERNAL_URL" | jq -e '.data.popularBoardConfigs.configs[0].boardType == "kilter"' >/dev/null; do
  if (( SECONDS >= deadline )); then echo 'Seeded Kilter configuration did not become available' >&2; exit 1; fi
  sleep 1
done
cd packages/web
# This anonymous spec needs real seed content, but does not use the classic sign-in warmup.
CI=1 PLAYWRIGHT_TEST_BASE_URL="$NEXTAUTH_URL" PLAYWRIGHT_SKIP_CLASSIC_SETUP=1 \
  vp exec playwright test e2e/public-page-overflow.spec.ts --project=chromium --workers=1 --retries=0 --trace=retain-on-failure
