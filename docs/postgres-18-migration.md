# PostgreSQL 16 to 18.4 Migration and Availability Runbook

This is the current database contract and the one-way Railway PostgreSQL
upgrade procedure. It replaces the cutover and rollback advice in
`docs/neon-migration.md`.

## Decision and boundaries

- Upgrade directly from PostgreSQL 16 to PostgreSQL 18.4. PostgreSQL 17 is not
  an intermediate step.
- Build a new Railway PostgreSQL 18.4 candidate on a fresh volume and use
  built-in logical replication from the PostgreSQL 16 primary. Do not run an
  in-place `pg_upgrade --link` on the Railway volume.
- The PostgreSQL 16 source remains the only writer until the cutover fence.
  There is no automatic failover and no dual-write period.
- The first committed application write on PostgreSQL 18 is the irreversible
  boundary. After that point, recovery is fix-forward on PostgreSQL 18 or a
  restore/reseed into PostgreSQL 18. Do not point writers back at PostgreSQL 16
  and do not attempt reverse PostgreSQL 18 to 16 logical replication.
- PgBouncer, the homelab physical standby, WAL-G, and moving offline snapshot
  generation are separate follow-up stages. None is on the major-upgrade
  critical path.
- Keep offline snapshot generation on the Railway primary throughout the major
  upgrade. Its cursor ordering uses write-time `(updated_at, sync_seq)`
  semantics; a standby can expose a higher cursor before a delayed lower-cursor
  transaction. The separately gated replica-export protocol in
  `docs/board-snapshots.md` may cut over only after its database-enforced cursor
  invariant, primary LSN/cutoff barrier, delayed-commit test, post-upgrade
  physical standby, and shadow-run gates all pass. It is not part of this
  upgrade's critical path.

## Pinned database artifact

The portable development and CI base is:

- PostgreSQL `18.4`
- official base `postgres:18.4-bookworm` at
  `sha256:882236b897e39051d2368c5ccc6cda944904723506b2dfc97f2a8f5bc9afa382`
- PGDG PostGIS `3.6.4+dfsg-2.pgdg12+1`
- PGDG HypoPG `1.4.3-1.pgdg12+1`

`.github/workflows/dev-db-docker.yml` builds both architectures of the portable
PostGIS image, attests the result, and boots it on a fresh parent volume before
publishing. The same workflow builds and boots the final seeded dev image on a
fresh volume, validates seed rows and the Drizzle ledger, restarts the same
volume, and validates it again.

Record the resulting **Boardsesh image digest**, not just a tag. Railway and the
homelab must use that same digest. Before either is started, verify its OCI
labels, `postgres --version`, and installed PostGIS version. A tag such as
`latest` or `pg18` is a discovery aid, not a production pin.

### Two-step image rollout

The first change cannot know the digest of an image it has not published. Roll
out the foundation in two steps:

1. Merge/run the image publisher and let its final seeded-image smoke test pass.
   Record the emitted portable-image and seeded-image digests.
2. In a follow-up change, replace the old seeded PG17 digest in
   `.github/workflows/ci.yml`, the mutable
   `boardsesh-postgres-postgis:latest` backend-test service, and every mutable
   `boardsesh-dev-db:latest` consumer with the emitted PG18 digests. Run the
   full CI suite before creating a Railway candidate. Acceptance requires zero
   mutable database-image tags in CI, end-to-end tests, or renumber workflows.

Root Compose defaults to `boardsesh-dev-db:pg18` so it cannot silently initialize
a PG17 server under a PG18 path during this transition. Before that tag exists,
set `BOARDSESH_DEV_DB_IMAGE` to an already-published branch/SHA image from a
publisher run, or to a locally built image tag.

## PostgreSQL 18 volume contract

The official PostgreSQL image changed its storage contract in PostgreSQL 18:

- `PGDATA=/var/lib/postgresql/18/docker`
- mount the persistent volume at `/var/lib/postgresql`

Never mount the PostgreSQL 18 volume at `/var/lib/postgresql/data`, and never
reuse the PostgreSQL 16 volume. The seeded image stores its immutable build seed
outside the declared volume and copies it on first start. It writes the runtime
ready marker only after the full copy succeeds. It rejects:

- a PG16 cluster anywhere in the mounted parent;
- a partially copied PG18 cluster;
- a PG18 cluster that is not a Boardsesh seeded dev database; and
- a nonstandard `PGDATA`.

