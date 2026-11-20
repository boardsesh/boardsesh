# BA-03 candidate PostgreSQL writer-capability fence

This page began as a disposable proof and now also holds the BA-04 operator tools. It supports [BA-03 #6977](https://github.com/boardsesh/boardsesh/issues/6977)
and [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975). The
[implementation ledger](better-auth-implementation.md) owns readiness. It
changes no production role, grants, migration, route, credential writer or account
ownership. The [writer inventory](better-auth-writer-inventory.md) remains the
list of product paths that must eventually adopt one authority.

The prototype fence test this page began with (`writer-fence.test.ts`, run through `vite.auth-prototype.config.ts`) was deleted in #7620 with the rest of the BA-01 prototype, and its sections are cut. The live fence is tested by `vp test run --config packages/backend/vite.auth-fence.config.ts` and the lock-order test below.

## BA-04 operator tools (PR 5; inactive)

`auth-authority` defaults to read-only `status`. `prepare` takes the exclusive
(6975, 2) authority gate with the shared 2-second lock deadline, then the real
`users` table lock. Its reservation inserts use batches of 500 rather than two
network round trips per address. The manifest stays `prepared`; preparation is
not a capability fence. Account deletion keeps working while the manifest is
only prepared; it is unavailable only from `activate` until the staged deletion
mode is deployed ([deletion during cutover](better-auth-account-deletion.md#deletion-during-cutover)).

`activate` independently reads effective live catalog permissions on the same
transaction connection, locks `users`, rebuilds reservations from current users,
and only then can advance the phase and writer epoch. Deleted-address digest
reservations survive reconciliation. A prepared snapshot or a previous SQL
plan digest is never accepted as current fence evidence. The initial prepare
manifest reserves epoch 1, which the first enforced transition retains. Later
authority switches raise the epoch; clients must use the reported epoch.

Activation currently **always refuses** while either of these fixed code gates
remains: Garmin must preserve queued offline ticks across refresh rejection, and
web cookies must carry the generation from the authentication proof. No CLI
switch or environment variable can assert those fixes exist. Later reviewed code
must close each gate.

A third gate, `NATIVE_REVOKE_RESET_LOCK_ORDER`, is closed. Native sign-out and a
staged password reset for the same climber take their locks in one order:

- Sign-out (`revokeNativeCredentials`): an unlocked lookup of the refresh row's
  owner, then in one transaction the shared (6975, 2) gate, `users` FOR UPDATE,
  unlocked reads of the refresh row and cutoff, the cutoff upsert, security event
  and native session delete (generation mode only), the presented refresh row,
  every other refresh row of the climber, the native lineage rows (generation
  mode only), then push devices.
- Reset (`consumePasswordRecovery`, final transaction): the shared (6975, 2) gate,
  its command-replay row, `users` FOR UPDATE, the email reservation and its
  members FOR UPDATE, the credential read, the cutoff FOR UPDATE, the recovery
  state and receipt FOR UPDATE, the receipt and state updates, the credential
  update (its partner trigger re-locks `users` FOR NO KEY UPDATE, already held),
  the cutoff advance and security event, then every refresh row of the climber.

Neither takes a row of that climber before its `users` row, so the second to
arrive queues on that row and no cycle can form. The gate is shared by both, so
it never makes one wait for the other.
`native-revoke-reset-lock-order.test.ts` runs both on separate PostgreSQL
connections in both start orders and both revocation modes. The first is parked
before COMMIT holding every lock it took; the second is shown waiting on exactly
that `users` row, and once released both finish: new password set, every refresh
row revoked, the cutoff generation advanced so older web and app credentials are
refused. A control that locks a refresh row before the `users` row gets a real
`40P01` deadlock against the same reset, so the harness can see the failure.

Push-device registration follows the same rule (#7645). It is not a credential
writer and takes no gate, but sign-out retires the climber's push devices last:

- Registration (`saveNotificationDevice`): a 1 s lock timeout, the push
  token's advisory lock, then `users` FOR KEY SHARE in id order for the climber
  and for each climber that owned a touched row when that statement ran, then
  the touched device rows FOR NO KEY UPDATE in installation id order, in the
  statement that retires the other installations, then the upsert of its own
  row, which takes no stronger lock. Touched rows are the live rows holding the
  token (a token can arrive from another climber's account) and the climber's
  own installation. Inactive rows are left alone, so the locks grow with live
  rows only.

KEY SHARE conflicts with the FOR UPDATE that sign-out, reset and the
generation writers take and with an account deletion, so whichever of them
arrives second queues on the `users` row. Sign-in, refresh and foreign-key
checks also take KEY SHARE, so they never wait for a registration. The token
lock is only ever taken first, by registrations, and it keeps the live token
rows and their owners fixed until commit. The climber's own row is the one
exception: a registration of the same installation with another token can hand
it to a third climber after the owner read, so registration may lock it
without that climber's `users` row. That closes no cycle: after taking it,
registration waits only for later device rows, whose owners' `users` rows it
holds, and the third climber's sign-out just waits for it to commit.

Registration gives up after 1 s on any one lock (55P03). The app registers on
every launch and retries a failed registration on the next foreground, while a
waiting registration holds a pool connection and KEY SHARE on its climber.
Without the limit, a registration stuck behind a long account deletion of the
token's previous owner would hold its own climber's row past the 4 s a
sign-out waits, and that sign-out would fail.

Before #7645 registration locked the device rows first and reached `users`
last, through its insert's foreign key, the reverse of sign-out. Two
registrations whose installations trade tokens also locked each other's rows
crosswise. `notification-device-signout-lock-order.test.ts` runs registration
against sign-out in both start orders and both revocation modes, for the same
climber and for a token moving from the climber signing out to another,
against an account deletion in both orders, and two registrations trading
tokens. It also covers the lock timeout, inactive rows, a delivery holding
the climber's own row, and the own row changing hands. Its controls replay the
old order and get `40P01` against sign-out and between the two registrations.

`CURRENT_STORE_DELETED_EMAIL_KEY` must separately be provisioned before any
staged writer and must never rotate. Neither command enables a writer mode,
partner mode, mirror or Better Auth module. The owner-only production sequence
and exact commands belong exclusively to issue #7430.

`auth-fence plan` prints ordinary reviewable SQL and its SHA-256, with rollback
SQL commented out. `apply` requires that hash, regenerates the plan from the live
catalog, applies it transactionally, and verifies the result before commit.
Both tools use only `AUTH_OPERATOR_DATABASE_URL`, require `--confirm-host`,
reject SQL debugging, and do not consult `DATABASE_URL` or ambient `PG*` fields.
Connections require verified TLS except explicit loopback test connections.
Only catalog names, counts, opaque projection identifiers and digests leave the
commands; database errors and URLs are never printed.

The new `boardsesh_web` role must be a plain restricted LOGIN with no ownership,
role memberships, schema/database creation, superuser, replication or bypass-RLS
capability. It must never inherit `boardsesh_runtime`: migration reconciliation
continues granting that role broad backend access. The separate web contract
is reconciled after each migration whenever the new role exists. New objects
start without web grants; reconciliation grants nonauth base-table CRUD and
keeps `auth_*`, `oauth_*` and the enumerated legacy identity tables read-only.
The first operator apply needs administrative rights to create the role and
reconcile every enumerated object owner's defaults, including separate NOLOGIN
helper owners. Routine migrations change only the configured DDL owner's
objects and defaults; external and extension objects retain the reviewed admin
ACLs. Full effective verification still covers those excluded objects and
requires every owner's global routine-default deny row. New privileged owners
or drift require a new administrative plan; migration SQL does not impersonate
another owner.

New identity tables must use that prefix or extend `NAMED_IDENTITY_TABLES` in
`packages/db/src/auth-web-acl.ts` before landing; every other table gets web
CRUD from the next migration's reconcile. A unit test enforces this for
`packages/db/src/schema/auth/`: it imports every table that folder declares and
fails unless each is fenced or listed in `WEB_WRITABLE_AUTH_SCHEMA_TABLES` with a
reason. Today that list holds only `user_profiles` (display name, avatar and
privacy; web sign-in and registration create the row). `aurora_credentials`
(encrypted board passwords and refresh tokens) and `user_board_mappings` are now
fenced: the backend and sync workers write them, the web only reads them.
`auth_session` has no web read grant; `auth_subject_cutoffs` keeps SELECT
because web credential stamping needs it. An identity table's own sequence gets
no web USAGE either (re-granted only by the emergency rollback SQL).

Effective checks cover table and column ACLs, PUBLIC, ownership, memberships
including SET ROLE paths, defaults, writable views/rules, foreign-key cascades,
and executable SECURITY DEFINER routines. Unknown indirect paths fail closed.
The plan grants product tables only SELECT/INSERT/UPDATE/DELETE, so `verify`
refuses TRIGGER, REFERENCES or TRUNCATE on any table
(`UNREVIEWED_TABLE_PRIVILEGE`; on an identity table, `IDENTITY_WRITE_PATH`),
USAGE or UPDATE on an identity table's sequence (`IDENTITY_SEQUENCE_PATH`), and
UPDATE (setval) on any sequence (`UNREVIEWED_SEQUENCE_PRIVILEGE`).
The reviewed 0298 logbook trigger bodies are pinned by SHA-256, attachment,
language and search path, with an exact logbook sink column/default/index/primary-key contract, no RLS,
inheritance, extra trigger or rule, and pinned plain enum I/O on source tables.
The operator guard covers the comparison vocabulary in the pinned bodies;
unrelated pg_trgm distance operators remain usable. A changed body, operator,
cast, index function or sink shape needs review. This
policy is a capability boundary at inspection time; a privileged administrator
can change grants afterward. Moving the deployed web connection string also
requires retiring every old web pool using the runtime credential; creating a
new role cannot revoke an already running process's different database identity.
Emergency re-grants are allowed only before S3. They never remove cutoff rows,
restore passwords or close the later session/rollout gates.

Full-schema QA restores a schema-only dump of a migrated database into a
disposable database, never a production dump or an account-row copy. The
isolated test config accepts `AUTH_FENCE_TEST_SCHEMA_FILE` plus a loopback-only
`AUTH_FENCE_TEST_DATABASE_URL`; it never falls back to the product connection
string. The fixture refuses to start while `boardsesh_web` or
`boardsesh_identity_writer` exists in the cluster, and removes only its own
temporary database and those two roles. The ordinary unit suite checks argument
validation, read-only defaults, future identity classification, cutoff reads,
rollback output, fixed refusal codes and non-bypassable activation gates.

### CI proof

The required `test-auth-fence` job in `ci.yml` runs whenever backend, shared or
root CI inputs change. It owns a PG18.6/PostGIS cluster on the same pinned image
as `test-credential-writer`, but not that job's cluster: roles are cluster-wide
and the credential proofs leave both roles behind. It applies the full canonical
journal with the credential bootstrap, dumps the schema with the server's own
`pg_dump`, then runs `vp run test:auth-fence`. A JUnit check fails the job if any
case is skipped or fewer than 18 full-schema cases ran. The run proves, on the
current journal:

- the fence applies through the operator CLI's `plan` hash and `verify` passes;
- connected as `boardsesh_web`, `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` on
  every identity table fails with SQLSTATE `42501`. The tables come from the
  catalogue (46 on the current journal, plus the test's own
  `auth_future_identity`), checked against a named list so an empty catalogue
  cannot pass;
- the web login still inserts, edits and deletes a tick and a playlist, and the
  delete triggers still write their `logbook_changes` and `sync_deletions` rows;
- after `boardsesh_identity_writer` receives the reviewed
  `private-browser-renewal-v1` grants, it qualifies, inserts a user, inserts and
  changes a password and adds and removes a session, while `verify` still passes
  and the web login still gets `42501` on `user_credentials`;
- reopening one identity write (`GRANT INSERT ON users`) makes `verify` refuse
  with `IDENTITY_WRITE_PATH`;
- each newer `verify` check fails with its own code when its grant is present:
  USAGE or UPDATE on `aurora_credentials_id_seq`, UPDATE on a product sequence,
  TRIGGER or REFERENCES on an identity table, TRIGGER, column REFERENCES or
  TRUNCATE on `gyms`, and writes on the two newly fenced board-account tables;
- `apply` waits for the fence lock a migration reconcile holds and gives up
  with SQLSTATE `55P03` after 2 seconds.

The job runs 2 minutes or less (1 min 36 s on the first run, 11 s of it tests),
so it keeps its own runner rather than a second cluster inside
`test-credential-writer`. Sharing that job would mean a second service
container, a role bootstrap on it (the dump references
`boardsesh_sync_cutoff_owner`, `boardsesh_runtime` and
`boardsesh_snapshot_fence_owner`), and relaxing two pinned assertions in that
job's boundary test (`services` is exactly `['postgres']`, the bootstrap only
accepts port 5432).

Local reproduction needs any PG18 cluster without those two roles, a migrated
database to dump, and the same two variables:

```sh
pg_dump --schema-only --dbname=<migrated-local-database> > /tmp/fence-schema.sql
AUTH_FENCE_TEST_SCHEMA_FILE=/tmp/fence-schema.sql \
AUTH_FENCE_TEST_DATABASE_URL=postgresql://postgres:<password>@127.0.0.1:<port>/postgres \
  vp run test:auth-fence
```

Author run on 2026-11-16, PG18.6/PostGIS 3.6.4, 317-entry journal: 31/31 cases
(12 unit, 19 full-schema) in 9 seconds. A deliberate `GRANT DELETE ON
oauth_session TO boardsesh_web` made the per-table case fail and name that
statement; a `passkey` table added under `schema/auth/` made the coverage test
fail and name it.

### Operator commands

`vp run auth:fence` wraps `packages/backend/src/scripts/auth-fence.ts`. The
three modes, with `plan` as the default:

| Mode | Transaction | Output |
| --- | --- | --- |
| `plan` | read-only, repeatable read | `-- planSha256: <hash>`, every `CREATE ROLE`/`REVOKE`/`GRANT`/`ALTER DEFAULT PRIVILEGES` statement, then the emergency re-grant SQL as `-- ROLLBACK:` comments |
| `verify` | read-only, repeatable read | `{"mode":"verify","role":"boardsesh_web","verified":true,"catalogSha256":…}` |
| `apply` | read committed, 2 s lock timeout, fence lock | `{"mode":"applied","planSha256":…,"evidence":{…,"catalogSha256":…}}` after `verifyFence` passes inside the same transaction |

Two hashes appear, and they are never comparable. `planSha256` names the SQL
that `plan` printed; it is the value `apply --plan-sha256` takes. `catalogSha256`
names the plan the catalogue would produce at the moment of `verify` or `apply`,
which drops the `CREATE ROLE` line once the role exists, so it differs from the
`planSha256` you applied. Compare `planSha256` only with `planSha256`.

`apply` first waits up to 2 s for the transaction-scoped advisory lock
`(6975, 3)` and holds it to commit. Every migration's web reconcile
(`reconcileWebRuntimeAcl`) takes the same lock, so a migration and an apply
cannot interleave their grant reads and writes. The migration runner had no
advisory lock of its own; the migration DDL itself is not covered, only the
reconcile that follows it. The reconcile waits at most 2 s too, then fails the migration with SQLSTATE `55P03` and a message naming an open `auth:fence apply` as the likely holder; it restores the session's own `lock_timeout` for its grants. Without `boardsesh_web` no reconcile runs, so nothing changes there.

`apply` refuses without `--plan-sha256` (`PLAN_SHA256_REQUIRED`) and refuses a
hash the live catalogue no longer produces (`PLAN_CHANGED`); `plan` and `verify`
refuse a hash. A refusal prints one fixed code, such as `UNSAFE_WEB_ROLE`,
`IDENTITY_WRITE_PATH` or `SQLSTATE_55P03`, and exits 1; driver messages and URLs
are never printed. The plan never contains a password: `apply` creates
`boardsesh_web` without one, and the owner sets it separately.

```sh
export AUTH_OPERATOR_DATABASE_URL='postgresql://<admin>@<host>:5432/<db>?sslmode=verify-full'
vp run auth:fence -- plan --confirm-host <host>
vp run auth:fence -- apply --confirm-host <host> --plan-sha256 <hash-from-plan>
vp run auth:fence -- verify --confirm-host <host>
```

The leading `--` is optional; the operator parser drops exactly one. Every
tool on that parser names its write modes, and a write mode is never the
default: with no verb, `auth:fence` plans, `auth-authority` reports status and
`auth:revoke-sessions` plans. `auth:import-identities` plans too (read-only
precondition checks and a user count); its one write mode needs the verb
(`vp run auth:import-identities -- import --confirm-host …`), and the shared
parser refuses `WRITE_COMMAND_REQUIRED` for any write mode left unnamed.

Neither the identity mirror's startup nor the import takes the fence lock
`(6975, 3)`: they only read the fence, with `verifyFence` inside one read-only
snapshot, and an `apply` commits atomically, so the check sees the catalog
before or after it and never waits on or blocks a migration's reconcile.

### Web connection string

**Setting `WEB_DATABASE_URL` before the web's identity writes move to the
backend breaks sign-up, password reset and email verification.** The code
refuses it: `WEB_DATABASE_LOGIN_BLOCKERS` in `packages/db/src/client/config.ts`
holds `LEGACY_WEB_IDENTITY_WRITERS`, and while that list is non-empty a set
`WEB_DATABASE_URL` stops the web at boot (`instrumentation.ts` exits 1 with
`WEB_DATABASE_LOGIN_BLOCKED`, so the deploy fails instead of serving errors) and
again in `applyWebDatabaseUrl()`. No variable or flag closes the gate; removing
the entry is a reviewed code change made once every writer below has moved.

The web writes these identity tables today; on `boardsesh_web` each fails with
`42501`:

| File (under `packages/web/app/`) | Lines | Write |
| --- | --- | --- |
| `api/auth/register/route.ts` | 93, 101, 112 | insert `users`, `user_credentials`, `verificationTokens` |
| `api/auth/forgot-password/route.ts` | 92, 95 | replace the reset token in `verificationTokens` |
| `api/auth/resend-verification/route.ts` | 97, 99 | replace the verification token |
| `api/auth/reset-password/route.ts` | 145, 152, 162, 166 | update or insert `user_credentials`, verify `users`, delete the token |
| `api/auth/verify-email/route.ts` | 86–115 | delete tokens, set `users.emailVerified` |
| `api/internal/set-password/route.ts` | 111, 120 | insert `user_credentials`, verify `users` |
| `lib/auth/auth-options.ts` | 146 | the `native-oauth` provider inserts a transfer token's single-use marker into `verificationTokens`; on `boardsesh_web` that sign-in is refused |
| `lib/auth/auth-options.ts` | 270 | `DrizzleAdapter` creates and updates `users` and `accounts` on OAuth sign-in |
| `lib/auth/auth-options.ts` | 424 | sign-in callback sets `users.emailVerified`; its failure is swallowed, so it would stop silently |

How the URL is chosen. The web builds its shared pool in
`packages/web/app/lib/db/db.ts`, which calls `applyWebDatabaseUrl()` from
`@boardsesh/db/client` before the first pool; `instrumentation.ts` marks the
process the same way at boot, before Sentry starts. A marked process reads
`WEB_DATABASE_URL` and falls back to `DATABASE_URL` when it is unset or blank,
for both the pool and the hostname Sentry uses to tell production from a
private database. The backend never marks itself, so a stray copy there changes
nothing. `infra/railway/config.ts` declares `WEB_DATABASE_URL` on
`boardsesh-web` as an optional secret: absence is not drift, only an unfilled
placeholder is reported, and `railway:apply` never writes it.

Remove `DATABASE_URL` from `boardsesh-web` once `WEB_DATABASE_URL` is live and
verified. While it stays, the web process still holds the backend's full-write
login and a compromised web process could use it. Nothing else on the web
service needs it: at runtime only `@boardsesh/db/client` reads it (the pool and
the Sentry hostname above, both now preferring `WEB_DATABASE_URL`); the web
image is built in GitHub Actions with no database variable; migrations run in
`production-deploy.yml`'s `migrate` job with `MIGRATOR_DATABASE_URL`, not on the
web service. `DATABASE_URL` in `packages/web/.env.local` and the e2e harnesses
is local and test only.

`READ_REPLICA_URL` is not changed. If it is ever set on `boardsesh-web`, the web's
read pool uses the replica's own login, which the fence does not cover and which
may still read `auth_session`; a web replica login needs its own grant review
before that variable is set there.

The order of these owner steps belongs to #7430.
