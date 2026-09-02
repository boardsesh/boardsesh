# PostgreSQL 16 to 18.6 Migration and Availability Runbook

This is the proposed one-way Railway PostgreSQL upgrade procedure and PG18
artifact contract. The producer PR does not activate PG18 in Compose, existing
CI consumers, development setup, or production deploys. Those changes belong
to the digest-pinning consumer PR.

## Decision and boundaries

- Upgrade directly from PostgreSQL 16 to PostgreSQL 18.6. PostgreSQL 17 is not
  an intermediate step.
- Build a new Railway PostgreSQL 18.6 candidate on a fresh volume and use
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

- PostgreSQL `18.6`
- official base `postgres:18.6-bookworm` at
  `sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af`
- PGDG PostGIS `3.6.4+dfsg-2.pgdg12+1`
- PGDG HypoPG `1.4.3-1.pgdg12+1`

`.github/workflows/dev-db-docker.yml` builds both architectures of the portable
PostGIS image and boots the native and ARM64 candidates without logging in to a
registry. The same read-only workflow builds and boots the final seeded dev
image on a fresh volume, validates seed rows and the Drizzle ledger, restarts
the same volume, and validates it again. Publication and attestation belong only
to the protected-main publisher described below.

The portable image has two independent boot gates: the native runner exercises
the full catalog/logical-replication rehearsal, and QEMU boots the actual
`linux/arm64` image, verifies the container is `aarch64`, initializes a fresh
PG18 parent volume, and asserts the exact PostgreSQL 18.6, PostGIS 3.6.4,
HypoPG 1.4.3, base-image digest, checksum, and PGDATA contracts. A manifest-only
ARM build is not enough.

