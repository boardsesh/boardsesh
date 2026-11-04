# BA-03 candidate PostgreSQL writer-capability fence

This disposable proof supports [BA-03 #6977](https://github.com/boardsesh/boardsesh/issues/6977)
and [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975). The
[implementation ledger](./better-auth-implementation.md) owns readiness. It
changes no production role, grants, migration, route, credential writer or account
ownership. The [writer inventory](./better-auth-writer-inventory.md) remains the
list of product paths that must eventually adopt one authority.

## Tested capability and transaction boundary

Each case creates a fresh local `boardsesh_ba01_<UUID>` database through the
existing prototype environment and applies its separate generated registry.
The 18 generated tables remain separate from production schema exports. There
is no new table, migration, dependency or runtime adapter in this proof.

Two unique test-owned roles authenticate over separate PostgreSQL connections
using independent random passwords. The old and replacement LOGIN roles are
non-superusers without ownership, memberships, grant options, role/database
creation, replication or bypass-RLS privileges. `NOINHERIT` is explicit. The
fixture removes public table privileges and schema/database creation rights,
then grants only schema usage, connection access, table reads and the old
writer's `INSERT`, `UPDATE`, `DELETE`. The replacement initially cannot write.
Catalog assertions verify those premises; neither application pool authenticates
as an administrator followed by `SET ROLE`.

The trusted local owner transaction locks every generated table in a fixed order
using `ACCESS EXCLUSIVE`, revokes those three write privileges from the old
role, and grants them to the replacement. The privilege changes publish at
transaction commit. Reads are deliberately retained. PostgreSQL documents that
this lock excludes other table access and lasts until the transaction ends.
The fixture observes actual conflicting locks rather than inferring ordering
from a delay. [PostgreSQL 15 LOCK](https://www.postgresql.org/docs/15/sql-lock.html)

Table inserts, updates and deletes use Drizzle. Raw SQL is limited to role,
grant, ownership and lock operations and PostgreSQL catalog observations that
Drizzle cannot express. These are disposable fixture operations, not manually
authored product migrations.

## Prepared and already-running clients

The prepared case first executes the old writer's parameterized insert and
finds its real server-side name in `pg_prepared_statements`. The same backend
PID and prepared entry remain after cutover, when executing that insert fails
with SQLSTATE `42501`. Old updates and deletes also fail, reads still work, and
the replacement inserts, updates and deletes successfully. Effective privileges
are checked across all 18 tables.

An initial assertion exposed a driver distinction: Drizzle's postgres-js
`.prepare()` label still calls `postgres.unsafe()`, whose default disables
server preparation. The fixture uses a narrow, test-only driver proxy to pass
the public `{ prepare: true }` option to those calls. Drizzle continues to build
SQL and bind parameters. No installed library is patched, and no product driver
changes. The server catalog and PID assertions prevent the client label alone
from being mistaken for prepared-statement evidence.

For the drain case, an old transaction writes and holds its row/table locks.
`pg_locks`, `pg_stat_activity` and `pg_blocking_pids` prove the fence is waiting
for `ACCESS EXCLUSIVE`. Another already connected and warmed prepared client
then queues an insert; catalog evidence proves its `RowExclusiveLock` is waiting
behind that fence. Releasing the first transaction lets its earlier write
commit. The fence then commits, and the already queued insert resumes with
`42501`, leaving no row. A timeout, disconnected pool or generic error would
fail this assertion. A separate injected failure proves both privilege changes
roll back together before a subsequent successful cutover.

Exclusive locks also block readers, and existing read transactions can delay
cutover. Multi-table writers with another lock order can deadlock with the
fence. This one-row drain proof does not establish a wait-free transition or
availability for every production transaction; lock deadlines, abort/retry and
a coordinated maintenance procedure still require operational design.

## Bypass assumptions are characterized

PostgreSQL privileges add together across direct grants, memberships and
`PUBLIC`; revoking only a named role is insufficient when another source grants
the same right. The tests deliberately demonstrate both public and inherited
grants restoring the old writer's insertion capability. With inheritance
disabled, membership still allows an explicit `SET ROLE` to the capable group;
removing membership closes that path. A restricted role cannot assume the
replacement role or grant itself missing write rights.
[PostgreSQL 15 REVOKE](https://www.postgresql.org/docs/15/sql-revoke.html)

PostgreSQL 16 and later store inheritance on each membership; a role's
`INHERIT` attribute supplies the default for new grants. Changing the attribute
does not rewrite an existing grant. The test sets the default before granting,
then revokes and regrants after changing it, so both the inherited-write and
explicit `SET ROLE` observations retain their meaning on PostgreSQL 15 and 18.
The CI service uses PostgreSQL 18.6, making this distinction part of validation.
[PostgreSQL 18 role attributes](https://www.postgresql.org/docs/18/sql-createrole.html)

A separate counterexample role intentionally owns one fixture table. Revoking
its ordinary insertion privilege blocks the insert, but the owner can grant
that privilege back to itself. The local superuser can write even after its own
ordinary privilege is revoked. These are explicit unsafe deployment identities,
not capabilities held by the two restricted application roles. PostgreSQL
describes the owner's retained grant options and superuser authority.
[PostgreSQL 15 privileges](https://www.postgresql.org/docs/15/ddl-priv.html)

This proof does not inventory or eliminate production ownership, other grantors,
role memberships, `PUBLIC` or default grants, column grants, `TRUNCATE`, schema
creation, new tables, sequences, views, triggers or `SECURITY DEFINER` routines.
It assumes the table/role set is fixed during cutover. Production policy must
cover every reachable write capability, including alternate schemas and future
objects; this fixture is not that policy or an IAM migration.

## Cleanup, reproduction and evidence limits

Only local URLs accepted by `createPrototypeEnvironment` are used. The test
never reads `DATABASE_URL`. Names contain a fixed fixture prefix and random
hexadecimal UUIDs. Role creation and its initial grants share a transaction;
successful creation is tracked before commit can lose its reply. A lost creation
reply rolls that transaction back, while a lost commit reply leaves a known
owned name for cleanup. `DROP ROLE IF EXISTS` handles tracked creations that
subsequently rolled back, without a name-prefix scan. Generated
passwords and driver errors containing SQL or connection details are not printed.
Connection, statement, lock, ordering and cleanup waits are bounded.

Cleanup releases owned barriers, settles pending operations, closes every owned
application/owner pool, removes its owned database, then drops only its tracked
roles through a bounded local administrator connection. It never uses
`DROP OWNED`, role reassignment or cluster-wide connection termination. Each
cleanup stage continues after an earlier failure, and failures report fixed
stage names. A deliberately unresolved operation triggers a short cleanup
deadline; an independent connection confirms the owned database and both roles
are gone despite that reported timeout.
Two more cases inject a failure before commit and an acknowledgement failure
after a known commit. Catalog observations prove the former role is absent,
the latter exists, and both paths remove their owned resources. These are
deterministic acknowledgement-failure models, not dropped-network-packet tests.

```sh
AUTH_PROTOTYPE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:15475/postgres \
  vp test run --config packages/backend/vite.auth-prototype.config.ts \
  writer-fence.test.ts --reporter=agent
```

Author validation on 2026-11-04 passed **10/10 cases in 2.97 seconds** on local
PostgreSQL 15.17, with clean resource teardown. The source passed selected
`vp check` with no warnings or type errors. Independent review reran all
**10 cases in 3.09 seconds**, with clean teardown and selected checks passing.
Review found the pending-operation cleanup escape and the untracked role-create
acknowledgement window; the staged cleanup and transactional tracking above
address both findings. The reviewer rechecked both fixes and found no remaining
actionable issue within this candidate's scope.

The parent review then checked CI's server version and corrected the membership
setup ordering described above. Independent final runs passed **10/10 on
PostgreSQL 15.17 in 3.73 seconds** and **10/10 on PostgreSQL 18.6 in 3.60 seconds**,
both with clean teardown. The latter matches CI's PostgreSQL server version;
it uses a separate local PostGIS image, not the exact CI image artifact. No test
is skipped or weakened for either version.

Retaining `SELECT` intentionally does not stop an old deployment from verifying
a password or signing a legacy token without a database write. Nor does it
fence Redis-only pairing or control operations, external identity providers,
cached authorization, production readers or existing WebSocket context. Stale
issuers, mixed deployments, job credentials, revocation mutations, ownership
resolution, deployed grants, backup/restore and a safe production rollback remain
separate gates. No test count here establishes one production credential writer
or authorizes first-party cutover or partner launch.