Use versioned volume names. Retain old volumes until their replacement has been
validated; never move PG16 files into the PG18 directory.

## Hard gates before a candidate exists

### 1. Resolve the PostGIS version

The target artifact is PostGIS 3.6.4. Production was previously observed as
`3.7.0dev`. A PostGIS downgrade is not assumed to be supported or wire-compatible.
The catalog audit deliberately blocks unless source and target are both 3.6.4.

Before proceeding, an operator must confirm the current production version and
choose a supported path:

- move the source to a supported stable 3.6.4 release before replication, or
- change the target artifact to a supported equal/newer PostGIS release and
  repeat every image/rehearsal gate.

There is no override flag. A full rehearsal must restore the schema, copy every
geography/geometry value, exercise spatial indexes and queries, and compare
representative `ST_AsEWKB` values.

### 2. Publish and pin the PG18 image

Run the image workflow, record its digest, and verify the same digest is
configured for the Railway candidate and future homelab standby. Do not add
WAL-G to this image. WAL-G uses a separately pinned sidecar/credential boundary
in the later backup stage.

### 3. Source-only catalog audit

Inject database URLs through the secret manager. Do not paste them into the
runbook, shell history, CI logs, or a world-readable environment file.

```bash
SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
  scripts/postgres-migration-audit.sh
```

The audit is read-only and fails closed. It checks:

- source major version, `wal_level`, and replication-slot capacity;
- every persistent non-extension relation belongs to an explicit included or
  excluded schema;
- an explicit table publication manifest (never `FOR ALL TABLES`);
- replica identity for update/delete replication;
- owned and unowned sequences;
- prepared transactions, large objects, and materialized views;
- extensions, including the strict PostGIS gate;
- roles, object/function/type/schema owners, explicit/default grants,
  SECURITY DEFINER functions, and RLS policies;
- columns, defaults, constraints, indexes, relation/partition/view/sequence
  definitions, functions, triggers, policies, and types in a DDL fingerprint;
  and
- the Drizzle migration-ledger high-water mark.

Resolve every blocker. Do not merely remove a schema from the include list: an
unknown schema is itself a blocker until explicitly classified.

### 4. Rehearse PostgreSQL 16 to PostgreSQL 18

`vp run test:postgres18-image` exercises the image, catalog tooling, and a
two-host logical copy with PG18 at both ends. It does **not** prove cross-major
behavior. Before a Railway candidate is allowed, run the complete helper,
source/target audit, initial copy, sequence fence, data digest, representative
PostGIS queries, and failback drill from an actual PG16 clone to the exact pinned
PG18 image. Treat any cross-major catalog/deparser fingerprint difference as an
investigation, not an ignored mismatch. This remains a hard external gate until
CI owns a representative PG16 fixture.

## Target roles and secrets

Use separate roles for data ownership, application traffic, logical copy, and
future standby traffic. Substitute the real names consistently:

- `boardsesh_owner`: `NOLOGIN`, owns application schemas and non-extension
  objects, has `CREATE` on the application database, and is never used as a
  connection credential;
- `boardsesh_runtime`: `LOGIN`, app CRUD plus sequence `USAGE`, no
  superuser/replication/bypass-RLS privileges;
- `boardsesh_migrator`: `LOGIN`, can `SET ROLE` to `boardsesh_owner`, used only
  for migrations; and
- `boardsesh_pg16_publisher`: on PG16 only, `LOGIN REPLICATION`, `SELECT` on
  every explicitly published table, `USAGE` on their schemas, and
  `row_security=off`; this is the subscription connection credential;
- `boardsesh_pg18_subscriber`: on PG18 only, a temporary `LOGIN` subscription
  owner with no application password, database `CREATE`, effective
  `pg_create_subscription`, and a non-inheriting `SET ROLE` membership in
  `boardsesh_owner`; and
- `boardsesh_standby`: `LOGIN REPLICATION`, no application DML, reserved for
  the later homelab physical standby.

Store credentials separately. On the homelab use root-owned mode `0600` files
or systemd credentials. In Ansible, secret-bearing tasks use `no_log: true` and
`diff: false`. Never embed passwords in unit files, Compose YAML, Git, or command
examples.

