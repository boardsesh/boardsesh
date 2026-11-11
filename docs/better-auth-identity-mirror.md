# Identity mirror (BA-04 PR 7)

The backend's `AUTH_IDENTITY_MIRROR` selector accepts `off` (default) or `on`.
Unknown values fail closed. `off` adds no mirror queries and leaves the existing
identity, credentials, sessions, and authentication age unchanged.

**Production activation remains blocked in code, with no environment bypass.**
The backend refuses startup with `on`. The existing web set-password endpoint
still writes credentials directly and has no backend-owned fresh-auth command.
BA-04 PR 9 must implement that command and web delegation, then prove every
staged writer mode and the database writer fence before removing this gate.
Turning the fence on and breaking the live web flow is not mirror coverage.
No activation, route mount, import, bridge, or writer switch occurs here.

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
| Legacy web registration/reset/provider writers | Must be delegated and fenced before activation; startup gate remains closed |
| Web set-password | PR 9 activation blocker: backend fresh-auth command and delegation required |

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
function-level mirroring selected. The production startup gate is not bypassed
or disabled. Each fixture uses its existing checkout-scoped worker database;
there is no shared infrastructure setup or service restart. Generated migration
0305 supplies the canonical tables in the shared fixture. Restricted backend
command actors receive only the extra source-read and canonical-table grants
they require; fenced legacy/read-only web actors receive no canonical access.
These are synthetic test grants, not production grants or fence evidence.
