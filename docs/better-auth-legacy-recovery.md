# BA-01 legacy recovery compatibility proof

This disposable proof supports [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975),
BA-01 (#6976) and the recovery work in BA-03 (#6977). The
[implementation ledger](./better-auth-implementation.md) owns delivery status.
Nothing in this proof mounts a production route or changes existing links.

## Existing link contracts

| Purpose | Current stored identifier | Current stored secret | Validity |
| --- | --- | --- | --- |
| Password reset | `password-reset:<email as stored>` | SHA-256 of the UUID sent in the link | One hour |
| Email verification | Email as stored | Raw UUID sent in the link | 24 hours |

These formats come from the current web forgot/reset-password, registration,
verify-email and resend-verification routes. Their `verificationTokens` table
contains no original user ID or issuance timestamp. The existing reset flow
checks the token before its write transaction and resolves the account again by
email. Since BA-02 PR 1 both flows look the address up with the shared rule
(exact first, then one row in other capitals, never a pick among several) and
write by that one user ID; forgot and resend now key the link on the address as
stored rather than as typed. Links issued before that keyed on the typed text,
which always equalled a stored address. The prototype must not copy those
ownership and concurrency assumptions.

## Decisions and security boundary

The importer requires an immutable server-held mapping to the original user ID,
supported by captured issuance evidence or separately verified ownership
resolution. A current email match alone does not manufacture that history.
Normalized collision groups, missing/conflicting evidence, changed owners and
malformed records reject. The importer reports only accepted/rejected counts.
Actual historical links without sufficient ownership evidence remain an
explicit production readiness gate; the synthetic fixtures do not resolve them.

Accepted links become purpose-prefixed records in the canonical Better Auth
verification table. Their lookup key hashes the purpose, normalized address and
old stored secret. Their value contains the bound user ID and address, proof
source and consumption state; it contains no presented secret. Original expiry
is immutable. Re-import cannot extend it or replace consumed/superseded state.

The original legacy rows remain untouched. A production deployment must fence
old writers and old consumption handlers before this authority can safely own
those links. The cooperative prototype advisory lock is not that writer fence.

The acceptance horizon is bounded to the original one-hour or 24-hour lifetime
after cutover, and expiry is checked again at consumption. The actual boundary
is recorded once under the `legacy-recovery` key in the separate, non-expiring
`prototype_auth_migration_epoch` table. Import, consumption and supersession
require that same boundary under the lifecycle fence. Ordinary expired
verification cleanup cannot erase it, and handler recreation cannot choose a
later date to admit a record rejected by the original horizon. A future boundary
is rejected. The boundary is migration metadata, never authentication age.

The importer copies source users, ownership evidence and record dates before
awaiting the fence; a caller cannot change an in-flight snapshot into an accepted
one. A facade likewise captures its boundary when constructed rather than
retaining a caller's mutable Date object. User/purpose
supersession markers are independent of a caller-selected migration date and
last at least the maximum remaining legacy lifetime. They block late imports of
links not previously seen by the new authority. A credential mutation extends
marker retention monotonically. The markers deliberately remain separate from
ordinary sign-out cutoffs: logging out should not destroy a valid mailbox
recovery link.

## One credential authority

Reset consumption runs under the same lifecycle fence and Postgres transaction
as canonical credential changes. A validated old secret is translated into an
ephemeral, user-ID-bound Better Auth reset record. The public
`auth.api.resetPassword` operation owns password validation, bcrypt hashing,
credential creation/update and token consumption. Its reset hook invokes the
same account revocation helper used by the other prototype adapters.

There is no second password writer or copied password policy. Invalid new
passwords leave the old link retryable; leading/trailing spaces and Unicode in
valid passwords are preserved. A successful reset preserves the original user
ID, marks inbox control verified and invalidates native descendants. A
post-mutation injected failure rolls back the password, verification update,
link consumption, supersession markers and revocation cutoff together.

For verification, a narrow server-only plugin uses the documented plugin
context's `internalAdapter.updateUser` operation with the already-proven user
ID. It never resolves the email to a different user. An existing verification
timestamp is retained; ordinary canonical sessions remain usable. This avoids
the stock verification endpoint's email lookup while keeping the canonical
adapter responsible for identity updates. The plugin is created only inside
the disposable service and is not exposed through a product router.

The credential-mutation helper must invalidate both imported reset and
verification purposes. The service's own reset and the shared canonical reset
path are joined in regression tests; ordinary logout uses the separate path
that retains recovery links. This does not prove unimplemented production
change/set-password, provider-link or administrative mutation paths.

## Reproduce and review

Run the suite against a disposable local Postgres administrator:

```sh
AUTH_PROTOTYPE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:15475/postgres \
  vp test run --config packages/backend/vite.auth-prototype.config.ts \
  legacy-recovery.test.ts --reporter=agent
```

The proof uses two separately created facades over the same database and real
Better Auth/Drizzle operations. Coverage includes the original hash/raw formats,
normalization, single-use races, expiry, supersession, restart/re-import,
wrong-secret and cross-purpose/account failures, changed/deleted original
owners, canonical-reset invalidation, ordinary logout, password validation and
transaction rollback.

Initial validation on 2026-11-04: all **28 recovery integration tests passed** against
Postgres on the dedicated local port 15475 (10.40 seconds). An independent
reviewer re-read the service, state helper and shared reset hook, then separately
ran all **28 cases successfully** (10.57 seconds). The new files also passed
`vp check --fix`, backend TypeScript checking and `git diff --check`.

Review found two actionable gaps before acceptance: a canonical reset initially
did not invalidate imported links, and a supersession marker keyed by the
caller-selected cutover date could be bypassed with another date. The shared
credential-mutation hook and stable user/purpose markers resolve those findings.
Joined tests exercise canonical reset against both purposes and a late import
racing that mutation; separate tests preserve valid links through ordinary
logout. The original-owner evidence and production writer/consumer fence remain
blocking requirements for real historical links.

Further review found that a caller-selected later boundary could reclassify a
never-imported, originally overlong link. The permanent migration epoch closes
that configuration gap. Added regression cases exercise actual Better Auth
expired-record cleanup, a changed boundary after rejection, future dates, Date
mutation while waiting for the fence, and changing invalid ownership evidence
while an import is queued. The hardened suite passed **34 integration tests**
on the same dedicated local Postgres instance (10.70 seconds); its changed
TypeScript files passed `vp check --fix`. Independent review of this hardening
is recorded separately in the parent ledger.

The code does not implement a public forgot-password issuer, mail delivery,
rate limits, CORS, browser/deep-link routing, anti-enumeration timing, restored
production ownership reconciliation or a database-enforced writer fence.
Those remain acceptance work; passing these synthetic tests does not complete
BA-03 or authorize production migration.