Create the roles before schema restore. PostgreSQL 18 memberships for the
migrator and subscriber must use `INHERIT FALSE, SET TRUE`; the audit checks
both `pg_auth_members.inherit_option` and `set_option`. The logical apply worker
requires its subscription owner to have `LOGIN`, even when that role has no
external password. It also needs `USAGE` on every target application schema to
register publication tables; the setup helper grants and the audit verifies that
access. The migration admin may create extensions, but app functions and
SECURITY DEFINER functions must never end up owned by that admin/superuser.

Example target shape, executed by the target admin after substituting the real
database name:

```sql
CREATE ROLE boardsesh_owner NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS;
CREATE ROLE boardsesh_runtime LOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS;
CREATE ROLE boardsesh_migrator LOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS;
CREATE ROLE boardsesh_pg18_subscriber LOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS;
CREATE ROLE boardsesh_standby LOGIN NOSUPERUSER REPLICATION NOBYPASSRLS;

GRANT CREATE ON DATABASE boardsesh TO boardsesh_owner;
GRANT CREATE ON DATABASE boardsesh TO boardsesh_pg18_subscriber;
GRANT pg_create_subscription TO boardsesh_pg18_subscriber;
GRANT boardsesh_owner TO boardsesh_migrator
  WITH INHERIT FALSE, SET TRUE;
GRANT boardsesh_owner TO boardsesh_pg18_subscriber
  WITH INHERIT FALSE, SET TRUE;
```

On PG16, grant the publisher only the schema/table access in the explicit
publication manifest and set `ALTER ROLE boardsesh_pg16_publisher SET
row_security = off`. The audit performs a zero-row `SELECT` through that exact
credential for every table. A later RLS policy therefore stops the migration
instead of silently copying a filtered subset.

## Build the PG18 candidate

1. Create a new Railway service from the exact attested Boardsesh PG18 image
   digest and a fresh parent volume.
2. Verify `server_version_num = 180004`, `data_checksums = on`, and PostGIS
   `3.6.4`.
3. Install required extensions as the target admin:

   ```sql
   CREATE EXTENSION IF NOT EXISTS postgis;
   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   CREATE EXTENSION IF NOT EXISTS hypopg;
   ```

4. Dump source schema without publications/subscriptions, owners, or ACLs.
   Pre-create extensions as the target admin, then remove `EXTENSION` and
   `COMMENT ON EXTENSION` entries from the custom archive restore list. Those
   entries cannot safely run as the application owner. Give the owner `CREATE`
   on the database, pre-create every included application schema (`public` and
   `drizzle`) under that owner, and restore the filtered list while set to that
   role:

   ```bash
   pg_dump --schema-only --no-owner --no-acl \
     --schema=public --schema=drizzle \
     --no-publications --no-subscriptions --format=custom \
     --file "$SCHEMA_DUMP" "$SOURCE_DATABASE_URL"

   pg_restore --list "$SCHEMA_DUMP" >"$RESTORE_LIST"
   awk '$0 !~ / SCHEMA - / && $0 !~ / EXTENSION - / && $0 !~ / COMMENT - EXTENSION / { print }' \
     "$RESTORE_LIST" >"$FILTERED_RESTORE_LIST"

   pg_restore --exit-on-error --schema-only --no-owner --no-acl \
     --role "$MIGRATION_OWNER_ROLE" \
     --use-list "$FILTERED_RESTORE_LIST" \
     --dbname "$TARGET_DATABASE_URL" "$SCHEMA_DUMP"
   ```

   `scripts/neon-to-railway-replication.sh setup` implements this filtering and
   ownership sequence. A restore that reports ignored errors is a failed gate;
   do not record or continue past partially restored DDL.

5. Make the application schemas and every non-extension app relation, function,
   and user type owned by the NOLOGIN owner. Apply deterministic least-privilege
   grants to runtime and matching `ALTER DEFAULT PRIVILEGES FOR ROLE ... IN
SCHEMA ...` rules for future tables, sequences, and functions. Revoke broad
   `PUBLIC` schema/function access first where the app does not need it.
6. Prove the runtime credential can connect and perform representative reads and
   writes in a rollback transaction; prove the migrator can `SET ROLE`; prove
   the replication credential has no application DML grants.

Run a source/target audit with all role names:

```bash
SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
TARGET_DATABASE_URL="$TARGET_DATABASE_URL" \
MIGRATION_OWNER_ROLE=boardsesh_owner \
MIGRATION_RUNTIME_ROLE=boardsesh_runtime \
MIGRATION_MIGRATOR_ROLE=boardsesh_migrator \
MIGRATION_REPLICATION_ROLE=boardsesh_standby \
  scripts/postgres-migration-audit.sh
```

