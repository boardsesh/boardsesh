#!/usr/bin/env bash
if [[ $- == *x* ]]; then
  set +x
fi
set -Eeuo pipefail
umask 077

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPOSITORY_ROOT
readonly POSTGRES_IMAGE='postgres:18.6-bookworm@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af'
readonly CONTAINER_NAME="boardsesh-task-roles-${GITHUB_RUN_ID:-local}-${$}"
TASK_TEMP_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/boardsesh-task-roles.XXXXXX")"
readonly TASK_TEMP_DIRECTORY
readonly CREDENTIALS_FILE="$TASK_TEMP_DIRECTORY/credentials.json"
readonly PGPASS_FILE="$TASK_TEMP_DIRECTORY/pgpass"
readonly FIXTURE_SQL="$TASK_TEMP_DIRECTORY/fixture.sql"
readonly REPORT_FILE="$TASK_TEMP_DIRECTORY/report.txt"

cleanup() {
  docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -rf "$TASK_TEMP_DIRECTORY"
}
trap cleanup EXIT

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

docker run --detach \
  --name "$CONTAINER_NAME" \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=postgres \
  --env POSTGRES_DB=railway \
  --volume "$TASK_TEMP_DIRECTORY:/run/boardsesh-task-roles" \
  --publish 127.0.0.1::5432 \
  "$POSTGRES_IMAGE" >/dev/null

host_port="$(docker port "$CONTAINER_NAME" 5432/tcp | sed -n 's/^127\.0\.0\.1://p' | head -n 1)"
[[ "$host_port" =~ ^[0-9]+$ ]] || fail 'could not resolve disposable PostgreSQL port'
readonly host_port

attempt=0
while [[ "$attempt" -lt 120 ]]; do
  if docker exec "$CONTAINER_NAME" \
    pg_isready --quiet -h 127.0.0.1 -p 5432 -U postgres -d railway; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if [[ "$attempt" -eq 120 ]]; then
  docker logs "$CONTAINER_NAME" >&2 || true
  fail 'disposable PostgreSQL did not become ready'
fi

readonly admin_url="postgresql://postgres:postgres@127.0.0.1:${host_port}/railway"
export ALLOW_DISPOSABLE_TASK_ROLE_SMOKE='ALLOW_EXACT_LOOPBACK_FIXTURE'

