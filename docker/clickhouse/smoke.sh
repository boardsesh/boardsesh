#!/usr/bin/env bash
# Smoke test for docker/clickhouse: boots the image the way Railway runs it and
# proves the lean config is the one in force.
#
#   docker/clickhouse/smoke.sh               # builds boardsesh-clickhouse:smoke first
#   IMAGE=some/tag docker/clickhouse/smoke.sh # tests an image built elsewhere
#
# Needs only docker and curl. Runs in CI from .github/workflows/clickhouse-image.yml.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

IMAGE="${IMAGE:-}"
if [[ -z "$IMAGE" ]]; then
  IMAGE='boardsesh-clickhouse:smoke'
  docker build --quiet --tag "$IMAGE" "$SCRIPT_DIR" >/dev/null
fi
readonly IMAGE

# Seconds of idleness before the resident-memory reading. The config refreshes
# asynchronous metrics once a minute, so this must exceed 60 to read a value
# taken after boot settled.
readonly IDLE_SECONDS="${IDLE_SECONDS:-75}"
# Idle resident memory must stay under this. Stock 25.3 sits well above it.
readonly MAX_IDLE_RESIDENT_BYTES=700000000

readonly CH_USER='xprem'
CH_PASSWORD="smoke-$(date +%s)-$RANDOM"
readonly CH_PASSWORD
readonly CH_DB='expo_observe'

container=''
cleanup() {
  if [[ -n "$container" ]]; then
    if [[ "${SMOKE_FAILED:-0}" == 1 ]]; then
      echo '--- server log tail ---' >&2
      docker logs --tail 60 "$container" >&2 || true
    fi
    docker rm --force "$container" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() {
  SMOKE_FAILED=1
  printf 'clickhouse smoke: FAIL: %s\n' "$1" >&2
  exit 1
}

pass() {
  printf '    ok  %s\n' "$1"
}

# The same env the Railway service sets, under the same limits Railway will apply
# (2 GB, 2 vCPU), so the memory ceiling is tested against a real cgroup.
container="$(docker run --detach \
  --memory 2g --cpus 2 \
  --ulimit nofile=262144:262144 \
  --publish 127.0.0.1::8123 \
  -e CLICKHOUSE_USER="$CH_USER" \
  -e CLICKHOUSE_PASSWORD="$CH_PASSWORD" \
  -e CLICKHOUSE_DB="$CH_DB" \
  -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
  "$IMAGE")"

http_port="$(docker port "$container" 8123/tcp | head -n 1 | awk -F: '{print $NF}')"
readonly http_port

query() {
  docker exec "$container" clickhouse-client \
    --user "$CH_USER" --password "$CH_PASSWORD" --query "$1"
}

expect_eq() {
  local description="$1" sql="$2" expected="$3" actual
  actual="$(query "$sql")" || fail "$description: query failed: $sql"
  [[ "$actual" == "$expected" ]] || fail "$description: expected '$expected', got '$actual'"
  pass "$description"
}

