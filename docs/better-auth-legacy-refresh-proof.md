# Pre-cutover native and Garmin refresh proof

This disposable proof advances BA-01 (#6976) and BA-06 (#6980) in
[epic #6975](https://github.com/boardsesh/boardsesh/issues/6975). The
[implementation ledger](./better-auth-implementation.md) owns readiness. No
production backfill, credential-writer switch, HTTP route or account mutation is
enabled by this helper.

## Source contract and authentication age

Existing `mobile_refresh_tokens` rows contain an ID, user ID, SHA-256 token
hash, creation timestamp, expiry and optional revocation timestamp. Mobile and
Garmin use the same raw refresh-secret protocol. There is no original login
time or family relation in this schema. A rolling row creation timestamp does
not prove fresh authentication, and the importer never treats it that way.

An accepted active row becomes an explicitly non-fresh canonical session plus
the existing prototype native refresh sidecar. The sidecar preserves the exact
hash, owner, creation date and original expiry. The session keeps an epoch
`createdAt`, null original authentication time and a durable legacy lineage.
The already installed client's raw secret then works through the same native
facade that verifies new credentials; it receives the existing seven-day HS256
JWT and 90-day opaque rotating refresh response. No passwords are imported or
rehashed by this code, and the raw refresh secret is never supplied to the
importer or written to its records.

## Immutable cutover and revocation

The cutover boundary is fixed in a dedicated, non-expiring migration metadata
table under the `native-refresh` name. It has no user foreign key and is outside
Better Auth's verification cleanup. Handler recreation and the stock provider's
blanket expired-verification cleanup cannot move it forward. Only source rows
created at or before that boundary are accepted; remaining validity cannot
exceed 90 days after cutover.
The importer copies scalar fields and dates before awaiting the common lifecycle
fence, so a mutable caller snapshot cannot change an in-flight owner or expiry.

Separate immutable source-ID and token-hash bindings prevent re-import from
changing the original owner, hash, issuance timestamp or expiry. Binding
tombstones last through the source credential's original validity. The cutover
epoch is permanent even after the 90-day maximum legacy import horizon. Once
that horizon has passed, the importer rejects the original boundary; supplying
a later date still conflicts with the permanent epoch. Canonical descendants
continue using their normal supported refresh API; a 90-day import horizon is not an adapter
retirement deadline. The epoch insertion participates in the same transaction:
a failure during the first import rolls it back with all credential rows.

The importer preserves the exact trusted source expiry and bounds the remaining
validity at cutover. It does not require `expiresAt - createdAt` to equal at most
90 days: the old row's database `defaultNow()` uses transaction-start time,
whereas expiry is computed later with the application's clock. That difference
can legitimately exceed 90 days by the transaction duration. Neither timestamp
becomes proof of fresh authentication.

Re-import never clears a native row's consumed state. Canonical rotation sets
the ancestor's `revokedAt`; an unchanged active source snapshot must not undo
that consumption or revoke the valid canonical successor. Conversely, explicit
revocation in a later trusted source snapshot, while that source remains within
the bounded import window, terminates the imported canonical session and all
its descendants. That stronger denial is persisted, so an
older active snapshot cannot revive it. Initially revoked source rows become
denial records without creating an active session.

Deleting or expiring a canonical session leaves a denial rather than a reason to
mint another session from the old snapshot. Canonical account reset or sign-out
cutoffs reject pre-cutover imports, including ones not seen before the mutation.
All import, refresh and revocation operations cooperate with the same Postgres
transaction fence. Injected failure rolls back the session, sidecar, lineage,
source mapping and binding together.

## New admissions after canonical sign-out

A user-only old refresh source cannot identify which canonical session
authorized it. The shared sign-out path records durable canonical-session
denial history rather than revoking every session for that account. Before
importing a previously unseen source, this importer checks that history through
`hasPrototypeLegacySourceDenial` under the same lifecycle fence. Revoked,
missing or expired source history prevents a delayed unknown source from
creating a new session.

The check runs after the exact immutable binding path. A known imported binding
whose canonical session is still active therefore survives another session's
sign-out, along with unrelated canonical sessions and partner connections.
No account-wide cutoff is manufactured for that ordinary canonical sign-out.
The denial history is outside verification cleanup and remains effective after
handler recreation. This protects unknown-source admission; it does not claim
device-specific provenance for old rows that never carried it. Fresh
authentication and production ownership/fencing decisions remain separate.

## Explicit limits

The source snapshot and its boundary must come from the fenced authoritative
store. This helper is not a database role fence, a production migration runner,
or a mechanism for discovering trustworthy historical state from client input.
An old writer continuing to issue after cutover is rejected; supporting such
issuance without a current shared authority remains a no-go.

Any canonical account cutoff blocks these pre-cutover imports. This is
deliberately conservative and does not reinterpret unknown session age as a
post-cutoff login. A genuinely post-cutoff legacy issuance requires the missing
writer transition rather than setting canonical `createdAt` to the import time.

An old revoked refresh row alone cannot distinguish past normal rotation from
account compromise and cannot identify a historic JWT family that never carried
a session ID. The proof therefore does not claim that importing that one row
invalidates every old signed access JWT. The shared authority's explicit
account cutoff and legacy-access bridge remain responsible for those events.
Likewise, source cleanup, interrupted production backfill, database recovery,
installed-client storage and real-device/Garmin QA remain separate gates.

## Reproduce and review

```sh
AUTH_PROTOTYPE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:15475/postgres \
  vp test run --config packages/backend/vite.auth-prototype.config.ts \
  legacy-native-refresh.test.ts --reporter=agent
```

Author validation after the durable-epoch fix on 2026-11-04: **29 integration
tests passed** against real Postgres in 4.53 seconds with clean teardown. Both
changed source/test files passed `vp check --fix` without warnings or errors,
and backend TypeScript checking passed. Cases cover the exact released response shape, hash/expiry/owner
preservation, unknown authentication age, two-instance import and refresh,
rotation versus re-import, revoked-source rollback, deleted sessions/users,
reset/logout and delayed-import races, immutable boundaries, ambiguous hashes,
malformed records, immutable input snapshots and transactional fault injection.
Independent review then found that keeping the epoch in expiring verification
records allowed cleanup followed by a caller-supplied later cutover to reopen
imports. The permanent metadata table and a regression that executes the real
stock cleanup address that finding. New first-import rollback and source-clock
regressions join the original cases. Independent re-review reran all **29 cases**
successfully with clean teardown and approved the fixes. The parent prototype
gate still requires the remaining compatibility and operational evidence.

A later joined review found that an actual non-legacy canonical sign-out left
unknown user-only old sources able to create a new session. The admission-only
history guard above and five additional regressions address that integration.
The expanded **34-case suite passed** against real Postgres in 3.76 seconds with
clean teardown, and both changed files again passed lint/type-aware checking
without findings. The follow-up covers real canonical sign-out, surviving known
bindings and sibling sessions, missing/expired history, handler recreation and
stock cleanup. Independent re-review included all **34 cases** in the final
**163-case** source-denial/origin suite, which passed in **12.68 seconds** with
clean teardown. The reviewer approved the admission-only guard and surviving
mapped-session behavior; selected final checks passed without findings.