{
  cat <<'SQL'
CREATE ROLE boardsesh_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
GRANT CREATE ON DATABASE railway TO boardsesh_owner;
GRANT CREATE, USAGE ON SCHEMA public TO boardsesh_owner;
CREATE SCHEMA drizzle AUTHORIZATION boardsesh_owner;

-- Model the reviewed PG18 role-transition baseline explicitly. PUBLIC keeps
-- CONNECT, which every task role is allowed, but not TEMPORARY or access to
-- either application schema. The migration owner cannot create future PUBLIC
-- routines or types through PostgreSQL's built-in defaults.
REVOKE TEMPORARY ON DATABASE railway FROM PUBLIC;
REVOKE CREATE, USAGE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE, USAGE ON SCHEMA drizzle FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE boardsesh_owner REVOKE EXECUTE ON ROUTINES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE boardsesh_owner REVOKE USAGE ON TYPES FROM PUBLIC;
SET ROLE boardsesh_owner;
CREATE TYPE public.hold_type AS ENUM ('jug', 'sloper', 'pinch', 'crimp', 'pocket');
CREATE DOMAIN public.task_role_marker_domain AS text CHECK (VALUE <> 'domain-rejected');
SQL
  ROLE_CONTRACT_MODULE="file://$REPOSITORY_ROOT/scripts/lib/production-db-task-role-contract.mjs" \
    node --input-type=module -e '
      const contract = await import(process.env.ROLE_CONTRACT_MODULE);
      const relationNames = [...new Set(contract.PRODUCTION_TASK_RELATION_GRANTS.map(({ relation }) => relation))]
        .sort((left, right) => left.localeCompare(right));
      for (const relationName of relationNames) process.stdout.write(`${relationName}\n`);
    ' | while IFS= read -r relation_name; do
      [[ "$relation_name" =~ ^[a-z_][a-z0-9_]*$ ]] || fail "unsafe fixture relation $relation_name"
      printf 'CREATE TABLE public.%s (id bigserial PRIMARY KEY, marker text, board_type text, climb_uuid text, playlist_id bigint, user_id text, uuid text, role text, table_name text, record_id text);\n' \
        "$relation_name"
    done
  cat <<'SQL'
CREATE TABLE public.role_forbidden_probe (id bigint PRIMARY KEY, marker text NOT NULL);
ALTER TABLE public.user_hold_classifications
  ADD COLUMN classification public.hold_type;
ALTER TABLE public.board_climb_grades
  ADD COLUMN typed_marker public.task_role_marker_domain;
INSERT INTO public.role_forbidden_probe VALUES (1, 'must stay private');

CREATE FUNCTION public.task_role_playlist_delete_probe() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  playlist_uuid text;
  owner_id text;
BEGIN
  SELECT uuid INTO playlist_uuid FROM public.playlists WHERE id = OLD.playlist_id;
  SELECT user_id INTO owner_id FROM public.playlist_ownership
    WHERE playlist_id = OLD.playlist_id AND role = 'owner' LIMIT 1;
  INSERT INTO public.sync_deletions(table_name, record_id, user_id)
  VALUES ('playlist_climbs', playlist_uuid || ':' || OLD.climb_uuid, owner_id);
  RETURN OLD;
END;
$$;
CREATE TRIGGER task_role_playlist_delete
  AFTER DELETE ON public.playlist_climbs
  FOR EACH ROW EXECUTE FUNCTION public.task_role_playlist_delete_probe();

CREATE FUNCTION public.task_role_forbidden_call() RETURNS text
LANGUAGE sql AS 'SELECT ''must stay private''::text';

INSERT INTO public.playlists(marker, uuid) VALUES ('seed', 'playlist-seed');
INSERT INTO public.playlist_ownership(playlist_id, user_id, role)
SELECT id, 'system-recommendations', 'owner' FROM public.playlists WHERE uuid = 'playlist-seed';
INSERT INTO public.playlist_climbs(playlist_id, climb_uuid, marker)
SELECT id, 'climb-seed', 'seed' FROM public.playlists WHERE uuid = 'playlist-seed';
RESET ROLE;
SQL
} >"$FIXTURE_SQL"

docker exec --interactive "$CONTAINER_NAME" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d railway \
  <"$FIXTURE_SQL" >/dev/null

ROLE_CREDENTIALS_FILE="$CREDENTIALS_FILE" \
POSTGRES_FORWARDER_HOST='boardsesh-db-forwarder.smoke.tailnet.ts.net' \
  node "$REPOSITORY_ROOT/scripts/production-db-task-roles.mjs" generate >/dev/null

if ! ADMIN_DATABASE_URL="$admin_url" \
  APPLY_TASK_ROLE_CHANGES='APPLY_EXACT_SIX_TASK_ROLES' \
  ROLE_CREDENTIALS_FILE="$CREDENTIALS_FILE" \
  node "$REPOSITORY_ROOT/scripts/production-db-task-roles.mjs" apply >"$REPORT_FILE" 2>&1; then
  cat "$REPORT_FILE" >&2
  fail 'initial task-role apply failed'
fi

# The second apply proves idempotency while rotating to the same six passwords.
ADMIN_DATABASE_URL="$admin_url" \
APPLY_TASK_ROLE_CHANGES='APPLY_EXACT_SIX_TASK_ROLES' \
ROLE_CREDENTIALS_FILE="$CREDENTIALS_FILE" \
  node "$REPOSITORY_ROOT/scripts/production-db-task-roles.mjs" apply >/dev/null

ADMIN_DATABASE_URL="$admin_url" \
  node "$REPOSITORY_ROOT/scripts/production-db-task-roles.mjs" audit >/dev/null

ROLE_CREDENTIALS_FILE="$CREDENTIALS_FILE" \
PGPASS_TARGET="$PGPASS_FILE" \
PGPASS_HOST=127.0.0.1 \
PGPASS_PORT=5432 \
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const credentials = JSON.parse(readFileSync(process.env.ROLE_CREDENTIALS_FILE, "utf8"));
    const lines = Object.entries(credentials.roles).map(
      ([roleName, credential]) =>
        `${process.env.PGPASS_HOST}:${process.env.PGPASS_PORT}:railway:${roleName}:${credential.password}`,
    );
    writeFileSync(process.env.PGPASS_TARGET, `${lines.join("\n")}\n`, { mode: 0o600 });
  '

