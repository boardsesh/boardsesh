# Default web password proofs before authority enforcement

This BA-03 prerequisite moves the default web password check into the backend without activating identity authority. It authenticates the actual submitted password; it never manufactures authentication age from a bridge, copied hash, SID or JWT issuance time. Registration, recovery, set-password, provider adoption and historical issuer retirement keep their own gates.

## Deployment boundaries

1. Deploy the backend `/api/internal/auth/current-store/password/v1/authenticate` endpoint first. It accepts only authenticated private RPC, mandatory credential-proof version 1, and an absent or prepared current-store manifest. It sends no public credentials or mail and creates no canonical session.
2. Deploy the dependent default web adapter only after the intended backend, RPC secret, dedicated credential database/profile, signing-key compatibility and real ingress configuration are evidenced. The default password path delegates even while `CURRENT_STORE_WEB_AUTH_MODE=legacy`; it never compares locally or rereads generation as a fallback. An old backend, missing configuration or uncertain reply is unavailable, with no retry.

The existing explicitly staged endpoint remains qualified against enforced authority. This family does not opt into staging, change a mode, enforce a projection or import an identity. Prepared reservations remain snapshots. The command captures the absent/prepared context before bcrypt and revalidates it under the shared gate in its final transaction.

The backend requires the existing distinct `CURRENT_STORE_AUTH_RPC_SECRET`, `AUTH_IDENTITY_DATABASE_URL` and exact current `private-registration-v1` profile (or an explicitly reviewed compatible descendant). Existing grants suffice; there is no migration or grant expansion. It refuses unsafe SQL logging and cutoff `observe`. Web additionally needs the explicit `CURRENT_STORE_AUTH_BACKEND_ORIGIN`. No production settings are changed here.

## Password and proof contract

The snapshot uses the released web address rule: exact stored spelling first; otherwise one normalized candidate. Multiple exact rows are compared as a bounded cohort and exactly one password must match. OAuth-only members remain in the cohort inventory. Literal percent/underscore characters are never wildcards. Native's LOWER-only lookup is unchanged.

Passwords are passed unchanged to bcrypt: no trimming, Unicode normalization, registration-length policy or rehash. The snapshot captures candidate UID, address, hash, generation and deletion state in one statement. Bcrypt runs outside a transaction. The final transaction takes the shared gate and candidate users rows `FOR KEY SHARE`, then a separate READ COMMITTED statement rereads the entire cohort. It refuses drift and reads the selected account's current email-verification state.

The mandatory proof carries the captured generation, fresh legacy login SID and database authentication clock from that actual password check. It cannot have unknown authentication time or carried-login provenance. The existing staged optional/global-mode wrapper retains its contract. The only durable auth write here is the command nonce: no password/evidence write, cutoff increment, refresh token, security mutation or canonical session is created.

A qualified generation-advancing reset that wins before the locked recheck refuses the stale password snapshot. A proof committed before such a reset keeps its original generation through web JWT construction. The real default NextAuth route buffers emitted cookies through `withAuthResponseAdmission`, which admits the exact JWE against current primary state before publishing any headers. A moved generation is denied without cookie writes or clears; authority uncertainty is unavailable. A qualified generation-advancing reset after publication is enforced on the next admission read. Cookie rotations retain the original authentication time. The default legacy reset writer does not yet advance the cutoff generation; its adoption and full reset revoke-all closure remain separate work.

## Bounded work and uncertainty

The endpoint retains the existing 10 rejected passwords per client per minute, 180-attempt unattributed budget, exact non-rejection refunds and account-guess settlement. Only the authenticated web facade supplies a Cloudflare-vouched address. The new endpoint's limiter caps underlying Redis operations at four, including refund HDEL; a 100 ms wait timeout does not release their capacity. The existing staged limiter policy is unchanged.

One process work slot covers pool qualification/acquisition, both snapshots and sequential bcrypt comparisons. The queue holds at most 16 commands for 2500 ms. A seven-second command response deadline cannot release the active slot before its real promise settles. Remaining-budget checks reject late work before subsequent transactions and completion; PostgreSQL transaction and statement timeouts use at most five seconds or the remaining budget. Pending pool/qualification uncertainty remains in custody rather than becoming an abandoned retry. An unknown committed acknowledgement can leave only a consumed command nonce, never permission to issue another proof automatically.

## Qualification limits

`vp run test:password-login-backend` drives real authenticated loopback HTTP and the restricted credential LOGIN against a guarded copy of the fully migrated synthetic PostgreSQL fixture. It exercises absent/prepared contexts, exact and duplicate cohorts, raw passwords, DB authentication time, drift after actual bcrypt, observed user-lock waits, replay, role/configuration failures and exact refunds. Explicit fixture hash/generation changes test snapshot drift; they are not described as execution of a password-reset route.

The dependent web proof must additionally drive the real public NextAuth route and final emitted-cookie admission. Its reset race must identify actual qualified reset execution separately from fixture-only state mutations. Full deployment readiness still requires actual backend/reader/issuer coverage, old-issuer retirement, remaining recovery/provenance gates and the owner rollout evidence. Source tests cannot establish those external facts.
