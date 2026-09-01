# PostgreSQL 16 collation repair

This runbook removes the glibc collation mismatch from the Boardsesh production
database without hiding the warning or refreshing catalog versions before the
indexes are rebuilt. It is the containment step before PostgreSQL 18 logical
replication.

The target is Railway service **PostGIS - PROD**
(`648faad6-ed14-4c51-8297-94179f8a237b`) in the production environment. The
separate Railway **Postgres** service belongs to OTA and is out of scope.

## Live baseline: 2026-09-01

| Property | Observed value |
| --- | --- |
| PostgreSQL | 16.15, system identifier `7635874554056458274` |
| Database | `railway`, about 12.43 GB |
| Railway size | 8 vCPU, 24 GB memory, 150 GB volume |
| Volume used | about 15.78 GB |
| Image configuration | mutable `postgis/postgis:16-master` |
| Image pulled by current deployment | `postgis/postgis@sha256:afaf08e1937d753762cfdb943c69ed46296bf50faa80c5f89494e2d0d12980de` |
| Database collation | libc `en_US.utf8`, recorded 2.31, actual 2.41 |
| User indexes | 418, 7.66 GB total, largest 1,342,955,520 bytes |
| Index blockers | 0 invalid, 0 exclusion, 0 partitioned |
| Named collation drift | 786 libc entries; 0 dependent objects |
| PostGIS catalog | extension `3.7.0dev`; runtime reports older SQL procedures that need upgrade |
| Logical replication | no publications, subscriptions, or slots |
| Railway recovery | PITR unavailable for this custom image; standalone service |

The 24 GB resize provides enough headroom. CPU has remained well below the 8
vCPU limit; memory peaked around 18.7 GB before the resize. A read replica does
not reduce connection count and is not part of this repair.

The connection load is volatile: read-only samples during the audit ranged from
101 to 144 client connections against `max_connections=200`. Land the PgBouncer
and restricted-role work first, then require a quiet 24-hour soak before the
first index rebuild.

## Safety model

Use [`scripts/postgres16-collation-repair.sh`](../scripts/postgres16-collation-repair.sh).
It has seven commands:

1. `audit` records the cluster identity, collation versions, all user-index
   definitions, PostGIS status, and the dependency-free named collations.
2. `status` rechecks that the live cluster still matches the audit.
3. `reindex-next` rebuilds exactly one index with `REINDEX INDEX CONCURRENTLY`.
4. `reindex-system` rebuilds catalog indexes only after all clients are fenced.
5. `amcheck` runs a fenced, single-connection production `pg_amcheck` and binds
   its transcript to the exact cluster, index manifest, and PostGIS runtime.
6. `validate` checks index flags, constraints, the full manifest, the production
   `pg_amcheck` evidence, both Boardsesh geography columns, and representative
   plans through both partial GiST indexes.
7. `refresh` transactionally refreshes dependency-free named collations, then
   refreshes the database default collation version last.

The state directory is mode 0700 and contains no credentials. Its full index
inventory is SHA-256 bound, including each complete UTF-8 index definition; the
completion journal must cover that exact set. Keep it outside
the repository and back it up with the maintenance evidence. Never reuse state
after an image, server version, system identifier, index definition, named
collation, or PostGIS catalog change. Run `audit` again instead.

Every state command takes an atomic `.operation.lock`; journal and phase-marker
writes are atomic. The tool never guesses that a lock is stale. If an operator
dies, inspect `.operation.lock/owner.tsv`, prove that PID is gone, verify Railway
has no `boardsesh-collation-*` or `boardsesh-production-amcheck` session, and
rename the lock directory into the maintenance evidence before retrying. Do not
delete it without preserving that record.

The tool deliberately does not:

- delete `_ccnew` or `_ccold` artifacts after a failed concurrent build;
- drop PostGIS extensions or schemas;
- refresh a version while PostGIS reports that its SQL procedures need upgrade;
- run more than one index build per fresh Railway resource sample;
- start while logical replication objects exist.

The audit and every later state-bound command recount publications,
subscriptions, and replication slots. Any nonzero total stops the repair, even
if the object appeared after the final user-index rebuild.

Every command also requires the pre-known production system identifier
`7635874554056458274`. This makes a URL for the separate OTA `Postgres` service
fail before an audit state can be created; the tool never discovers and then
trusts its own write target.