run_role() {
  local role_name="$1" application_name="$2"
  shift 2
  docker exec --interactive \
    --env PGPASSFILE=/run/boardsesh-task-roles/pgpass \
    --env PGAPPNAME="$application_name" \
    "$CONTAINER_NAME" \
    psql -X -v ON_ERROR_STOP=1 \
      -h 127.0.0.1 -p 5432 -U "$role_name" -d railway "$@"
}

assert_identity() {
  local role_name="$1" application_name="$2" identity
  identity="$(run_role "$role_name" "$application_name" -Atq \
    -c "SELECT current_user || '|' || current_setting('application_name');")"
  [[ "$identity" == "$role_name|$application_name" ]] || fail "identity/application_name mismatch for $role_name"
}

assert_no_type_usage() {
  local role_name="$1" application_name="$2" privilege_state
  privilege_state="$(run_role "$role_name" "$application_name" -Atq -c \
    "SELECT has_type_privilege(current_user, 'public.hold_type', 'USAGE')::text || '|' || has_type_privilege(current_user, 'public.task_role_marker_domain', 'USAGE')::text;")"
  [[ "$privilege_state" == 'false|false' ]] || fail "$role_name unexpectedly has application type USAGE"
}

assert_denied() {
  local role_name="$1" application_name="$2" statement="$3"
  if run_role "$role_name" "$application_name" -c "$statement" >/dev/null 2>&1; then
    fail "$role_name unexpectedly passed a denied privilege probe"
  fi
}

assert_cluster_boundary_drift() {
  local expected_difference="$1" drift_label="$2"
  if ADMIN_DATABASE_URL="$admin_url" \
    node "$REPOSITORY_ROOT/scripts/production-db-task-roles.mjs" audit >"$REPORT_FILE" 2>&1; then
    fail "expected $drift_label to fail audit"
  fi
  grep -Fq "$expected_difference" "$REPORT_FILE" || {
    cat "$REPORT_FILE" >&2
    fail "audit did not identify $drift_label"
  }
  if ADMIN_DATABASE_URL="$admin_url" \
    APPLY_TASK_ROLE_CHANGES='APPLY_EXACT_SIX_TASK_ROLES' \
    ROLE_CREDENTIALS_FILE="$CREDENTIALS_FILE" \
    node "$REPOSITORY_ROOT/scripts/production-db-task-roles.mjs" apply >"$REPORT_FILE" 2>&1; then
    fail "apply accepted $drift_label"
  fi
  grep -Fq \
    'cluster-wide PUBLIC/default ACL prerequisites require separate reviewed remediation; apply never changes them' \
    "$REPORT_FILE" || {
    cat "$REPORT_FILE" >&2
    fail "apply did not refuse $drift_label as a cluster-wide prerequisite"
  }
  if ADMIN_DATABASE_URL="$admin_url" \
    node "$REPOSITORY_ROOT/scripts/production-db-task-roles.mjs" audit >"$REPORT_FILE" 2>&1; then
    fail "apply silently remediated $drift_label"
  fi
  grep -Fq "$expected_difference" "$REPORT_FILE" || {
    cat "$REPORT_FILE" >&2
    fail "apply changed $drift_label before refusing it"
  }
}

assert_identity boardsesh_migrator boardsesh-ci-migrate
assert_identity boardsesh_snapshot_exporter boardsesh-ci-snapshot-export
assert_identity boardsesh_climb_grades_refresh boardsesh-ci-climb-grades
assert_identity boardsesh_content_model_refresh boardsesh-ci-content-model
assert_identity boardsesh_hold_features_refresh boardsesh-ci-hold-features
assert_identity boardsesh_recommendations_refresh boardsesh-ci-recommendations

assert_no_type_usage boardsesh_climb_grades_refresh boardsesh-ci-climb-grades
assert_no_type_usage boardsesh_hold_features_refresh boardsesh-ci-hold-features
trigger_execute_state="$(run_role boardsesh_recommendations_refresh boardsesh-ci-recommendations -Atq -c \
  "SELECT has_function_privilege(current_user, 'public.task_role_playlist_delete_probe()', 'EXECUTE')::text;")"