It is expected to fail until schema ownership, grants, extension versions, the
Drizzle ledger, and the DDL fingerprint match.

## Start logical replication

Freeze all application DDL and Drizzle migrations before publication creation.
Keep that freeze through cutover. A new table is not silently safe: regenerate
the catalog manifest, add it to the publication, refresh the subscription, and
repeat initial-copy and verification gates, or restart the rehearsal.

Use the complete `CREATE PUBLICATION ... FOR TABLE ...` statement emitted by the
catalog audit. Do not use `FOR ALL TABLES`; it would include extension-owned
tables such as `spatial_ref_sys`.

The guarded helper accepts generic aliases for its historical environment names:

```bash
SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
TARGET_DATABASE_URL="$TARGET_DATABASE_URL" \
SOURCE_REPLICATION_DATABASE_URL="$SOURCE_REPLICATION_DATABASE_URL" \
TARGET_OWNER_ROLE=boardsesh_owner \
TARGET_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
PUBLICATION_NAME=boardsesh_pg18_migration \
SUBSCRIPTION_NAME=boardsesh_pg18_sub \
SLOT_NAME=boardsesh_pg18_sub \
INCLUDE_SCHEMAS='public drizzle' \
EXCLUDE_SCHEMAS='neon_auth neon_control_plane' \
  scripts/neon-to-railway-replication.sh setup
```

The subscription must be owned by `boardsesh_pg18_subscriber` and use
`copy_data=true`, `binary=false`, `origin=none`, `run_as_owner=false`, and a
dedicated logical slot. Cap slot WAL retention and alert on retained WAL,
inactive slots, subscription errors, and lag. An interrupted setup can retain
WAL indefinitely; drop the subscription/slot deliberately before retrying.

If an existing subscription is missing a table, the helper and audit fail
closed. Either restart the rehearsal, or, while the target remains disposable
and application-read-only, run:

```sql
ALTER SUBSCRIPTION boardsesh_pg18_sub
  REFRESH PUBLICATION WITH (copy_data = true);
```

Wait for every refreshed relation to reach `srsubstate = 'r'`, then rerun the
full audit. Never treat a zero count of non-ready rows as sufficient without an
exact source-manifest-to-`pg_subscription_rel` comparison.

The post-setup audit must use the real publisher credential and exact
subscription identities:

```bash
SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
SOURCE_REPLICATION_DATABASE_URL="$SOURCE_REPLICATION_DATABASE_URL" \
TARGET_DATABASE_URL="$TARGET_DATABASE_URL" \
REQUIRE_PUBLICATION=true \
MIGRATION_PUBLICATION_NAME=boardsesh_pg18_migration \
MIGRATION_SUBSCRIPTION_NAME=boardsesh_pg18_sub \
MIGRATION_SLOT_NAME=boardsesh_pg18_sub \
MIGRATION_OWNER_ROLE=boardsesh_owner \
MIGRATION_RUNTIME_ROLE=boardsesh_runtime \
MIGRATION_MIGRATOR_ROLE=boardsesh_migrator \
MIGRATION_REPLICATION_ROLE=boardsesh_standby \
MIGRATION_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
  scripts/postgres-migration-audit.sh
```

Re-run the source/target catalog audit with `REQUIRE_PUBLICATION=true`. Keep the
candidate read-only to applications and shadow it for at least 72 hours. During
the shadow period verify:

- every `pg_subscription_rel` row is ready;
- lag and retained WAL stay within the agreed limits;
- the DDL fingerprint and Drizzle ledger do not move;
- representative read queries and PostGIS operations match; and
- backup/restore of PG18 succeeds independently.

## Cutover fence

Schedule a write outage. Enumerate and stop every writer, including:

- web/API deployments and the WebSocket backend;
- Aurora/Kilter/MoonBoard sync daemons;
- cron jobs, offline snapshot exporters, queue workers, and one-shot scripts;
- migration/deploy jobs; and
- operator/admin sessions capable of DML.

For every runtime, sync, and migrator role on PG16:

1. `ALTER ROLE ... NOLOGIN` (or revoke CONNECT as an additional control).
2. Terminate its existing sessions.
3. Query `pg_stat_activity` and prove no listed writer session remains.
4. Attempt a connection/write with each retired credential and record the
   expected failure.

