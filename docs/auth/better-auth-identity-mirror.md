# Identity mirror (BA-04 PR 7)

The backend's `AUTH_IDENTITY_MIRROR` selector accepts `off` (default) or `on`.
Unknown values fail closed. `off` adds no mirror queries and leaves the existing
identity, credentials, sessions, and authentication age unchanged.

**`on` copies nothing until every precondition holds, checked against the
database at startup; otherwise the backend exits with one fixed code.** There is
no environment bypass. Production cannot meet them today: the code gate
`LEGACY_WEB_IDENTITY_WRITERS` is open, and the enforced phase is written only by
`auth-authority activate`, which refuses while any code gate in
`AUTHORITY_ACTIVATION_BLOCKERS` is open. No activation, route mount, import,
bridge, or writer switch occurs here.

## Preconditions

`qualifyIdentityMirrorAtStartup()` (`auth/authority/mirror-activation.ts`) runs
in `main()` before the job queue or the server starts. With `off` it runs no
query. With `on` it checks, in this order, and refuses with the first failing
code:

| Precondition | Checked against | Refusal code |
| --- | --- | --- |
| `AUTH_IDENTITY_MIRROR` is `off` or `on` | environment | `MIRROR_SELECTOR_INVALID` |
| Set-password is delegated (`CURRENT_STORE_SET_PASSWORD_MODE=backend-staging`, web credential proof `required`) | environment | `SET_PASSWORD_NOT_DELEGATED` |
| Native registration and native OAuth are `reserved-staging`; legacy native writers cannot take the gate and user lock in order | environment | `NATIVE_WRITERS_NOT_STAGED` |
| A valid expected projection and epoch (`CURRENT_STORE_AUTH_PROJECTION_ID`, `CURRENT_STORE_AUTH_WRITER_EPOCH`), cutoff enforcement and the deleted-email key | environment | `AUTHORITY_CONFIGURATION_INVALID` |
| `AUTH_IDENTITY_DATABASE_URL` names the dedicated `boardsesh_identity_writer` LOGIN on the content pool's database | environment | `CREDENTIAL_WRITER_UNQUALIFIED` |
| The copy's tables exist: `auth_account` with the columns it writes and the unique `(provider_id, account_id)` index, and the manifest's `writer_authority` column | catalog, on the writer LOGIN | `MIRROR_TABLES_MISSING` |
| The LOGIN qualifies: it can log in, `qualifyCredentialWriter` passes for `AUTH_IDENTITY_DATABASE_CONTRACT` (exact grants and reviewed relation shapes), and it reaches the same server and database as `DATABASE_URL` | catalog, on the writer LOGIN | `CREDENTIAL_WRITER_UNQUALIFIED` |
| The current manifest is `enforced` under the current normalizer | one read-only snapshot | `AUTHORITY_NOT_ENFORCED` |
| `verifyFence` passes for `boardsesh_web` against the live catalog | same snapshot | `WEB_FENCE_UNVERIFIED` |
| The manifest is the configured projection, at an epoch not behind the configured one | same snapshot | `AUTHORITY_STALE` |
| At the configured epoch, its writer authority is `current-store` | same snapshot | `AUTHORITY_NOT_CURRENT_STORE` |
| No code gate in `IDENTITY_COPY_BLOCKERS` (`auth/authority/identity-copy-gates.ts`) remains | code | `IDENTITY_COPY_CODE_GATES_OPEN` |
| No activation code gate in `AUTHORITY_ACTIVATION_BLOCKERS` (`auth/authority/activation-gates.ts`, shared with `auth-authority activate`) remains: `enforced` is database state an administrator could set by hand | code | `ACTIVATION_CODE_GATES_OPEN` |

A check that could not run (connection refused or lost, a timeout, a server
error mid-catalog) is `PRECONDITION_CHECK_UNAVAILABLE`, never one of the
verdicts above. A rejected login (SQLSTATE class 28), a qualifier refusal or a
target mismatch is `CREDENTIAL_WRITER_UNQUALIFIED`; only a fence refusal code is
`WEB_FENCE_UNVERIFIED`. The refusal is the whole error message: no driver text,
SQL, URL or account detail. The qualification pool holds one connection and
closes before the server starts; the running private commands keep their own
lazy two-connection pool.

### The code gate