[[ "$trigger_execute_state" == 'false' ]] || fail 'recommendations role unexpectedly has trigger routine EXECUTE'

run_role boardsesh_migrator boardsesh-ci-migrate <<'SQL' >/dev/null
BEGIN;
SET LOCAL ROLE boardsesh_owner;
CREATE SCHEMA boardsesh_task_role_migrator_rollback_probe;
ROLLBACK;
SQL

run_role boardsesh_snapshot_exporter boardsesh-ci-snapshot-export <<'SQL' >/dev/null
BEGIN;
SELECT current_setting('transaction_read_only') = 'on';
SELECT 1 FROM board_climbs LIMIT 0;
SELECT 1 FROM board_climb_stats LIMIT 0;
SELECT 1 FROM board_climb_grades LIMIT 0;
SELECT 1 FROM board_products LIMIT 0;
SELECT 1 FROM board_beta_links LIMIT 0;
ROLLBACK;
SQL
assert_denied boardsesh_snapshot_exporter boardsesh-ci-snapshot-export \
  "INSERT INTO board_climbs(marker) VALUES ('forbidden')"

run_role boardsesh_climb_grades_refresh boardsesh-ci-climb-grades <<'SQL' >/dev/null
BEGIN;
CREATE TEMP TABLE grade_refresh_keys(id bigint);
SELECT 1 FROM board_climb_embeddings LIMIT 0;
SELECT 1 FROM boardsesh_ticks LIMIT 0;
INSERT INTO board_grade_coefficients(marker) VALUES ('probe');
UPDATE board_grade_coefficients SET marker = 'updated' WHERE marker = 'probe';
INSERT INTO board_climb_grades(marker) VALUES ('probe');
UPDATE board_climb_grades SET typed_marker = 'domain-probe' WHERE marker = 'probe';
SELECT typed_marker FROM board_climb_grades WHERE marker = 'probe';
DELETE FROM board_climb_grades WHERE marker = 'probe';
ROLLBACK;
SQL

run_role boardsesh_content_model_refresh boardsesh-ci-content-model <<'SQL' >/dev/null
BEGIN;
SELECT 1 FROM board_hold_features LIMIT 0;
SELECT 1 FROM board_climb_holds LIMIT 0;
INSERT INTO board_climb_embeddings(marker) VALUES ('probe');
UPDATE board_climb_embeddings SET marker = 'updated' WHERE marker = 'probe';
INSERT INTO board_climb_similar(marker) VALUES ('probe');
DELETE FROM board_climb_similar WHERE marker = 'probe';
ROLLBACK;
SQL

run_role boardsesh_hold_features_refresh boardsesh-ci-hold-features <<'SQL' >/dev/null
BEGIN;
SELECT 1 FROM board_placements LIMIT 0;
SELECT 1 FROM board_product_sizes_layouts_sets LIMIT 0;
INSERT INTO users(marker) VALUES ('probe');
INSERT INTO board_hold_features(marker) VALUES ('probe');
UPDATE board_hold_features SET marker = 'updated' WHERE marker = 'probe';
INSERT INTO user_hold_classifications(marker) VALUES ('probe');
UPDATE user_hold_classifications SET classification = 'crimp' WHERE marker = 'probe';
SELECT classification FROM user_hold_classifications WHERE marker = 'probe';
UPDATE user_hold_classifications SET marker = 'updated' WHERE marker = 'probe';
ROLLBACK;
SQL

run_role boardsesh_recommendations_refresh boardsesh-ci-recommendations <<'SQL' >/dev/null
BEGIN;
SELECT 1 FROM board_climbs LIMIT 0;
INSERT INTO users(marker) VALUES ('probe');
INSERT INTO board_setter_stats(marker) VALUES ('probe');
UPDATE board_setter_stats SET marker = 'updated' WHERE marker = 'probe';
INSERT INTO board_climb_send_stats(marker) VALUES ('probe');
DELETE FROM board_climb_send_stats WHERE marker = 'probe';
INSERT INTO board_climb_stats_history(marker) VALUES ('probe');
INSERT INTO board_shared_syncs(marker) VALUES ('probe');
UPDATE board_shared_syncs SET marker = 'updated' WHERE marker = 'probe';
INSERT INTO playlists(marker, uuid) VALUES ('probe', 'playlist-probe');
INSERT INTO playlist_ownership(playlist_id, user_id, role)
SELECT id, 'system-recommendations', 'owner' FROM playlists WHERE uuid = 'playlist-probe';
INSERT INTO playlist_climbs(playlist_id, climb_uuid, marker)
SELECT id, 'climb-probe', 'probe' FROM playlists WHERE uuid = 'playlist-probe';
DELETE FROM playlist_climbs WHERE marker = 'probe';
ROLLBACK;
SQL

