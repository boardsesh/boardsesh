# BA-01 canonical verification and resend proof

This is the **new canonical link** proof for
[BA-01 #6976](https://github.com/boardsesh/boardsesh/issues/6976), tracked in the
[implementation ledger](./better-auth-implementation.md). The separate
[legacy recovery proof](./better-auth-legacy-recovery.md) covers already-issued
links and their proven original ownership. This adapter does not import legacy
tokens or replace production routes, email delivery, account data or clients.

## Actual pinned behavior

The implementation uses Better Auth **1.7.17**, its real Drizzle adapter and a
disposable Postgres database. It exercises actual public token production and
authority writes rather than substituting a signature verifier or token encoder.

| Public API or pinned source | Observed behavior |
| --- | --- |
| [`sendVerificationEmailFn`](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/src/api/routes/email-verification.ts) | Real delivered canonical tokens include the original `userId` and lowercased email |
| [`createEmailVerificationToken`](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/src/api/routes/email-verification.ts) | The public producer also permits email-only tokens when no extra user binding is supplied; tests distinguish this compatibility shape from current delivery |
| [Stock `verifyEmail`](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/src/api/routes/email-verification.ts) | Current user-bound tokens reject address reassignment; optional email-only tokens can select the current email owner; no durable single-use receipt is consumed |
| [Signing implementation](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/src/crypto/jwt.ts) | Repeated same-second resend can generate identical signed tokens; issue and expiry time are read separately |
| [Supported endpoint/context APIs](https://better-auth.com/docs/concepts/plugins) | The guarded receipt is created and the bound user is updated through the same authority's public `context.internalAdapter` APIs |

Stock characterization demonstrates successful replay after the fixture's
verification flag is cleared, and identical JWTs from actual same-second sends.
It also shows that `autoSignInAfterVerification: true` can create a fresh session
from mailbox verification. These green characterization tests do not satisfy
the migration's single-use or authentication-age requirements. This proof
disables automatic sign-in and does not infer authentication time from a
verification token.

## Receipt-backed new links

`verification-lifecycle.ts` wraps actual Better Auth issuance with a fresh random
256-bit nonce. The delivered proof URL contains the signed library token and
that nonce. The existing `verification` table stores their combined SHA-256
digest and an immutable receipt containing:

1. Original application user ID and intended normalized email.
2. The explicit `verify-current-email` purpose.
3. Original signed issue and expiry seconds.
4. Consumption and supersession state.

Neither the token nor nonce is stored in the receipt. Redemption requires the
real HS256 signature, required user/email/time claims, a matching receipt,
unchanged exact expiry, the correct purpose and a currently unambiguous owner.
Email-change and other-purpose claims are rejected. A request cannot supply a
different owner or substitute an email-only token.

The adapter updates the original user ID through
`context.internalAdapter.updateUser`; it never chooses a new owner from the
first current email match. Configured `beforeEmailVerification` and
`afterEmailVerification` policy hooks run around that write inside the same
transaction. Their user objects are snapshots: the owner/address are captured
from the receipt before any hook await. Mutating a hook's supplied user object
cannot redirect the write. The final persisted owner/address and verified state
are checked before success.

The imported `legacyEmailVerifiedAt` value is left unchanged, including null.
The receipt's `consumedAt` records when this new mailbox proof was used. A new
verification does not fabricate a historical imported timestamp.

## Identity and lifecycle decisions

Anonymous send/resend returns the same success shape for an unknown, verified or
ambiguous address. The prototype applies a 500 ms minimum send-response floor.
Authenticated foreign-address requests reject uniformly before an existence
lookup. These are fixture results, not a production timing-resistance claim.

Both issuance and redemption use the exact shared
`normalizeAccountEmail` JavaScript policy. The prototype scans its complete,
controlled fixture user set before choosing an owner. SQL `lower(btrim(email))`
is deliberately not used: it does not match JavaScript trimming for TAB, NBSP
and other historical inputs, and Unicode lowercasing can differ. Mixed-case,
TAB and NBSP collision tests prove that neither issuance nor redemption picks
an arbitrary exact row. Production indexed lookup and normalized reservations
remain the BA-02 gate; this scan is not a production implementation.

Resend supersedes older unconsumed receipts even if the signed JWT is identical
in the same second. Nonce collision checks retry without overwriting a receipt;
exhaustion or cancelled authority receipt creation rolls back supersession and
publishes no new link. Two independently created handlers share the lifecycle
fence, so concurrent redemption has one winner and concurrent resend leaves only
the latest committed receipt usable.

Credential mutation invalidation is shared with `revokePrototypeUser` only when
its compromise/credential flag is true. Password set/change and forgotten reset
supersede existing canonical receipts. A newly issued post-mutation receipt
works normally. Ordinary account sign-out preserves valid mailbox proofs and
does not sign the user back in when they redeem one.

Changed, reassigned or deleted identities fail closed. Opening a valid link while
another account is signed in does not switch accounts or consume the intended
owner's proof. Existing old/unknown-age sessions retain their ID and original
age; freshness-gated operations remain unavailable. No session or password
credential is created by verification.

## Encoder allowance is separate from expiry

Nominal verification lifetime is **3,600 seconds**. The actual pinned producer
uses constructor time for `iat` and a separate `Date.now()` read for `exp`.
Second boundaries or scheduling pauses can therefore increase `exp - iat`.
The named **60-second encoder-read allowance** accepts actual producer output
with 1-second and 60-second gaps and rejects a 61-second gap before publication.
Only the clock reads are controlled in these tests; the public producer and
signatures remain real.

This allowance does not add expiry grace, infer authentication age, or extend a
link during redemption. The receipt retains the exact original signed `exp`;
redemption immediately after that boundary fails. Mutating a delivered Date
object cannot change the stored horizon. Malformed server-produced issuance is
a server failure with rollback; an invalid presented proof is a client rejection.

## Publication, rollback and delivery limits

The actual verification JWT is produced, validated and recorded while holding
the shared lifecycle fence in one Postgres transaction. Fixture delivery starts
only after commit. A regression immediately redeems the delivered link from
another instance, proving it is not observing an uncommitted receipt.

Unsuccessful operations roll back user state, receipt consumption and resend
supersession. Failed responses strip pending cookies. Tests cover a cancelled
public user update, policy-hook rejection, failure after the authority update,
nonce exhaustion, false receipt creation and requests whose caller-owned headers
change while waiting for the fence.

The callback is a synthetic publication boundary, not a real email transport or
durable outbox. A failed post-commit fixture callback does not undo committed
state or expose account existence in the response; resend can issue a new link.
Production delivery needs an outbox, retries and operational evidence. Arbitrary
external side effects inside application hooks cannot be rolled back by Postgres.

## Validation and remaining gates

```sh
vp check packages/backend/src/auth/prototype/verification-state.ts packages/backend/src/auth/prototype/verification-lifecycle.ts packages/backend/src/auth/prototype/__tests__/verification-lifecycle.test.ts packages/backend/src/auth/prototype/legacy-bridge.ts
AUTH_PROTOTYPE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:15475/postgres vp test run --config packages/backend/vite.auth-prototype.config.ts --reporter=agent verification-lifecycle
vp exec tsc --noEmit --project packages/backend/tsconfig.json
```

Final author validation passed **41/41 in 26.55 seconds**. Independent review
reran all **41 in 25.78 seconds**, with clean teardown and selected checks.
The normalization, encoder-read and policy-hook findings were fixed and
re-reviewed; no actionable finding remains in the documented fixture scope.
Combined validation is recorded in the implementation ledger.

No production uniqueness constraint, email-change
workflow, provider linking, universal credential-writer boundary, delivery
outbox, browser/deep-link UI, restored-production rehearsal or rollout is proved
by this adapter. Its new receipt URL must be adopted deliberately; it does not
silently reinterpret an old recovery URL or expose the stock stateless verifier.