`LEGACY_WEB_IDENTITY_WRITERS`: the Next.js web still writes `users`,
`user_credentials` and `accounts` over its own `DATABASE_URL` (registration,
password reset, set-password, email verification and the NextAuth adapter's
account links). Those writes never pass through the mirror, so a copy taken now
goes stale behind them. After a legacy web reset the old password would still
work once Better Auth is the authority, and a web Google link would have no
canonical row. Reconciliation cannot close that gap while the web keeps writing.
`verifyFence` proves only that the restricted `boardsesh_web` LOGIN cannot write
identity tables; no database state proves the web process connects as it. A
reviewed code change removes the entry once those writers have moved behind the
backend. The web's own list `WEB_DATABASE_LOGIN_BLOCKERS`
(`packages/db/src/client/config.ts`, #7631) keeps the web off its fenced login
for the same reason. Both lists hold the one `LEGACY_WEB_IDENTITY_WRITERS`
constant defined there, the backend imports it from the import-free
`@boardsesh/db/client/config` (the web bundle gains no backend code), and
`sync-identity.test.ts` fails if only one list contains it.

### After an authority switch

A switch raises the writer epoch. A backend restarted afterwards with its old
configuration would otherwise refuse and crash-loop until someone redeploys. So
when the database's epoch is **ahead of** the configured one, startup boots
**inert** instead (reason `AUTHORITY_NOT_CURRENT_STORE` after a switch to Better
Auth, `AUTHORITY_STALE` after a switch back). The server starts, the mirror
copies nothing, and every mirrored credential write refuses with
`STALE_AUTHORITY`; sign-ins and everything else keep working. The boot logs
`[IdentityMirror] Inert (<reason>)` as an error, so Sentry records each such
boot. The backend has no metrics pipeline; that Sentry event is the signal to
alert on. Redeploy with `AUTH_IDENTITY_MIRROR=off` (after a switch to Better
Auth) or with the new `CURRENT_STORE_AUTH_WRITER_EPOCH` (after a switch back),
which qualifies in full. Nothing else boots inert: an epoch behind the
configuration, another projection, or a Better Auth manifest at the configured
epoch refuses, so a first enable always needs every precondition.

### While running

The startup check records the qualified projection and epoch. Every mirrored
copy reads the manifest after taking the shared authority gate, as it already
did, and refuses with `STALE_AUTHORITY` unless the manifest is still enforced,
current-store, and that projection and epoch. The refusal propagates through the
caller's transaction, so the credential write and its copy roll back together.
Nothing is copied under an authority the process did not qualify. With the
mirror on, a process that never ran the startup check refuses every copy with
`MIRROR_NOT_QUALIFIED`.

The fence and the LOGIN's grants are catalog state, too costly to re-read per
transaction. A grant change after boot is caught by the next boot, by
`auth-fence`, and by the import's own checks.

Suites that exercise writers with `on` and no backend boot opt in with
`recordFunctionLevelIdentityMirrorForTests()` (`vp run test:auth-mirror` through
its setup file, the authority suites per file); their copies keep the unchecked
behaviour. `sync-identity.test.ts` fails if any non-test module calls it.

## Copy and lock contract

`syncIdentity(transaction, userId, 'current-store-to-authority')` is the single
copy primitive for this mirror and the later import/reconcile commands. Reverse
copy is unsupported and rejected; PR 11 owns the authority switch protocol.
The helper requires a caller-owned transaction and READ COMMITTED isolation.
It takes the shared authority gate, then `users FOR UPDATE`, before reading any
source credential or provider rows. It reads the cutoff generation under that
lock, then the legacy source rows and canonical targets. It opens no independent
transaction and never publishes credentials.

A credential row copies the exact bcrypt string into provider `credential`
with `accountId = users.id`. Provider rows copy the exact `(provider, subject)`
pair, including Facebook. OAuth access/refresh/ID tokens are not copied. A
canonical subject belonging to another user causes the whole transaction to
fail; it is never reassigned. A legacy provider named `credential` is rejected
because it would collide with the password namespace.

Rows carry `source_generation`. A canonical generation ahead of the source is
an error, preventing a stale source from overwriting newer evidence. Identical
rows are left untouched; replay preserves IDs and timestamps. Canonical rows
whose credential/provider is absent from the locked legacy source are removed.
Missing or deleted users are skipped. No user copy, session, authentication-time
claim, epoch, lineage, or denial is created or changed.

## Writer inventory

| Writer | Mirror boundary |
| --- | --- |
| Web/native staged password registration | Shared password identity insertion, inside the existing transaction |
| Web/native staged provider identity creation/reuse | Shared provider identity helper, under its existing user lock |
| Reset, and later current-store set/change mutation callers | Security mutation boundary, after credential write and cutoff increment |
| UID and preserved legacy-link email verification | Verification transaction, after the existing users timestamp write |
| Fixed board/job system identities | Existing backend system identity transaction |
| Account deletion | Shared `users` row deletion cascades canonical account/session children; evidence has no FK |
| Legacy native registration/OAuth | Rejected by configuration when mirroring is selected; the direct legacy OAuth helper also refuses |
| Legacy web registration/reset/verification and NextAuth account links | Still write over the web's `DATABASE_URL`, outside the mirror. The `LEGACY_WEB_IDENTITY_WRITERS` code gate keeps the mirror and the import refused until they move behind the backend |
| Web set-password | Backend-owned fresh-auth command and same-transaction mirror in staged mode; startup refuses the legacy default, and the legacy web route is under the code gate above |

The password insertion helper acquires the gate before any creation write when
mirroring is selected. Other integrated staged writers already hold the gate
and user lock; reacquisition is transaction-scoped and safe. Failure propagates
through the existing caller transaction and rolls back the legacy write and
canonical copy together. The default-off native and web paths retain their
existing behavior.

## Proofs and fixture boundaries

`vp run test:auth-authority` uses fresh suite-owned localhost databases for
identity mapping and mirror proofs. Mirror cases cover exact hashes/subjects,
no OAuth token copying, replay, unlink removal, ownership conflicts, stale
generations, default-off behavior, injected SQL failure, and a real two-connection
reset versus backfill wait. A backfill cannot read an old password before the
reset's user lock is released.

`vp run test:auth-mirror` qualifies every current-store suite sequentially with
function-level mirroring selected. The startup check is not bypassed or
disabled; `vp run test:identity-import-proof` exercises it end to end (see
[identity import](better-auth-identity-import.md#proof)). Each fixture uses its existing checkout-scoped worker database;
there is no shared infrastructure setup or service restart. Generated migration
0306 supplies the canonical tables in the shared fixture. Restricted backend
command actors receive only the extra source-read and canonical-table grants
they require; fenced legacy/read-only web actors receive no canonical access.
These are synthetic test grants, not production grants or fence evidence.