for identity_pair in \
  'boardsesh_migrator|boardsesh-ci-migrate' \
  'boardsesh_snapshot_exporter|boardsesh-ci-snapshot-export' \
  'boardsesh_climb_grades_refresh|boardsesh-ci-climb-grades' \
  'boardsesh_content_model_refresh|boardsesh-ci-content-model' \
  'boardsesh_hold_features_refresh|boardsesh-ci-hold-features' \
  'boardsesh_recommendations_refresh|boardsesh-ci-recommendations'; do
  role_name="${identity_pair%%|*}"
  application_name="${identity_pair#*|}"
  assert_denied "$role_name" "$application_name" 'SELECT * FROM role_forbidden_probe'
  assert_denied "$role_name" "$application_name" 'SELECT task_role_forbidden_call()'
  assert_denied "$role_name" "$application_name" \
    "BEGIN; CREATE SCHEMA ${role_name}_must_not_create; ROLLBACK;"
done

# PUBLIC is an implicit member of every login. Prove that plan/audit resolves
# PostgreSQL defaults, apply refuses to change cluster-wide policy, and a
# separately reviewed operator remediation returns the exact contract to green.
docker exec "$CONTAINER_NAME" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d railway \
  -c 'GRANT TEMPORARY ON DATABASE railway TO PUBLIC' >/dev/null
assert_cluster_boundary_drift \
  'cluster prerequisite PUBLIC|database|railway|TEMPORARY|grantable=false; reviewed remediation: REVOKE TEMPORARY ON DATABASE railway FROM PUBLIC' \
  'PUBLIC database TEMPORARY drift'
docker exec "$CONTAINER_NAME" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d railway \
  -c 'REVOKE TEMPORARY ON DATABASE railway FROM PUBLIC' >/dev/null

docker exec "$CONTAINER_NAME" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d railway \
  -c 'GRANT CREATE, USAGE ON SCHEMA public TO PUBLIC' >/dev/null
assert_cluster_boundary_drift \
  'cluster prerequisite PUBLIC|schema|public|CREATE|grantable=false; reviewed remediation: REVOKE CREATE ON SCHEMA public FROM PUBLIC' \
  'PUBLIC schema CREATE/USAGE drift'
docker exec "$CONTAINER_NAME" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d railway \
  -c 'REVOKE CREATE, USAGE ON SCHEMA public FROM PUBLIC' >/dev/null

docker exec "$CONTAINER_NAME" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d railway \
  -c 'GRANT SELECT ON role_forbidden_probe TO PUBLIC' >/dev/null
assert_cluster_boundary_drift \
  'cluster prerequisite PUBLIC|relation|public.role_forbidden_probe|SELECT|grantable=false; reviewed remediation: REVOKE SELECT ON TABLE public.role_forbidden_probe FROM PUBLIC' \
  'PUBLIC table drift'
docker exec "$CONTAINER_NAME" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d railway \
  -c 'REVOKE SELECT ON role_forbidden_probe FROM PUBLIC' >/dev/null

docker exec "$CONTAINER_NAME" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d railway \
  -c 'GRANT USAGE ON SEQUENCE playlists_id_seq TO PUBLIC' >/dev/null
assert_cluster_boundary_drift \
  'cluster prerequisite PUBLIC|sequence|public.playlists_id_seq|USAGE|grantable=false; reviewed remediation: REVOKE USAGE ON SEQUENCE public.playlists_id_seq FROM PUBLIC' \
  'PUBLIC sequence drift'
docker exec "$CONTAINER_NAME" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d railway \
  -c 'REVOKE USAGE ON SEQUENCE playlists_id_seq FROM PUBLIC' >/dev/null

docker exec "$CONTAINER_NAME" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d railway \
  -c 'GRANT EXECUTE ON FUNCTION task_role_playlist_delete_probe() TO PUBLIC' >/dev/null
