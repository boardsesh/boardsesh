# First-party authority module (BA-04 PR 6)

`packages/backend/src/auth/authority/authority.ts` constructs a Better Auth
instance against a caller-owned Drizzle transaction. It has no production
imports or mounted route. Deploying the module adds six empty tables; it does
not import identities, mirror credentials, issue replacement sessions, change
any `CURRENT_STORE_*` selector, or enable the authority switch. The activation
gates in the BA-04 plan and owner runbook #7430 still apply.

The first-party instance has no OAuth Provider plugin. Partner OAuth remains
its separate existing instance. Better Auth and its Drizzle adapter already
ship as backend runtime dependencies, so this slice changes no dependency or
lockfile.

## Existing users mapping

The adapter's `user` model points directly at the existing `users` table. There
is no `auth_user` copy. The boundary translates nullable `name` to an empty
string only in Better Auth results; it does not rewrite the stored name.

The public Better Auth model uses boolean `emailVerified`, while the adapter's
storage metadata describes the existing nullable timestamp. Reads map NULL to
false and a timestamp to true. Explicit false writes store NULL. Explicit true
updates use `coalesce` to retain the exact original verification timestamp,
only assigning the transaction's current timestamp when the column was NULL.
Boolean verification predicates become timestamp nullability predicates. This
prevents Better Auth's default-false creation rule from writing a boolean into
the timestamp column. Nonboolean writes are rejected before SQL.

Non-normalized stored email rows are refused when read. Writes require trimmed,
lowercase addresses. This is a fail-closed compatibility proof, not a
normalization tool or a replacement for BA-02's collision-resolution and unique
index gate. It must remain unmounted until those gates and the later writer
protocol are complete. Bcrypt verification compares the supplied password
without trimming or Unicode normalization; stored bcrypt strings remain intact.

## Transaction and deletion contracts

The factory requires an `AuthorityTransaction` handle. Adapter transaction
callbacks reuse that handle, so Better Auth cannot independently commit nested
work. The eventual caller must acquire the authority gate and user locks in
BA-04 order before calling it, keep all identity/session work inside that
transaction, and publish response credentials only after commit. This slice
does not mount a request wrapper or claim those later issuance guarantees.

`auth_account` and `auth_session` reference `users.id` with cascade deletion.
`auth_verification` is a token store without a user foreign key.
`auth_credential_lineage`, `auth_session_denials`, and `auth_migration_epochs`
have no foreign keys; deleting a user cannot erase revocation evidence.
Migration 0305 creates only these six tables, their indexes, and the two
cascade constraints. The generated snapshot changes no existing table.

## Proofs

Run `vp run test:auth-authority`. Every suite creates a fresh, randomly named
localhost database, applies the backend users fixture plus the generated 0305
migration, and drops only that owned database. It does not use the shared
backend test database or restart any service. CI runs this proof separately
from the shared backend fixtures, with at most two workers.

The actual-users suite covers exact bcrypt bytes, NULL names, unverified
signup, timestamp preservation across sign-in and explicit updates, boolean
filters, nonboolean-write rejection, mixed-case-row rejection, canonical
session reads, expiry and sign-out, wrong-password refusal, caller rollback including adapter transactions,
cascade deletion with surviving evidence, and fully initialized instance
construction averaging under 5 ms across 100 requests. The prototype's native
and legacy lifecycle adapters remain prototype-only; production bridge and
native issuance adoption belong to later BA-04 slices.

Rollback removes the unmounted code and leaves the unused additive tables.
No production database access or writes are part of this proof.