PostgreSQL warns because changed collation definitions can invalidate stored
index ordering. `ALTER DATABASE ... REFRESH COLLATION VERSION` only records the
new version; it does not prove that anything was rebuilt. PostgreSQL's own
guidance is to rebuild affected objects first, for example with `REINDEX`, and
refresh only afterward. See the PostgreSQL 16 documentation for
[`ALTER COLLATION`](https://www.postgresql.org/docs/16/sql-altercollation.html),
[`ALTER DATABASE`](https://www.postgresql.org/docs/16/sql-alterdatabase.html),
and [`REINDEX`](https://www.postgresql.org/docs/16/sql-reindex.html).

## Phase 0: contain connections

Do not begin an index rebuild until all of these are true for 24 hours:

- the application uses the PgBouncer transaction-pool endpoint;
- PgBouncer connects upstream as `boardsesh_runtime`, never `postgres`;
- Vercel has no `DATABASE_DIRECT_URL`;
- migrations use the private direct path as `boardsesh_migrator`;
- the final hour has no PostgreSQL `53300` / `too many clients` log entry;
- ordinary client connections stay below 60% of available non-reserved slots;
- no transaction exceeds five minutes and no idle transaction exceeds one minute.

Retain a timestamped evidence bundle containing the pooler probe, deployed role
grants, Vercel variable-name inventory (never values), 24 hours of connection
samples, and the final hour of PostgreSQL error counts. Record its SHA-256. The
final audit stores that digest and every mutating command requires the same
digest, so a momentarily quiet sample cannot substitute for containment.

Keep `READ_REPLICA_URL` unset. Reassess a Railway read replica after seven full
days on PostgreSQL 18 and PgBouncer. Add one only if read traffic, not connection
fan-out, keeps 15-minute CPU above 60% or measured read latency misses its SLO.

## Phase 1: pin PostgreSQL 16

The service still tracks `postgis/postgis:16-master`. Pin its image source to:

```text
postgis/postgis@sha256:afaf08e1937d753762cfdb943c69ed46296bf50faa80c5f89494e2d0d12980de
```

Disable automatic image updates. Stage both changes together. Before accepting
the deployment, confirm there is no production migration job running, capture a
portable backup as described below, and announce the short database restart.
After deployment, verify all of the following before setting
`SOURCE_IMAGE_PIN_CONFIRMED=true`:

- Railway configuration shows the digest, not `16-master`;
- the deployment succeeded and the volume is still mounted at
  `/var/lib/postgresql/data`;
- `server_version_num` is still in the 16.x range;
- the system identifier is still `7635874554056458274`;
- `/health/db` succeeds and connection errors do not increase.

The digest proves which current image is being held still. It is not the
PostgreSQL 18 target and it does not make the existing development PostGIS build
suitable for long-term use.

## Phase 2: portable backup and restored clone

Railway PITR is unavailable for this custom image, so a successful `pg_dump`
command is not enough. The gate is a successful restore and verification.

1. Take an encrypted custom-format dump with the exact PostgreSQL 16 client.
2. Capture globals with `pg_dumpall --globals-only` and record SHA-256 checksums.
3. Restore into a disposable clone using the exact pinned PostgreSQL 16 image.
4. Install `amcheck`, then run the migration audit, application
   read probes, geography checks, and PostgreSQL 16
   `pg_amcheck --no-password --jobs=1 --parent-check --heapallindexed` on the clone.
5. Record the dump checksum, restored cluster identity, command transcripts,
   table counts, and completion time.

Only after that evidence exists may the operator set:

```text
BACKUP_RESTORE_VERIFIED=true
RESTORED_CLONE_AMCHECK_VERIFIED=true
```

These are explicit attestations. The script cannot infer them from the presence
of a dump file.

Install `amcheck` on the source during the same reviewed, write-fenced
preparation window, then take a new audit:

```sql
CREATE EXTENSION IF NOT EXISTS amcheck;
```

The audit binds its version and installation schema. Do not use `pg_amcheck
--install-missing` during the final verification: installing an extension after
the system-catalog reindex would invalidate the proof ordering.

## Phase 3: repair the PostGIS catalog first

`postgis_full_version()` currently reports that the loaded PostGIS library and
installed SQL procedures are out of sync. The collation tool records this as a
hard blocker.

On the restored clone, run the PostGIS 3.x soft-upgrade path:

```sql
SELECT public.postgis_extensions_upgrade();
SELECT public.postgis_full_version();
```

PostGIS documents that function as the supported extension upgrade path for
PostGIS 3.x. It packages and updates the installed PostGIS extensions, then
`postgis_full_version()` reports whether library and SQL objects agree. See the
[PostGIS upgrade documentation](https://postgis.net/docs/postgis_administration.html)
and [`PostGIS_Extensions_Upgrade`](https://postgis.net/docs/PostGIS_Extensions_Upgrade.html).

Do not run it on production until the restored clone proves:

- the call completes on the exact pinned image;
- `postgis_full_version()` no longer contains `need upgrade`;
- `gyms.location` and `user_boards.location` remain
  `geography(Point,4326)`;
- all non-null values remain valid Point/4326 geographies;
- both partial GiST indexes are valid and used by representative queries;
- the application smoke tests pass.

Then run the same bounded operation on the source in a write-fenced maintenance
window and take a fresh collation `audit`. Do not carry a pre-upgrade manifest
forward.

### Optional tiger/topology removal

Production has no application geography in the tiger or topology schemas, but
the tiger schema is not literally empty. It contains extension-owned lookup and
loader defaults. The application-like tiger datasets, `tiger.geocode_settings`,
`topology.layer`, and `topology.topology` are empty.

The user approved dropping `postgis_tiger_geocoder` and `postgis_topology` only
after the backup/restore drill and a dependency audit prove there is no
application-owned data or dependency. The execution gate is:

- restored clone contains all application data and passes spatial probes;
- every row in the remaining tiger tables is reproduced by a fresh extension
  install and is therefore extension-owned default data;
- `pg_depend` shows no object outside those extensions depending on them;
- `pg_dump --schema-only` confirms no application object names either schema;
- the drop succeeds on the clone without `CASCADE` and all tests still pass.

Never use `DROP ... CASCADE` here. If any gate fails, keep both extensions and
carry them through the PostgreSQL 18 rehearsal.

## Phase 4: capture the production repair state

Use a direct connection, not PgBouncer. Keep the database URL in an injected
environment variable; the script converts it to a mode-0600 libpq passfile and
does not put it in child process arguments.

```bash
export ADMIN_DATABASE_URL="$DATABASE_DIRECT_URL"
export EXPECTED_SYSTEM_IDENTIFIER='7635874554056458274'
export SOURCE_IMAGE_REFERENCE='postgis/postgis@sha256:afaf08e1937d753762cfdb943c69ed46296bf50faa80c5f89494e2d0d12980de'
export SOURCE_IMAGE_PIN_CONFIRMED=true
export CONNECTION_CONTAINMENT_VERIFIED=true
export CONNECTION_CONTAINMENT_EVIDENCE_SHA256='SHA-256 of the retained evidence bundle'
scripts/postgres16-collation-repair.sh audit /secure/operator/path/collation-repair
```

Store the three printed acknowledgements in the maintenance record. Do not put
them in Vercel or Railway application variables. They are not secrets, but they
bind a command to one system identifier, version transition, and index manifest.

The expected clean audit has:

- 418 user indexes unless a reviewed application migration changed the schema;
- no invalid, exclusion, partitioned, or concurrent-artifact index;
- zero dependencies on the 786 mismatched named collations;
- `postgis_catalog_needs_upgrade=false`;
- the full PostGIS runtime fingerprint and retained topology/tiger versions;
- the installed `amcheck` extension version and schema;
- the connection-containment evidence SHA-256;
- the exact immutable image pin marked confirmed.

Any difference stops the run and requires review plus a new plan.

## Phase 5: rebuild user indexes one at a time

Immediately before every invocation, pull fresh Railway metrics and convert CPU
usage to a percentage of the 8-vCPU limit. Supply the sample time and byte values:

```bash
export COLLATION_REPAIR_ACK='value printed by audit'
export EXPECTED_SYSTEM_IDENTIFIER='value printed by audit'
export BACKUP_RESTORE_VERIFIED=true
export RESTORED_CLONE_AMCHECK_VERIFIED=true
export CONNECTION_CONTAINMENT_EVIDENCE_SHA256='same SHA-256 stored by audit'
export RESOURCE_SAMPLE_EPOCH="$(date +%s)"
export RESOURCE_CPU_PERCENT_15M='15-minute percentage'
export RESOURCE_MEMORY_BYTES='current bytes'
export RESOURCE_MEMORY_LIMIT_BYTES='24000000000'
export RESOURCE_DISK_FREE_BYTES='capacity minus used bytes'
export RESOURCE_DISK_CAPACITY_BYTES='150000000000'
scripts/postgres16-collation-repair.sh reindex-next /secure/operator/path/collation-repair
```

The command handles one index, validates its definition afterward, and appends
its stable qualified name to the completion journal. Re-running it resumes at
the next unfinished index. Immediately before the disk gate it reads the next
index's current `pg_relation_size`; the older audit size is informational only.
Each rebuild pins `maintenance_work_mem=1GB` and
`max_parallel_maintenance_workers=0`, so there is one build worker and a bounded
maintenance-memory envelope.

Start gates enforced by the script:

- 15-minute CPU below 50%;
- memory below 70% with at least 6 GiB free;
- ordinary connections below 60% with at least 20 free slots;
- no transaction older than five minutes;
- no idle transaction older than one minute;
- no replication object;
- free disk at least three times the next index size plus 5 GiB;
- projected disk use below 75%.

With the current 1.343 GB largest index, the hard free-disk minimum is about
9.4 GB; the volume currently has far more headroom.

Monitor Railway metrics, `pg_stat_progress_create_index`, `/health/db`, request
latency, and PostgreSQL logs during each build. Stop scheduling the next index if:

- CPU exceeds 70% for ten minutes;
- memory exceeds 85%;
- connections exceed 70%;
- database latency doubles for five minutes;
- free disk falls below 15% or 5 GB.

Cancel the active backend only for free disk below 10%, a database health
failure, or renewed `53300` errors. A cancelled concurrent build may leave an
invalid `_ccnew` or `_ccold` index. The tool then stops and names the blocker; it
never drops that object automatically.

## Phase 6: fenced system reindex and version refresh

After `status` reports every user index complete:

1. Pause PgBouncer.
2. revoke or disable all direct application credentials;
3. wait for every application client backend to drain;
4. fence writes and capture a final backup marker;
5. set the audit's maintenance acknowledgement;
6. rebuild system indexes.
7. run the production integrity scan without lifting the fence.

```bash
export ADMIN_DATABASE_URL="$DATABASE_DIRECT_URL"
export EXPECTED_SYSTEM_IDENTIFIER='7635874554056458274'
export COLLATION_REPAIR_ACK='value printed by audit'
export BACKUP_RESTORE_VERIFIED=true
export RESTORED_CLONE_AMCHECK_VERIFIED=true
export CONNECTION_CONTAINMENT_EVIDENCE_SHA256='same SHA-256 stored by audit'
export WRITES_FENCED=true
export CLIENTS_FENCED=true
export MAINTENANCE_WINDOW_ACK='value printed by audit'
scripts/postgres16-collation-repair.sh reindex-system /secure/operator/path/collation-repair
scripts/postgres16-collation-repair.sh amcheck /secure/operator/path/collation-repair
scripts/postgres16-collation-repair.sh validate /secure/operator/path/collation-repair
```

These common audit, backup, clone, target, and containment variables remain
required for `reindex-system`, `amcheck`, `validate`, and `refresh`; a fresh
maintenance shell must export the complete block above.

`REINDEX SYSTEM` cannot run concurrently. The tool adds PostgreSQL's `-P` safety
option and refuses to start while any other client backend is connected anywhere
in the cluster, including the `postgres` and template databases. The `amcheck`
command requires a PostgreSQL 16 client and runs one job with `--parent-check`
and `--heapallindexed`, with `maintenance_work_mem=1GB`. It rechecks live identity and the empty cluster-wide
client fence before and after exit 0, then stores a mode-0600 transcript and a
SHA-256-bound evidence marker. `validate` cannot print a refresh acknowledgement
without that marker. A nonzero integrity result retains a mode-0600
`production-amcheck.failed.*.log` beside the state and never writes the success
marker.

`validate` prints the final refresh acknowledgement. Supply it without lifting
the fence:

```bash
export COLLATION_REFRESH_ACK='value printed by validate'
scripts/postgres16-collation-repair.sh refresh /secure/operator/path/collation-repair
```

The refresh command writes state-bound `started` markers before either catalog
mutation, performs the 786 dependency-free named collation updates in one
transaction, then refreshes the database default version as the final mutation.
If either transaction commits but the client disconnects before its local
completion marker is written, the next invocation recognizes only the exact
started transition, reconciles recorded and actual versions, and resumes. A
matching live version without the started marker still fails as an out-of-band
change.

Lift the client fence only after:

- `status` reports user indexes, system indexes, production `pg_amcheck`, and
  refresh complete;
- `postgis_full_version()` is clean;
- every index is valid, ready, and live;
- `/health/db`, login, climb search, gym search, tick logging, and queue flows pass;
- new PostGIS logs no longer contain a collation mismatch;
- no new `53300`, authentication timeout, or failed migration appears.

## Relationship to PostgreSQL 18

Finish this repair before creating the PostgreSQL 18 publication or slot. Then
take a new portable dump and use the clean PostgreSQL 16 cluster as the source
for the PostgreSQL 18.6/PostGIS 3.6.4 rehearsal. The PostgreSQL 18 target must
repeat its own collation and spatial validation; a clean source does not prove a
different libc/PostGIS image is clean.

The logical-replication cutover remains a separate change with its own write
freeze, rollback fence, 72-hour PG16 hold, and homelab standby work. This runbook
does not expose PostgreSQL 18 publicly and does not create a Railway read replica.