assert_cluster_boundary_drift \
  'cluster prerequisite PUBLIC|routine|task_role_playlist_delete_probe()|EXECUTE|grantable=false; reviewed remediation: REVOKE EXECUTE ON ROUTINE task_role_playlist_delete_probe() FROM PUBLIC' \
  'PUBLIC current-routine drift'
docker exec "$CONTAINER_NAME" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d railway \
  -c 'REVOKE EXECUTE ON FUNCTION task_role_playlist_delete_probe() FROM PUBLIC' >/dev/null

docker exec "$CONTAINER_NAME" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d railway \
  -c 'ALTER DEFAULT PRIVILEGES FOR ROLE boardsesh_owner GRANT EXECUTE ON ROUTINES TO PUBLIC' >/dev/null
assert_cluster_boundary_drift \
  'cluster prerequisite PUBLIC|default_acl|boardsesh_owner:*:f|EXECUTE|grantable=false; reviewed remediation: ALTER DEFAULT PRIVILEGES FOR ROLE boardsesh_owner REVOKE EXECUTE ON ROUTINES FROM PUBLIC' \
  'migration-owner global default-routine drift'
docker exec "$CONTAINER_NAME" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d railway \
  -c 'ALTER DEFAULT PRIVILEGES FOR ROLE boardsesh_owner REVOKE EXECUTE ON ROUTINES FROM PUBLIC' >/dev/null

docker exec "$CONTAINER_NAME" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d railway \
  -c 'ALTER DEFAULT PRIVILEGES FOR ROLE boardsesh_owner IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC' >/dev/null
assert_cluster_boundary_drift \
  'cluster prerequisite PUBLIC|default_acl|boardsesh_owner:public:r|SELECT|grantable=false; reviewed remediation: ALTER DEFAULT PRIVILEGES FOR ROLE boardsesh_owner IN SCHEMA public REVOKE SELECT ON TABLES FROM PUBLIC' \
  'migration-owner schema default-table drift'
docker exec "$CONTAINER_NAME" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d railway \
  -c 'ALTER DEFAULT PRIVILEGES FOR ROLE boardsesh_owner IN SCHEMA public REVOKE SELECT ON TABLES FROM PUBLIC' >/dev/null

ADMIN_DATABASE_URL="$admin_url" \
  node "$REPOSITORY_ROOT/scripts/production-db-task-roles.mjs" audit >/dev/null

# Add one reviewed-role ACL outside the manifest. Audit must show the exact diff,
# rollback must refuse the drift, and apply must remove it without touching data.
docker exec "$CONTAINER_NAME" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d railway \
  -c 'GRANT SELECT ON role_forbidden_probe TO boardsesh_content_model_refresh WITH GRANT OPTION' >/dev/null
if ADMIN_DATABASE_URL="$admin_url" \
  node "$REPOSITORY_ROOT/scripts/production-db-task-roles.mjs" audit >"$REPORT_FILE" 2>&1; then
  fail 'expected an injected grant drift to fail audit'
fi
grep -Fq \
  'unexpected grant boardsesh_content_model_refresh|relation|public.role_forbidden_probe|SELECT' \
  "$REPORT_FILE" || { cat "$REPORT_FILE" >&2; fail 'grant diff did not identify the injected ACL'; }
grep -Fq \
  'grant option forbidden boardsesh_content_model_refresh|relation|public.role_forbidden_probe|SELECT' \
  "$REPORT_FILE" || { cat "$REPORT_FILE" >&2; fail 'grant diff did not identify the injected grant option'; }

if ADMIN_DATABASE_URL="$admin_url" \
  ROLLBACK_TASK_ROLES='DROP_EXACT_SIX_TASK_ROLES' \
  node "$REPOSITORY_ROOT/scripts/production-db-task-roles.mjs" rollback >"$REPORT_FILE" 2>&1; then
  fail 'rollback accepted a drifted role contract'
fi
grep -Fq 'rollback refuses a partial or drifted role contract' "$REPORT_FILE" || {
  cat "$REPORT_FILE" >&2
  fail 'rollback drift guard did not report its refusal'
}