echo "--- booting $IMAGE ---"
for _ in $(seq 1 60); do
  if [[ "$(curl --silent --max-time 2 "http://127.0.0.1:$http_port/ping" || true)" == 'Ok.' ]]; then
    break
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "$container")" != 'true' ]]; then
    fail 'container exited during boot'
  fi
  sleep 1
done
[[ "$(curl --silent --max-time 2 "http://127.0.0.1:$http_port/ping" || true)" == 'Ok.' ]] ||
  fail '/ping did not answer within 60 s'
# /ping answers before the entrypoint's init step has created the database.
for _ in $(seq 1 30); do
  query "SELECT 1 FROM system.databases WHERE name = '$CH_DB'" 2>/dev/null | grep -qx 1 && break
  sleep 1
done
pass '/ping answers Ok.'

echo '--- the entrypoint contract Railway relies on ---'
expect_eq "database $CH_DB exists" \
  "SELECT count() FROM system.databases WHERE name = '$CH_DB'" 1
expect_eq "$CH_USER can authenticate and owns its grants" \
  "SELECT count() > 0 FROM system.grants WHERE user_name = '$CH_USER'" 1

echo '--- server settings come from boardsesh-lean.xml ---'
server_setting() {
  expect_eq "$1 = $2" "SELECT value FROM system.server_settings WHERE name = '$1'" "$2"
}
server_setting max_server_memory_usage 1200000000
server_setting mark_cache_size 134217728
server_setting uncompressed_cache_size 0
server_setting background_pool_size 2
server_setting background_schedule_pool_size 4
server_setting max_concurrent_queries 20
server_setting max_connections 64
server_setting max_thread_pool_size 128
server_setting asynchronous_metrics_update_period_s 60
expect_eq 'merge_tree free-entry thresholds fit the 4-slot pool' \
  "SELECT arrayStringConcat(groupArray(value), ',') FROM (SELECT value FROM system.merge_tree_settings
     WHERE name LIKE 'number_of_free_entries_in_pool_to_%' ORDER BY name)" '2,2,1'

# The configured value is not proof on its own: the server takes the lower of this
# and 90% of the cgroup, and a ratio of 0 silently means unlimited. So allocate
# past 1.2 GB (the container has 2 GB) and require the server's own total-memory
# error naming the 1.12 GiB ceiling, not an OOM kill.
over_limit="$(query 'SELECT length(groupArray(number)) FROM numbers(400000000)' 2>&1 || true)"
[[ "$over_limit" == *'(total) memory limit exceeded'*'maximum: 1.12 GiB'* ]] ||
  fail "a 1.6 GB query was not stopped at the 1.12 GiB ceiling: ${over_limit:0:300}"
[[ "$(docker inspect --format '{{.State.Running}}' "$container")" == 'true' ]] ||
  fail 'the server died instead of refusing the query'
pass 'a query past 1.2 GB is refused with "(total) memory limit exceeded ... maximum: 1.12 GiB"'

echo '--- an xprem-shaped table works under the small merge pool ---'
# The shape of xprem's Observe tables: MergeTree, DateTime64 timestamp, TTL
# through toDateTime(). Exercises create, insert, merge, a TTL merge and a
# mutation, all of which depend on the merge_tree section of the config.
query "CREATE TABLE $CH_DB.smoke_metrics (
         timestamp DateTime64(9, 'UTC'), name LowCardinality(String), value Float64)
       ENGINE = MergeTree ORDER BY (name, timestamp)
       TTL toDateTime(timestamp) + INTERVAL 90 DAY" ||
  fail 'CREATE TABLE MergeTree in expo_observe failed'
for _ in 1 2 3; do
  query "INSERT INTO $CH_DB.smoke_metrics
         SELECT now64(9) - toIntervalSecond(number), 'cold_ttr', number FROM numbers(1000)"
done
query "INSERT INTO $CH_DB.smoke_metrics VALUES (now64(9) - INTERVAL 200 DAY, 'expired', 1)"
query "OPTIMIZE TABLE $CH_DB.smoke_metrics FINAL" || fail 'OPTIMIZE FINAL failed'
expect_eq 'merges run and the TTL removed the expired row' \
  "SELECT count(), countIf(name = 'expired') FROM $CH_DB.smoke_metrics" "$(printf '3000\t0')"
query "ALTER TABLE $CH_DB.smoke_metrics DELETE WHERE value < 10 SETTINGS mutations_sync = 1" ||
  fail 'ALTER DELETE mutation failed'
expect_eq 'mutations complete' "SELECT count() FROM $CH_DB.smoke_metrics" 2970
query "DROP TABLE $CH_DB.smoke_metrics SYNC"

echo '--- only query_log remains, with a 7-day TTL ---'
sleep 10
query 'SYSTEM FLUSH LOGS'
expect_eq 'system.asynchronous_metric_log does not exist' \
  "SELECT count() FROM system.tables WHERE database = 'system' AND name = 'asynchronous_metric_log'" 0
expect_eq 'query_log is the only system log table' \
  "SELECT arrayStringConcat(groupArray(name), ',') FROM (SELECT name FROM system.tables
     WHERE database = 'system' AND engine = 'MergeTree' ORDER BY name)" query_log
expect_eq 'query_log carries the 7-day TTL' \
  "SELECT engine_full LIKE '%TTL event_date + toIntervalDay(7)%' FROM system.tables
     WHERE database = 'system' AND name = 'query_log'" 1

echo "--- idle for ${IDLE_SECONDS}s, then read resident memory ---"
sleep "$IDLE_SECONDS"
resident="$(query "SELECT toUInt64(value) FROM system.asynchronous_metrics WHERE metric = 'MemoryResident'")"
cgroup_usage="$(docker stats --no-stream --format '{{.MemUsage}}' "$container")"
printf '    MemoryResident = %s bytes (%s MB); docker stats: %s\n' \
  "$resident" "$((resident / 1000000))" "$cgroup_usage"
((resident < MAX_IDLE_RESIDENT_BYTES)) ||
  fail "idle resident memory $resident is not under $MAX_IDLE_RESIDENT_BYTES"
pass "idle resident memory under $((MAX_IDLE_RESIDENT_BYTES / 1000000)) MB"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo '## ClickHouse smoke'
    echo
    echo "Idle \`MemoryResident\` after ${IDLE_SECONDS}s: **$((resident / 1000000)) MB**"
    echo "(docker stats: $cgroup_usage)."
  } >>"$GITHUB_STEP_SUMMARY"
fi

echo 'clickhouse smoke: all checks passed'
