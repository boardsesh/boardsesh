# BA-03 current-store reservation and revocation foundation

This is an additive, **unmounted foundation** for
[BA-03 #6977](https://github.com/boardsesh/boardsesh/issues/6977), following the
[accepted migration design](./better-auth-migration.md). It adds no Better Auth
dependency, backfill, production route, active validator, issuer switch or
credential mutation command. Existing native/web behavior is unchanged.

The five tables are generated in `0291_auth_current_store_foundation.sql` through
the repository's standard Drizzle generation. The migration creates only new
tables, their internal foreign keys, checks and indexes. Library imports run no
DDL, preparation or activation.

## Recorded scope and decisions

| Table | Purpose and retained boundary |
| --- | --- |
| `auth_email_projection` | Immutable projection ID, normalizer version, writer epoch, preparation counts and phase; a partial unique index permits at most one current manifest |
| `auth_email_reservations` | One normalized key, originating projection ID, one existing/generated owner or an explicit blocked state; keys are never automatically reassigned |
| `auth_email_reservation_members` | Every observed user ID in a normalized group, including ambiguous groups and deleted members |
| `auth_subject_cutoffs` | Monotonic revocation generation, nondecreasing cutoff time, deletion tombstone and last operation ID |
| `auth_security_mutation_events` | Immutable mutation receipt and authority-neutral outbox event, unique by operation ID and by user/generation |

Cutoffs, events, owners and historical members deliberately have **no cascading
foreign key to `users`**. Deleting a current user must not erase evidence needed
to deny old credentials or delayed work. Reservation-basis foreign keys point to
immutable manifest IDs; there is no update cascade that restamps old claims.
Events contain an immutable user ID, operation ID, kind, generation, revocation
domains, cutoff time and version/context fields. They contain no email, password,
password hash, provider token, bearer secret or arbitrary metadata payload.

Normalized addresses and membership IDs are sensitive identity data. The
registry must have restricted access, and keys, members and SQL bind parameters
must not enter logs. Retaining blocked deleted keys is an **agent safety
decision for this unmounted foundation**, not a user-approved product policy.
This conservative foundation retains blocked deleted keys;
it is **not an approved permanent ban on registering a deleted address again**.
Retention, privacy/erasure obligations, old email-keyed links and any safe future
release protocol require a reviewed activation policy. There is no release API.

## Preparation is not authority activation

`prepareProjectionUnderUsersTableLock(transaction, { projectionId })` performs
the first persistent preparation only. It creates a `preparing` manifest, takes
a real `SHARE ROW EXCLUSIVE` lock on `users`, reads every stored user email and
applies the shared JavaScript `normalizeAccountEmail`, exactly
`email.trim().toLowerCase()`. It does not use SQL `btrim`, remove dots/plus tags,
infer aliases, change user IDs or rewrite stored email addresses.

The complete projection and all members commit atomically with a `prepared`
manifest and counts, including an empty-user projection. One-member groups
retain their existing owner; multi-member groups become `blocked_ambiguous`
without selecting a winner. Empty normalized historical addresses are blocked
as invalid. A losing concurrent preparation fully rolls back. Repeating or
rebuilding after any persisted manifest, including noncurrent history, is rejected: this slice cannot
silently overwrite live claims, historical members or tombstones.

The supported phases are `preparing`, `prepared` and `enforced`. **No source API
sets `enforced`, switches the current manifest, rebuilds a projection or
restamps reservation history.** A prepared snapshot can become stale as soon as
its transaction commits if old writers still have permission to write. A test
demonstrates that direct legacy SQL can then create a duplicate; helpers still
reject that merely prepared manifest. An epoch or advisory lock does not fence
an old writer that never checks it.

An eventual operator cutover must first establish the actual role/writer fence
and run fresh fenced reconciliation. An earlier unfenced preparation must not
be promoted on its old counts alone. That reconciliation and activation command
are intentionally absent. Immutable manifest/basis rows leave room to retain
old evidence during a future reviewed transition rather than changing an old
manifest ID underneath referenced claims.

All foundation mutation entry points explicitly require **READ COMMITTED**.
A later table/row lock does not refresh an earlier REPEATABLE READ or SERIALIZABLE
snapshot. Such a snapshot can miss a newly committed legacy user or the first
deletion-cutoff row. Tests cover both failures. The shared isolation guard runs
before preparation, reservation and security-ledger operations. This follows
PostgreSQL's documented [table-lock snapshot limits](https://www.postgresql.org/docs/15/sql-lock.html)
and [transaction visibility rules](https://www.postgresql.org/docs/15/transaction-iso.html).

## Internal reservation and mutation contracts

`reserveEnforcedEmail` requires the exact current enforced projection ID,
normalizer version and expected writer epoch. The function derives the key from
raw email itself. `requestedUserId` must come from trusted server creation or a
proven authenticated identity; it is not a public request-selected owner.
The function takes the authority gate, validates the current manifest, takes the
key's creation lock, checks the deletion cutoff, then reads
the normalized key across **all** basis IDs. An old-basis occupied key rejects;
filtering it away must never make that address appear free. A fresh key can be
reserved by one generated owner, and an existing owned key can only be reused
by that same unambiguous owner. Ambiguous, deleted, invalid or inconsistent
groups remain blocked. The caller must persist the actual identity/account
change in that same outer transaction and follow the reservation discipline.

`recordSecurityMutation` accepts trusted internal operation/user IDs, the exact
authority context, expected generation, a revocation kind and explicit domains.
The initial kinds are password set/change/reset and account deletion, requiring
both `first-party` and `partner` revocation. Ordinary verification/audit events
are outside this contract; it does not revoke all sessions for every auth event.
The helper advances the generation, retains the greatest previous/current
database cutoff time, and appends one event in the same transaction. Generations
remain authoritative when timestamps are equal or a previous cutoff is ahead.
`recordedAt` is a database transaction timestamp, not an exact commit-time claim.

Every reused operation ID rejects, even when the metadata matches. It must abort
the caller's outer transaction, including a different password write made before
the duplicate is detected. There is no secret-bearing command fingerprint or
implicit idempotent-success acknowledgment. Future authorized receipt retrieval
is separate work. A caller that catches a foundation error and commits its
credential changes violates this contract; the helper alone cannot prove an
entire command's transaction boundary.

On account deletion, every key the account alone held becomes a
`blocked_deleted` digest row and its memberships go (see the
[deletion doc](./better-auth-account-deletion.md)); a shared key stays blocked
with its other members. Deleting one member never elects a surviving owner. A deleted user ID cannot reserve another address or advance a new security
mutation. No deleted-key release, outbox dispatcher, consumer acknowledgment,
retry worker or credential-mutation callback API is included.

Since BA-04 PR 3 nothing serializes every command. Each staged command takes
the authority gate, `pg_advisory_xact_lock_shared(6975, 2)`, then reads and
validates the manifest without a row lock; commands never wait for each other on
it. Only an authority switch or activation takes the gate exclusively
(`lockAuthorityGateExclusively`, 2 s lock limit), so the manifest cannot change
while any command is between its check and its commit. Below the gate, locks are
per address and per climber, in one order (BA-04 plan, section 4):

1. Creation only: the address's creation lock (`lockEmailKeyForCreation`, an
   advisory key over the normalized email) before its reservation row is read,
   because a free key has no row to lock. A provider sign-in first takes its
   provider subject's lock (`lockProviderSubject`), so one subject cannot
   create two accounts.
2. The climber's `users` row: `FOR UPDATE` for any write, `FOR KEY SHARE` for a
   sign-in. Commands that resolve a climber by email read the reservation's
   owner without a lock, lock that climber's row, then lock and re-check the
   reservation. Account deletion holds this row through its content and cascade
   and locks the reservation after it, so the two orders agree and cannot cycle.
3. Then the reservation and members, the cutoff row, credentials and accounts,
   purpose state and receipts, refresh rows.

`recordSecurityMutation` itself takes `users FOR UPDATE` before the cutoff row,
so every generation writer excludes native issuance and refresh, which hold
`users FOR KEY SHARE` and read the generation after that lock.
A writer that must win (reset, verify, set-password, deletion) waits for a
climber's row up to its 4 s lock limit. A sign-in, forgot-password or
resend-verification gives up after 250 ms (`SIGN_IN_LOCK_TIMEOUT`) and answers
the retryable unavailable reply, never a wrong password, so a burst naming one
held account cannot keep a backend process's five pool connections busy. A web
sign-in whose password matched no one takes no user lock at all. The fixed
system identities keep a 250 ms limit there, because they hold the exclusive
fixed-owner key while they wait. The helpers perform no provider network or
bcrypt work themselves; callers keep such work outside the transaction.

## Automated proof and remaining gates

The real-Postgres tests use randomly salted worker databases and uniquely named,
owned test roles. Only fixture code marks a manifest enforced, after an actual
table-lock drain, old-role privilege revocation and new-role grants. A held old
transaction visibly blocks the drain; after it commits, the full JS projection
includes its write. The still-connected old session's pre-prepared INSERT and
direct UPDATE both reject with permission errors after the transfer.

These fixture roles are `NOLOGIN` roles selected through `SET ROLE` on owned
administrator connections. The tests prove the selected role's SQL permissions;
they do not provision independent application logins or prevent an administrator
from resetting its role. The separate prototype includes an application-login
role experiment; neither test establishes deployed production grants.

The test writer can SELECT/INSERT events but cannot UPDATE, DELETE or TRUNCATE
them. This is an immutability guarantee for the exercised role, not protection
against the database owner, a superuser or an administrator changing grants.
Production ownership, inherited roles, all writer surfaces, delayed jobs,
prepared transactions and old token issuers/validators still need an audited
cutover policy. A test role transfer does not prove those production facts.

Other tests cover complete Unicode whitespace normalization, missing/incomplete/
stale/noncurrent manifests, prior-basis occupancy, concurrent registration versus
social account creation, deleted collision members, reservation rollback, actual
password persistence with cutoff/event commit, database failure during event
insertion, failure before outer commit, duplicate operations, stale-generation
races, ahead-clock cutoffs and deletion-surviving events/keys/membership.

Two independent reviewers approved the final source, schema, test evidence and
documented boundaries. All **29 cases** pass independently on Postgres15
(11.75 seconds total, 2.46 seconds in cases) and Postgres18 (6.41 seconds total,
1.59 seconds in cases), with clean teardown. Backend typechecking and selected
format/lint checks pass with zero warnings/errors. The event-insert failure and
stale-writer tests use actual database errors rather than mocked adapter methods.

The primary agent's full aggregate typecheck passed **58 tasks**. Repository
`vp check` passed with **0 errors and 623 existing warnings**. The original generated
registry contained **290 consistent migrations**, and a second Drizzle generation
reported no schema changes.
The final backend typecheck passed its **13 tasks** after the last source fix.
The foundation and all five existing native suites passed together: **134 tests
in six files, 19.67 seconds**, on PostgreSQL18.6 with the updated worker schema.

No production URL has been rerouted through this foundation, and no legacy reset
or verification link verifier is added here. Current validators do not consume
the new cutoff and no consumer applies the new event to sessions/partner tokens.
BA-03 acceptance remains open until the current-store service and every adapter,
writer fence, recovery path and revocation consumer are implemented and proved.

## Migration repair after main advanced

Main added `0289_board_lit_by_wall_device.sql` before this candidate merged.
The repository bot rebased and renumbered the auth migration to
`0291_auth_current_store_foundation.sql`. This repair retains the bot's SQL tag,
snapshot identity and journal timestamp, together with main's unchanged board
migration, snapshot and journal entry. Independent compilation of the merged
schema and local Drizzle generation reproduced the same auth SQL and schema
additions. The auth SQL is byte-identical to the original unmerged auth migration
(SHA-256 `074511634085cc87c8affcc44309106afabf2e45ddc6c83a7d8b16077f2b2962`).
The new snapshot adds exactly five auth tables, changes no prior table or other
schema section, and preserves `user_boards.lit_by_wall_device`.

The independently generated equivalent candidate passed all **29 foundation
cases** on owned PostgreSQL18 (11.71 seconds) and PostgreSQL15 (13.53 seconds).
The final bot-aligned candidate passed **29/29 on PostgreSQL18 in 13.79 seconds**,
all **14 real migration-journal tests** without skips, and **13 backend type
tasks**. These reruns overlap the earlier cases. The registry contains
**291 consistent migrations**; a second Drizzle generation reports no drift.
The backend fixture reads the retained SQL filename. Generated SQL executes
only in owned test schemas. No migration was applied to a shared or deployed
database, no development service was started, and no previously applied shared
local migration ledger was reconciled.