if ADMIN_DATABASE_URL="$admin_url" \
  APPLY_TASK_ROLE_CHANGES='APPLY_EXACT_SIX_TASK_ROLES' \
  ROLE_CREDENTIALS_FILE="$CREDENTIALS_FILE" \
  node "$REPOSITORY_ROOT/scripts/production-db-task-roles.mjs" apply >"$REPORT_FILE" 2>&1; then
  fail 'apply accepted an unexpected grant option'
fi
grep -Fq 'managed role has a grant option; downstream grants require manual review' "$REPORT_FILE" || {
  cat "$REPORT_FILE" >&2
  fail 'apply grant-option guard did not report its refusal'
}

docker exec "$CONTAINER_NAME" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d railway \
  -c 'REVOKE GRANT OPTION FOR SELECT ON role_forbidden_probe FROM boardsesh_content_model_refresh' >/dev/null

ADMIN_DATABASE_URL="$admin_url" \
APPLY_TASK_ROLE_CHANGES='APPLY_EXACT_SIX_TASK_ROLES' \
ROLE_CREDENTIALS_FILE="$CREDENTIALS_FILE" \
  node "$REPOSITORY_ROOT/scripts/production-db-task-roles.mjs" apply >/dev/null

docker exec "$CONTAINER_NAME" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d railway \
  -c 'CREATE POLICY task_role_forbidden_policy ON role_forbidden_probe TO boardsesh_content_model_refresh USING (true)' >/dev/null
if ADMIN_DATABASE_URL="$admin_url" \
  node "$REPOSITORY_ROOT/scripts/production-db-task-roles.mjs" audit >"$REPORT_FILE" 2>&1; then
  fail 'expected an injected RLS role reference to fail audit'
fi
grep -Fq \
  'unexpected RLS policy boardsesh_content_model_refresh|public.role_forbidden_probe|task_role_forbidden_policy' \
  "$REPORT_FILE" || { cat "$REPORT_FILE" >&2; fail 'audit did not identify the injected RLS policy'; }
if ADMIN_DATABASE_URL="$admin_url" \
  APPLY_TASK_ROLE_CHANGES='APPLY_EXACT_SIX_TASK_ROLES' \
  ROLE_CREDENTIALS_FILE="$CREDENTIALS_FILE" \
  node "$REPOSITORY_ROOT/scripts/production-db-task-roles.mjs" apply >"$REPORT_FILE" 2>&1; then
  fail 'apply accepted an unexpected RLS role reference'
fi
grep -Fq 'managed role is named in an RLS policy; manual policy review is required' "$REPORT_FILE" || {
  cat "$REPORT_FILE" >&2
  fail 'apply RLS-policy guard did not report its refusal'
}
docker exec "$CONTAINER_NAME" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d railway \
  -c 'DROP POLICY task_role_forbidden_policy ON role_forbidden_probe' >/dev/null
ADMIN_DATABASE_URL="$admin_url" \
  node "$REPOSITORY_ROOT/scripts/production-db-task-roles.mjs" audit >/dev/null

ADMIN_DATABASE_URL="$admin_url" \
ROLLBACK_TASK_ROLES='DROP_EXACT_SIX_TASK_ROLES' \
  node "$REPOSITORY_ROOT/scripts/production-db-task-roles.mjs" rollback >/dev/null
ADMIN_DATABASE_URL="$admin_url" \
ROLLBACK_TASK_ROLES='DROP_EXACT_SIX_TASK_ROLES' \
  node "$REPOSITORY_ROOT/scripts/production-db-task-roles.mjs" rollback >/dev/null

survival_contract="$(docker exec "$CONTAINER_NAME" \
  psql -X -Atq -U postgres -d railway -c "
SELECT (SELECT count(*) = 0 FROM pg_roles WHERE rolname IN (
         'boardsesh_migrator', 'boardsesh_snapshot_exporter', 'boardsesh_climb_grades_refresh',
         'boardsesh_content_model_refresh', 'boardsesh_hold_features_refresh',
         'boardsesh_recommendations_refresh'))::text || '|' ||
       (to_regrole('boardsesh_owner') IS NOT NULL)::text || '|' ||
       (to_regclass('public.role_forbidden_probe') IS NOT NULL)::text || '|' ||
       (SELECT marker FROM role_forbidden_probe WHERE id = 1);")"
[[ "$survival_contract" == 'true|true|true|must stay private' ]] || fail 'rollback touched owner or application data'

printf 'Production task-role disposable PostgreSQL smoke passed.\n'