Do not proceed if the old Railway primary cannot be fenced.

The guarded sequence command independently requires the explicit role list,
checks that every role exists and is `NOLOGIN`, checks zero sessions, checks all
subscription tables are ready, captures the source flush LSN, and refuses to
continue until the subscriber has replayed that LSN. It reads each owned
sequence relation directly, preserving `is_called=false`, applies all `setval`
calls in one target transaction, and compares target state again.

```bash
WRITES_FENCED=true \
FENCED_WRITER_ROLES='boardsesh_runtime boardsesh_sync boardsesh_migrator' \
SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
TARGET_DATABASE_URL="$TARGET_DATABASE_URL" \
PUBLICATION_NAME=boardsesh_pg18_migration \
SUBSCRIPTION_NAME=boardsesh_pg18_sub \
SLOT_NAME=boardsesh_pg18_sub \
TARGET_OWNER_ROLE=boardsesh_owner \
TARGET_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
INCLUDE_SCHEMAS='public drizzle' \
EXCLUDE_SCHEMAS='neon_auth neon_control_plane' \
  scripts/neon-to-railway-replication.sh sync-sequences
```

With the fence still held, compare every covered table's exact row count and
order-independent row digest:

```bash
WRITES_FENCED=true \
SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
TARGET_DATABASE_URL="$TARGET_DATABASE_URL" \
  scripts/postgres-migration-verify-data.sh
```

The verifier reads standalone tables and top-level partitioned parents, so
every leaf-partition row is covered exactly once.

Re-run the full catalog audit one final time. Refresh and verify every reported
materialized view. Run business invariants for users, ticks, comments, votes,
board catalogs, and sync cursors. Any mismatch aborts before PG18 receives a
write.

## Traffic switch and rollback boundary

1. Keep PG16 fenced.
2. Point one controlled canary at the PG18 **runtime** credential and exercise
   auth, read, and rollback-only write paths.
3. Update web, backend, workers, and sync services to PG18. Verify no deployment
   still contains the PG16 credential.
4. Enable writers on PG18. Record the timestamp of the first committed app write.
5. Monitor DB health (`/health/db`), errors, connections, locks, replication-slot
   retention, query latency, disk, and backup success.

Before step 4, rollback means keep PG18 read-only, repoint traffic to the still
fenced PG16 source, then deliberately re-enable the PG16 writer roles.

After step 4, PostgreSQL 16 is **not** a writable rollback target. Fix forward on
PG18 or restore/reseed another PG18 instance from a verified PG18 backup. Keep
PG16 fenced/read-only for 72 hours only as forensic reference, then decommission
it after a successful PG18 backup and restore drill.

After the PG18 acceptance window, disable and drop the subscription through the
target admin, verify its source slot is gone, then drop the source publication.
Revoke/drop `boardsesh_pg18_subscriber` and revoke the PG16 publisher credential;
neither is a permanent application identity. Keep PG16 fenced throughout. If
dropping the subscription cannot reach the publisher, inspect and remove the
orphaned source slot deliberately so retained WAL cannot fill the source disk.
The helper makes this destructive transition explicit:

```bash
TEARDOWN_CONFIRMED=true \
SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
TARGET_DATABASE_URL="$TARGET_DATABASE_URL" \
  scripts/neon-to-railway-replication.sh teardown
```

## Availability follow-ups after PG18 is stable

Do these sequentially so each change has an isolated failure domain:

1. Only after the 72-hour PG18 acceptance window, PG16 subscription teardown,
   and a successful PG18 restore drill, seed one asynchronous PG18 physical
   standby in the homelab from the exact same database image digest. Cap its
   physical slot and alert on lag/WAL retention. Promotion is manual and requires
   proof the Railway primary is fenced; there is no automatic failover or
   split-brain tolerance.
2. Add daily logical backups to the homelab/Unraid target with retention and
   scheduled restore drills. Add separately pinned WAL-G only after the simpler
   backup path is proven; PostgreSQL `archive_command` must spool locally so
   Unraid/network failures cannot block PostgreSQL or standby replay.
3. Add PgBouncer only if connection metrics justify it, in a separate change.
4. Revisit offline snapshot offload only after implementing and testing the
   primary cutoff/flush-LSN barrier described above.