The seeded developer image is still published `linux/amd64` only, but no longer
because it cannot be built for ARM. pgloader was the blocker — it needs TCP
during the image build and cannot complete under GitHub's ARM emulation — and
the image no longer runs it: the board catalogue now comes from the published
snapshots (issue #4508).

What is still missing is a runner. The build loads ~900k climbs and derives
~10M hold rows, which is CPU-bound work that QEMU makes impractical. The
repository is public, so GitHub's free `ubuntu-24.04-arm` runners are available;
what an ARM64 seeded image needs is for `postgres-image-publisher.yml` to build
on one and combine the two single-platform OCI layouts into a manifest list
before `oras cp`. Until that exists, Apple Silicon development uses Rosetta or a
native local build.

The seeded image is not a production database artifact. Do not roll the
_portable_ image onto ARM hardware unless the ARM boot gate passed for the exact
workflow revision and the published manifest contains both `linux/amd64` and
`linux/arm64`.

Record the resulting **Boardsesh image digest**, not just a tag. Railway and the
homelab must use that same digest. Before either is started, verify its OCI
labels, `postgres --version`, and installed PostGIS version. A tag such as
`latest` or `pg18` is a discovery aid, not a production pin.

### Two-step image rollout

An image cannot pin its own not-yet-known digest. Bootstrap publishing, produce
the candidate, and consume it in separate merges:

1. Merge the minimal trusted publisher workflow to protected `main` in a
   prerequisite PR. Feature-branch workflow code remains read-only.
2. Merge producer commit A, containing only PG18 image inputs, builders,
   rehearsals, and read-only validation, to `main`. Treat that merge result as
   frozen image input.
3. Dispatch the trusted `Publish Current Main PostgreSQL Images` workflow from
   `main`, passing the full 40-character current `main` SHA as
   `expected_main_sha`. It rejects tags, non-default branches,
   stale SHAs, and any checked-out SHA mismatch before registry login. It
   publishes only the `sha-<full-sha>` tag, boots
   both published digests, verifies
   `org.opencontainers.image.revision` and `org.opencontainers.image.source`,
   and emits the portable and seeded digests in both the job summary and the
   downloadable `postgres-image-digests-<sha>/postgres-image-digests.json`
   artifact. Do not change any
   image input after that run; a change requires a new A and a new publication.
4. Consumer commit B may change only consumer pins, activation contracts, and
   documentation. Pin
   A's portable digest in `.github/workflows/ci.yml`; pin A's seeded digest in
   the existing seeded CI fixture there and in both seeded-image references in
   `.github/workflows/e2e-tests.yml`; and replace the seeded mutable reference in
   `.github/workflows/db-migration-renumber.yml`. Pin root `docker-compose.yml`
   as well unless a deliberately local override is required. Introduce the
   mutable-tag/retired-digest consumer guard in B, after both digests are known.
   B must not touch an image-input path or trigger another image publication.
   Run the full CI suite against these exact digests before creating a Railway
   candidate.

The migration publisher does not update mutable discovery tags such as `latest`
or `pg18`; neither is an accepted CI, migration, Railway, or homelab pin. The
source-A workflow validation and tests are independent of B's as-yet-unknown
consumer digests, so A cannot deadlock on its own publication result.

`packages/db/docker/Dockerfile` remains a locally built Compose setup helper.
Read-only CI builds it for amd64 and arm64, but no repository consumer pulls a
`boardsesh-db-setup` registry image, so it is not published or recorded in the
digest manifest.

Producer A deliberately leaves root/web/backend Compose, the current PG17 dev
setup, and existing CI consumers unchanged. Consumer B switches them to the
immutable seeded/portable digests and the PG18 parent-volume contract together;
there is no interval where PG17 initializes a PG18-mounted volume.

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

### 1. Prove the target provides every PostGIS capability the source uses

The target artifact is PostGIS 3.6.4. Production reports `3.7.0dev`, because the
Railway service tracks the mutable `postgis/postgis:16-master` tag.

This gate used to require the two recorded versions to be equal. That could not
be satisfied and could not be waived. PGDG publishes no stable 3.7 for
PostgreSQL 18, so the target cannot be raised; PostGIS ships no downgrade script,
and rewriting `pg_extension.extversion` by hand only relabels the library that
is actually loaded, so the source cannot be lowered either. Neither side could be
moved to meet the other, which left a gate with no supported way through and an
override that would have been pure judgement.

The decision needs a narrower question, and `docs/postgres-18-postgis-rehearsal.md`
answers it: does everything this application does with PostGIS survive the step
from 3.7.0dev to 3.6.4? That rehearsal boots the image production runs beside
one built from the pinned artifact inputs, copies the application's spatial
surface across with the cutover helper's own dump flags and filter, and matched
21 of 21 checks, including a byte comparison of `ST_AsEWKB` over every populated
geography, both partial GiST index definitions, index selection, geodesic
`ST_Distance`/`ST_DWithin`, and the lat/lng trigger recomputing an identical
geography under 3.6.4.

So the standing rule is a capability comparison, not a version comparison. The
audit enumerates what the source actually uses and requires the target to
provide each item:

- every column whose type is, or is built over, a `postgis` type;
- every operator class an in-scope index selected that belongs to `postgis`;
- every `postgis` operator an in-scope catalog object references — `&&` and
  `<->` are how a GiST index is actually driven, and an operator carries no
  function dependency of its own; and
- every PostGIS routine the source references, from catalog dependencies **and**
  from a textual scan of routine bodies.

That last half is load-bearing. Migration `0127_backfill_gym_location_trigger.sql`
puts `ST_MakePoint(...)::geography` inside a plpgsql body, which PostgreSQL
stores as opaque text with no dependency edge; an old-style string-bodied SQL
function is stored the same way. (PostgreSQL 14's `BEGIN ATOMIC` bodies are the
exception — those are parsed at definition time and do record edges, so the
catalog half already covers them.) A check built on `pg_depend` alone reports
that this database uses no PostGIS functions at all.

The column rule needs one more sentence, because the obvious version of it
deadlocks. A column can reach a `postgis` type through a domain, an array, or
both. Reporting the column's own type name would name a **user** type, and the
replication helper runs this same manifest _before_ the schema restore — so one
`CREATE DOMAIN ... AS geography` migration would ask a pre-restore target for a
type only that restore could create, with no way out. The manifest therefore
resolves every such column down to the `postgis` type underneath and reports
that, carrying the typmod the column or the innermost domain pins. The user
domain is not going unchecked: the post-restore catalog DDL manifest already
compares it byte for byte.

State the limits plainly. The body scan matches `st_*` / `postgis_*` names
followed by an open paren. It does not see dynamic SQL, or anything the
application does outside the database. It cannot resolve overloads, so the
target is checked for the name, not the signature. Operators and
non-`st_*`-named functions are invisible to it _as body text_, though both are
covered by the operator and function dimensions wherever the catalog records
them — a view, an index expression or predicate, a constraint, a default. A name
it cannot resolve to any routine is a blocker rather than an assumption. A name
that resolves to a PostGIS routine stays in the manifest even when a user
routine shares it, which is not pedantry: `postgis_topology` ships its own
`st_srid`, `st_simplify` and `st_geometrytype`, and the source still has that
extension installed. Any new spatial usage that appears later lands in the
manifest and has to be satisfied the same way.

Where the rule is enforced, and what still compares versions exactly:

| Where                                                     | What it decides                                                                            | Knob                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------- |
| `scripts/postgres-migration-audit.sh:1845`                | source capability manifest; blocks on any spatial reference it cannot classify             | none                       |
| `scripts/postgres-migration-audit.sh:2135`                | target `pg_extension.extversion` **must equal** `EXPECTED_POSTGIS_VERSION`                 | `EXPECTED_POSTGIS_VERSION` |
| `scripts/postgres-migration-audit.sh:2142`                | every source capability must exist on the target                                           | none                       |
| `scripts/postgres-migration-audit.sh:2043`                | whole-extension manifest, source vs target, version included for every extension but one   | none                       |
| `scripts/postgres-logical-replication.sh:1443`            | target `pg_extension.extversion` **must equal** `EXPECTED_POSTGIS_VERSION`, as a hard fail | `EXPECTED_POSTGIS_VERSION` |
| `scripts/postgres-logical-replication.sh:1426` and `:1504` | the same manifest and the same capability comparison, as a hard fail before any restore   | none                       |

The target keeps exact version equality on purpose, on **both** scripts. The
source is a database we inherited, running whatever its mutable tag last built;
the target is an artifact we produce, attest, digest-pin, and boot on both
architectures before anything points at it. A candidate reporting anything but
the pinned version is not the image the rest of this rollout validated, and
relaxing that side would leave the capability comparison proving capabilities
against an unknown build. Note why the replication helper carries its own copy:
the extension manifest used to compare `postgis` exactly and pinned the target
as a side effect, so making that row version-tolerant would otherwise have left
`setup` with no PostGIS version check at all — and `setup` is the script that
writes.

`BOARDSESH_VERSION_TOLERANT_EXTENSIONS` in
`scripts/lib/postgres-spatial-capability.sh:48` is the whole of the tolerance:
`postgis`, and nothing else. It is a shell constant, not an environment
variable, so widening it is a code change and needs a rehearsal behind it.
`EXPECTED_POSTGIS_VERSION` (`postgres-migration-audit.sh:16`, documented at
`:87`) now only names the version the **target** must report; it is for wiring
the expected version through from the image label, and it moves nothing else.

The audit and the replication helper share one implementation
(`scripts/lib/postgres-spatial-capability.sh`) because two copies of this
comparison would let the audit pass while `setup` aborted, sending an operator
hunting for a difference between two scripts instead of between two databases.
`scripts/postgres18-image-smoke.sh` exercises both directions against the real
image: a geography fixture with two partial GiST indexes, a domain-typed
geography column, an expression index, an `&&` index predicate, a user routine
deliberately named `st_makepoint`, and the plpgsql trigger; an `ST_AsEWKB`
comparison across the logical copy; and negative cases for every capability kind
and for the target version, each of which must abort `setup` before the restore
and block the audit.

`scripts/postgres18-spatial-surface.test.sh` is what keeps the rehearsal record
honest as the repository changes: it fails when the application's `ST_*` surface
or its set of geography tables grows past what the rehearsal exercised.

Section 4's full rehearsal is still required, and still has to restore the
schema, copy every geography/geometry value, exercise spatial indexes and
queries, and compare representative `ST_AsEWKB` values.

Note also that `postgis_tiger_geocoder` and `postgis_topology` cannot simply be
left off the target. Their `tiger`, `tiger_data` and `topology` schemas are in
the default `MIGRATION_EXCLUDED_SCHEMAS` (`postgres-migration-audit.sh:26`) so
schema classification does not block first, but the extension manifest at
`:2043` is cluster-wide and has no allowlist, so a source extension with no
target counterpart blocks regardless of how few objects it owns. Dropping them
on the source, where they hold 0 live tuples, is the only path that satisfies
`unclassified_schemas()`, the manifest, and
`assert_superuser_catalog_precreated` unchanged.

### 2. Publish and pin the PG18 image

Feature-branch workflows are read-only and cannot log in to GHCR, write
packages, attest, or request OIDC. First merge the minimal
`.github/workflows/postgres-image-publisher.yml` publisher definition to protected
`main` in a prerequisite PR. Merge producer A to `main`, then dispatch that
trusted workflow with the exact current `main` lowercase 40-character SHA. The
publisher rejects tags, non-default branches, stale SHAs, and mismatched
checkouts, and binds every checkout and OCI
revision label to that SHA before registry login, emits a downloadable digest
manifest, and smoke-tests the exact portable digest on fresh amd64 and arm64
runners. It publishes only immutable `sha-<full-sha>` tags.

Treat the image-input commit as frozen commit A. After publication, commit B may
only pin the emitted portable/seeded digests in consumers, contracts, and docs;
any Dockerfile, migration, setup, seed, or smoke input change requires a new A
publication. Verify the same portable digest is configured for the Railway
candidate and future homelab standby. Do not add WAL-G to this image. WAL-G uses
a separately pinned sidecar/credential boundary in the later backup stage.

### 3. Source-only catalog audit

Inject database URLs through the secret manager. Do not paste them into the
runbook, shell history, CI logs, or a world-readable environment file.

```bash
set +x
SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
EXPECTED_SOURCE_DATABASE=railway \
  scripts/postgres-migration-audit.sh
```

The audit is read-only and fails closed. It checks:

- source major version, `wal_level`, and replication-slot capacity;
- every non-system schema belongs to an explicit included or excluded policy,
  including empty schemas and extension-member schemas that also contain user
  objects;
- an explicit table publication manifest (never `FOR ALL TABLES`);
- replica identity for update/delete replication;
- owned and unowned sequences;
- prepared transactions, large objects, and materialized views;
- extensions, compared exactly except for the PostGIS version, which §1's
  spatial capability manifest decides instead; a source-only run prints that
  manifest and blocks on anything in it the audit cannot classify, but cannot
  prove the target satisfies it without `TARGET_DATABASE_URL`;
- roles, object/function/type/schema owners, explicit/default grants,
  SECURITY DEFINER functions, and RLS policies;
- schema definitions, columns, defaults, constraints, indexes,
  relation/partition/view/sequence definitions, functions, triggers, policies,
  complete type/domain/range definitions, operators, operator classes/families,
  collations, casts, extended statistics, rules, and default privileges in a
  DDL fingerprint;
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
  the later homelab physical standby; and
- `boardsesh_snapshot_fence_owner`: `NOLOGIN NOCREATEDB NOCREATEROLE INHERIT`,
  owns only the two snapshot `SECURITY DEFINER` functions, inherits
  `pg_read_all_stats`, and has explicit
  access to the two control-file readers those functions call. It is
  pre-provisioned for the separately gated replica-snapshot migration; neither
  the runtime nor snapshot coordinator may become a member.

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

The production database name is `railway`. The target admin must execute this
shape while connected to that database; do not substitute a different name in
production:

```sql
CREATE ROLE boardsesh_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT
  NOREPLICATION NOBYPASSRLS;
CREATE ROLE boardsesh_runtime
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT
  NOREPLICATION NOBYPASSRLS;
CREATE ROLE boardsesh_migrator
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT
  NOREPLICATION NOBYPASSRLS;
CREATE ROLE boardsesh_pg18_subscriber
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT
  NOREPLICATION NOBYPASSRLS;
CREATE ROLE boardsesh_standby
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT
  REPLICATION NOBYPASSRLS;
CREATE ROLE boardsesh_snapshot_fence_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT
  NOREPLICATION NOBYPASSRLS;

GRANT CREATE ON DATABASE railway TO boardsesh_owner;
GRANT CREATE ON DATABASE railway TO boardsesh_pg18_subscriber;
GRANT pg_create_subscription TO boardsesh_pg18_subscriber
  WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
GRANT boardsesh_owner TO boardsesh_migrator
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
GRANT boardsesh_owner TO boardsesh_pg18_subscriber
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
GRANT pg_read_all_stats TO boardsesh_snapshot_fence_owner
  WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system(),
  pg_catalog.pg_control_checkpoint()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system(),
  pg_catalog.pg_control_checkpoint()
  TO boardsesh_snapshot_fence_owner;
GRANT boardsesh_snapshot_fence_owner TO boardsesh_owner
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
```

Do not create or grant predefined roles inside a Drizzle migration. The target
admin provisions this role contract first. The snapshot migration then grants
the fence owner `USAGE, CREATE` on `ops` (PostgreSQL requires `CREATE` before a
function can be transferred to a new owner) and transfers only
`ops.board_snapshot_cluster_identity()` and
`ops.acquire_board_snapshot_fence(integer)`. The role remains `NOLOGIN`;
`boardsesh_owner` receives SET-only membership solely so the restricted
migration session can make that deterministic ownership transfer. Revoke
`CREATE` from the runtime and snapshot coordinator, and never grant either role
membership in the fence owner.

Producer A does not activate production migration roles. Consumer B may add the
full contract only after the production roles, exact migrator credential,
rollback probes, and secret rotation below are complete:

```text
MIGRATION_OWNER_ROLE=boardsesh_owner
MIGRATION_LOGIN_ROLE=boardsesh_migrator
EXPECTED_MIGRATION_DATABASE=railway
MIGRATION_RUNTIME_ROLE=boardsesh_runtime
MIGRATION_RUNTIME_SCHEMAS=public drizzle
```

While the exact catch-up subscription is active, Consumer B must additionally
set `MIGRATION_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber` and
`MIGRATION_SUBSCRIPTION_NAME=boardsesh_pg18_sub`. The reserved-session guard
then permits precisely that second SET-only incoming owner edge. `teardown`
drops the subscription, the source slot, and the publication, then re-reads all
three and drops `TARGET_SUBSCRIBER_ROLE` once none of them remain. That drop
revokes its memberships, database and schema grants, and any residual object ACL
in one transaction, then verifies the role is gone. It drops the role only when
the role still matches the exact contract `setup` asserted (passwordless,
ownership free, exact LOGIN attributes, exactly the two expected outgoing edges,
no incoming edge, no schema `CREATE` or DML). Anything else keeping that name is
somebody's real role: teardown reports it and refuses, leaving the replication
objects torn down and the role untouched. Fix the drift, then re-run
`teardown`; it is idempotent, and a run where the role is already gone says so
and exits clean. `TARGET_OWNER_ROLE` and `TARGET_SUBSCRIBER_ROLE` are needed only
for the two steps that compare a role name against the catalog — dropping a live
subscription and dropping the temporary subscriber role. An aborted setup that
left the source retaining WAL behind an orphan slot can be cleared from a shell
that has neither: `teardown` drops the slot and publication, then exits non-zero
asking for both names (`docs/neon-migration.md` section 6.2).
Remove both subscriber settings once the role is dropped; the
owner graph reverts to the sole migrator edge. Partial settings and a subscriber allowance
without the full owner contract fail before any migration DDL.

Migration 0200 is post-cutover target work. Do not apply it to the source or
before the generic `--no-acl` schema copy: setup rejects a source-side `ops`
schema because that path cannot reconstruct the fence/coordinator ownership
boundary. After traffic has cut over to PG18, run 0200 through the restricted
owner session. Keep `ops` out of `MIGRATION_RUNTIME_SCHEMAS`; runtime receives no
schema access or EXECUTE grant on its SECURITY DEFINER functions.

### Ordered PG16 production-role transition

Pre-create the exact restricted owner, runtime, and migrator roles on the PG16
Railway database as an administrator. Do not point the production deploy at the
migrator credential yet. Then run these gates in order; all three URLs must name
the canonical `railway` database and are converted to non-argv libpq settings by
the helper.

`prepare-source-acls` and `transfer-ownership` are the two commands that write.
Both run against the live primary, with production still serving traffic, and
both take `ACCESS EXCLUSIVE` on every relation they touch, held until their
single transaction commits. Schedule them in a low-traffic window, and before
each one check for long-running work that would sit in front of them:

```sql
SELECT pid, usename, state, now() - xact_start AS xact_age, left(query, 80)
FROM pg_stat_activity
WHERE datname = current_database()
  AND xact_start IS NOT NULL
  AND pid <> pg_backend_pid()
ORDER BY xact_age DESC;
```

Analytics queries, slow searches, and the snapshot exporter's export transaction
are the usual culprits. Clear them first: an `ACCESS SHARE` holder blocks the
`ALTER`, and every later query on that relation queues behind the `ALTER`.

Both commands enforce this rather than trusting the checklist. Each refuses to
start while any client transaction has been open longer than
`MAX_BLOCKING_TRANSACTION_SECONDS` (default 60), runs its transaction under
`lock_timeout` (`DDL_LOCK_TIMEOUT_MS`, default 3000) and `statement_timeout`
(`DDL_STATEMENT_TIMEOUT_MS`, default 60000), and retries a blocked attempt
up to `DDL_LOCK_ATTEMPTS` times (default 5) with `DDL_LOCK_RETRY_DELAY_SECONDS`
(default 15) between tries. `--single-transaction` plus `ON_ERROR_STOP` means a
timed-out attempt rolls back in full, so a retry never resumes half-applied work
and giving up never leaves ownership or ACLs partially transferred.

Size the window against the total hold, not `lock_timeout`. `lock_timeout` bounds
one lock acquisition; it does not bound how long the transaction keeps what it has
already taken. `transfer-ownership` ALTERs every relation, sequence, view,
function and type in `public` + `drizzle` in a single transaction (92 `pgTable`s
in `packages/db/src/schema` alone, 150+ objects once sequences and views are
counted) and holds `ACCESS EXCLUSIVE` on each one from its `ALTER` until
`COMMIT`. Worst case is roughly objects × `DDL_LOCK_TIMEOUT_MS`: at the defaults
that is 150 × 3s ≈ 7.5 minutes of site-wide exclusive locks, reached by steady
sub-second readers with no single blocker slow enough to trip anything.
`statement_timeout` is per statement and does not bound it,
`MAX_BLOCKING_TRANSACTION_SECONDS` only samples once before the first attempt,
and the PG16 primary these commands run against has no `transaction_timeout`
(PG17 and later only).

`DDL_MAX_LOCK_HOLD_SECONDS` (default 60) is the hard ceiling on that. The script
tags its DDL session inside the transaction and runs a watchdog that
`pg_cancel_backend()`s it once the attempt passes the ceiling. The cancel lands as
a normal statement error, so `ON_ERROR_STOP` + `--single-transaction` roll the
whole transaction back and the attempt is counted and retried exactly like a lock
timeout: ownership is either fully transferred or untouched. On an idle primary
a full transfer finishes in well under a second, so the ceiling only ever fires
when the window was not actually quiet.

When a command gives up it says so and exits non-zero, and the database is
exactly as it was. Do not raise the timeouts or the hold ceiling to force it
through; that reintroduces the unbounded lock queue. Find the blocking sessions in
`pg_stat_activity`/`pg_locks`, stop or wait out that work, and re-run the same
command unchanged.

```bash
set +x
ADMIN_DATABASE_URL="$ADMIN_DATABASE_URL" \
RUNTIME_DATABASE_URL="$CURRENT_RUNTIME_DATABASE_URL" \
  scripts/postgres18-production-role-transition.sh prepare-source-acls

# Rotate the deploy secret outside this script to the dedicated
# boardsesh_migrator LOGIN, then test that exact stored credential.
MIGRATOR_DATABASE_URL="$NEW_MIGRATOR_DATABASE_URL" \
  scripts/postgres18-production-role-transition.sh verify-migrator

RUNTIME_DATABASE_URL="$CURRENT_RUNTIME_DATABASE_URL" \
  scripts/postgres18-production-role-transition.sh probe-runtime
```

`prepare-source-acls` pregrants current objects, removes table/sequence runtime
defaults that could expose either Drizzle ledger, globally removes implicit
PUBLIC routine/type defaults, installs exact runtime routine EXECUTE and type
USAGE defaults in application schemas, and replaces the migrator's memberships with one
non-admin, non-inheriting, SET-only edge to `boardsesh_owner`. The production
migration runner transactionally reconciles each newly created app object after
every deploy while explicitly denying both ledgers. `verify-migrator` proves
the deployed LOGIN identity, role
attributes, direct edge, `SET LOCAL ROLE`, transactional DDL rollback, and
absence of a leftover schema. `probe-runtime` performs zero-row reads through
the real app credential and proves it cannot create a schema.

Next exercise the normal application startup, representative reads, and
representative writes inside an application-controlled rollback transaction.
Record the successful rollback-only probe; do not use a synthetic SQL probe in
place of application code. Only then may the administrator transfer ownership:

```bash
set +x
DEPLOY_CREDENTIAL_ROTATED=true \
ROLLBACK_PROBES_CONFIRMED=true \
ADMIN_DATABASE_URL="$ADMIN_DATABASE_URL" \
MIGRATOR_DATABASE_URL="$NEW_MIGRATOR_DATABASE_URL" \
RUNTIME_DATABASE_URL="$CURRENT_RUNTIME_DATABASE_URL" \
  scripts/postgres18-production-role-transition.sh transfer-ownership
```

The final command reruns both credential probes before changing any owner. It
transfers only explicitly included non-extension schemas, relations, functions,
procedures, and user-defined types. Run the full read-only catalog/role/ACL
audit immediately afterward. The production migration integration fixture uses
a LOGIN with no direct database or schema `CREATE`; direct database `CREATE`
belongs only to the NOLOGIN owner, and a reserved physical session keeps
`SET ROLE`, Drizzle transactions, and ledger writes on that owner until
`RESET ROLE` and release.

PG18 producer image builders use
`packages/db/docker/bootstrap-pg18-development-roles.sql` immediately before
pending migrations. That idempotent PG18-only helper requires explicit
`boardsesh_dev_role_bootstrap=true` and a superuser. Consumer B may reuse it in
PG18 dev setup; producer A does not alter the current PG17 `dev-db-up` path.
Never invoke it against production; production uses the admin-provisioned role
contract above.

On PG16, grant the publisher only the schema/table access in the explicit
publication manifest and set `ALTER ROLE boardsesh_pg16_publisher SET
row_security = off`. The audit performs a zero-row `SELECT` through that exact
credential for every table. A later RLS policy therefore stops the migration
instead of silently copying a filtered subset.

## Build the PG18 candidate

1. Create a new Railway service from the exact attested Boardsesh PG18 image
   digest and a fresh parent volume.
2. Verify `server_version_num = 180006`, `data_checksums = on`, and PostGIS
   `3.6.4`.
3. Install required extensions as the target admin:

   ```sql
   CREATE EXTENSION IF NOT EXISTS postgis;
   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   ```

   HypoPG package availability is image-smoked, but the migration helper only
   creates the HypoPG extension when the source extension manifest contains it;
   an absent-source target must remain absent. Pre-create every additional source extension at its exact audited
   version/schema/relocatability. If the source audit reports custom operator
   families or operator classes, pre-create their exact catalog definitions on
   the target as the admin too. PostgreSQL restricts their creation to
   superusers. The helper compares both admin-owned manifests before restore and
   fails closed on any missing or different row; it filters those already-proven
   entries from the restricted-owner archive restore.

4. Dump source schema without publications/subscriptions, owners, or ACLs.
   Pre-create extensions as the target admin, then remove `EXTENSION` and
   `COMMENT ON EXTENSION` entries from the custom archive restore list. Those
   entries cannot safely run as the application owner. Give the owner `CREATE`
   on the database, pre-create every included application schema (`public` and
   `drizzle`) under that owner, and restore the filtered list while set to that
   role:

   ```bash
   set +x
   PGPASSFILE="$SOURCE_PGPASS_FILE" pg_dump \
     --schema-only --no-owner --no-acl \
     --schema=public --schema=drizzle \
     --no-publications --no-subscriptions --format=custom \
     --file "$SCHEMA_DUMP" --dbname "$SOURCE_PASSWORD_FREE_URI"

   pg_restore --list "$SCHEMA_DUMP" >"$RESTORE_LIST"
   awk '$0 !~ / SCHEMA - / && $0 !~ / EXTENSION - / && $0 !~ / COMMENT - EXTENSION / && $0 !~ / OPERATOR FAMILY / && $0 !~ / OPERATOR CLASS / { print }' \
     "$RESTORE_LIST" >"$FILTERED_RESTORE_LIST"

   PGPASSFILE="$TARGET_PGPASS_FILE" pg_restore \
     --exit-on-error --schema-only --no-owner --no-acl \
     --role "$MIGRATION_OWNER_ROLE" \
     --use-list "$FILTERED_RESTORE_LIST" \
     --dbname "$TARGET_PASSWORD_FREE_URI" "$SCHEMA_DUMP"
   ```

   `scripts/postgres-logical-replication.sh setup` implements this filtering and
   ownership sequence. A restore that reports ignored errors is a failed gate;
   do not record or continue past partially restored DDL.

5. Make the application schemas and every non-extension app relation, routine,
   and user type owned by the NOLOGIN owner. Apply deterministic least-privilege
   grants to runtime. Table/sequence defaults deliberately grant no runtime
   access, because they would expose a future Drizzle ledger. The production
   migration runner transactionally reconciles every current allowlisted app
   object after each migration, excludes both `public` and `drizzle` ledgers,
   and retains only non-PUBLIC runtime routine EXECUTE and type USAGE defaults.
   Revoke broad `PUBLIC`
   schema/routine access first where the app does not need it.
6. Prove the runtime credential can connect and perform representative reads and
   writes in a rollback transaction; prove the migrator can `SET ROLE`; prove
   the replication credential has no application DML grants.

Run a source/target audit with all role names:

```bash
set +x
SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
TARGET_DATABASE_URL="$TARGET_DATABASE_URL" \
EXPECTED_SOURCE_DATABASE=railway \
EXPECTED_TARGET_DATABASE=railway \
MIGRATION_OWNER_ROLE=boardsesh_owner \
MIGRATION_RUNTIME_ROLE=boardsesh_runtime \
MIGRATION_RUNTIME_SCHEMAS='public drizzle' \
MIGRATION_MIGRATOR_ROLE=boardsesh_migrator \
MIGRATION_REPLICATION_ROLE=boardsesh_standby \
MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE=boardsesh_snapshot_fence_owner \
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
set +x
SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
TARGET_DATABASE_URL="$TARGET_DATABASE_URL" \
SOURCE_REPLICATION_DATABASE_URL="$SOURCE_REPLICATION_DATABASE_URL" \
SOURCE_DATABASE_NAME=railway \
TARGET_DATABASE_NAME=railway \
TARGET_OWNER_ROLE=boardsesh_owner \
TARGET_RUNTIME_ROLE=boardsesh_runtime \
TARGET_RUNTIME_SCHEMAS='public drizzle' \
TARGET_MIGRATOR_ROLE=boardsesh_migrator \
TARGET_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
PUBLICATION_NAME=boardsesh_pg18_migration \
SUBSCRIPTION_NAME=boardsesh_pg18_sub \
SLOT_NAME=boardsesh_pg18_migration \
INCLUDE_SCHEMAS='public drizzle' \
EXCLUDE_SCHEMAS='neon_auth neon_control_plane' \
  scripts/postgres-logical-replication.sh setup
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
set +x
SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
SOURCE_REPLICATION_DATABASE_URL="$SOURCE_REPLICATION_DATABASE_URL" \
TARGET_DATABASE_URL="$TARGET_DATABASE_URL" \
EXPECTED_SOURCE_DATABASE=railway \
EXPECTED_TARGET_DATABASE=railway \
REQUIRE_PUBLICATION=true \
MIGRATION_PUBLICATION_NAME=boardsesh_pg18_migration \
MIGRATION_SUBSCRIPTION_NAME=boardsesh_pg18_sub \
MIGRATION_SLOT_NAME=boardsesh_pg18_migration \
MIGRATION_OWNER_ROLE=boardsesh_owner \
MIGRATION_RUNTIME_ROLE=boardsesh_runtime \
MIGRATION_RUNTIME_SCHEMAS='public drizzle' \
MIGRATION_MIGRATOR_ROLE=boardsesh_migrator \
MIGRATION_REPLICATION_ROLE=boardsesh_standby \
MIGRATION_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
MIGRATION_SNAPSHOT_FENCE_OWNER_ROLE=boardsesh_snapshot_fence_owner \
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
set +x
WRITES_FENCED=true \
FENCED_WRITER_ROLES='boardsesh_runtime boardsesh_sync boardsesh_migrator' \
SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
TARGET_DATABASE_URL="$TARGET_DATABASE_URL" \
SOURCE_REPLICATION_DATABASE_URL="$SOURCE_REPLICATION_DATABASE_URL" \
SOURCE_DATABASE_NAME=railway \
TARGET_DATABASE_NAME=railway \
TARGET_OWNER_ROLE=boardsesh_owner \
TARGET_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
PUBLICATION_NAME=boardsesh_pg18_migration \
SUBSCRIPTION_NAME=boardsesh_pg18_sub \
SLOT_NAME=boardsesh_pg18_migration \
INCLUDE_SCHEMAS='public drizzle' \
EXCLUDE_SCHEMAS='neon_auth neon_control_plane' \
  scripts/postgres-logical-replication.sh sync-sequences
```

With the fence still held, compare every covered table's exact row count and
order-independent row digest:

```bash
set +x
WRITES_FENCED=true \
SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
TARGET_DATABASE_URL="$TARGET_DATABASE_URL" \
EXPECTED_SOURCE_DATABASE=railway \
EXPECTED_TARGET_DATABASE=railway \
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
set +x
TEARDOWN_CONFIRMED=true \
NEON_DATABASE_URL="$SOURCE_DATABASE_URL" \
RAILWAY_DATABASE_URL="$TARGET_DATABASE_URL" \
SOURCE_REPLICATION_DATABASE_URL="$SOURCE_REPLICATION_DATABASE_URL" \
TARGET_OWNER_ROLE=boardsesh_owner \
TARGET_SUBSCRIBER_ROLE=boardsesh_pg18_subscriber \
SOURCE_DATABASE_NAME=railway \
TARGET_DATABASE_NAME=railway \
PUBLICATION_NAME=boardsesh_pg18_migration \
SUBSCRIPTION_NAME=boardsesh_pg18_sub \
SLOT_NAME=boardsesh_pg18_migration \
INCLUDE_SCHEMAS='public drizzle' \
EXCLUDE_SCHEMAS='neon_auth neon_control_plane' \
  scripts/postgres-logical-replication.sh teardown
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
