# Public NextAuth4 callback and compound backend identity proof

This is an unmounted BA-03 capability proof. The public `signIn` callback can call one backend command that creates the user, profile, email reservation and provider link in one PostgreSQL transaction. NextAuth's subsequent account lookup then follows its existing linked-account path with mutation-denying adapter methods. Production web writers, cookies, routes, provider registrations and authority are unchanged.

The fixture lives entirely under `packages/backend/src/auth/current-store/__tests__/`. It loads only the public exports `next-auth` and `next-auth/jwt` from the web package's pinned NextAuth **4.24.15**. It calls the public Pages API handler overload through a real loopback HTTP listener; it does not host or import private NextAuth core. The application's App Router wrapper and deployed ingress are separate adoption gates.

## Proven ordering and its consequences

The installed package's `core/routes/callback.js` verifies the provider callback, reads `getUserByAccount`, then calls public `callbacks.signIn`. After that hook succeeds, `core/lib/callback-handler.js` decodes the incoming cookie, looks up its actor and reads the provider owner again. The second lookup can therefore find the identity atomically committed by the backend hook. The actual handler tests exercise discovery, authorization, PKCE, state, nonce, token exchange, JWKS verification and callback HTTP; the private source files are evidence about ordering, not imported execution APIs.

The first lookup supplies either a stored user or a provider profile to `signIn`. Its `user.id` is never actor evidence. The fixture captures the incoming cookie in a per-request closure, and the backend verifies that cookie's lineage and owner before writing. Ordinary sign-in accepts a previously linked subject with no actor or the same actor. A different actor, or an unlinked subject with any current actor, fails before identity writes. Full explicit linking is unimplemented; there is no implicit email takeover or link intent.

Because the backend precreates the link, NextAuth reports `isNewUser: false` even for a newly created user. Backend `createdUser` and immutable creation time are returned over the authenticated compound response and carried by the request-local JWT callback. The actual cookie reports the correct creation outcome. Concurrent existing-user and new-user callbacks prove that neither identity nor outcome crosses requests. Adapter create/update/link/delete/session methods deny writes; create-user and link-account events also deny unexpected profile/link writes.

For an existing linked provider subject, changed or missing provider email leaves the stored owner, email and verification time intact. New users use the foundation's JS-normalized reservation and reject another owner's address or an ambiguous/retired reservation. New fixture OAuth users deliberately retain `emailVerified: null`, matching stock NextAuth's new OAuth-user initialization. This proof does not decide a new production verification policy or reproduce all provider-specific product callbacks.

## Backend authority and replay records

The compound command crosses real HTTP to a separate loopback backend listener with a random synthetic bearer secret checked in constant time. Both listeners run inside one test process; this does not prove separate-process key isolation or deployment trust. Body size, HTTP requests and sockets have deadlines. Only the allowed command fields are accepted; clients cannot supply an owner ID. The backend independently verifies the OIDC ID-token signature, issuer and audience against its configured local provider. Nonce, PKCE and state were already checked by NextAuth before its hook runs. The authenticated web caller is trusted to invoke this command only after those checks; this is not a public ID-token exchange API or a production service-auth design.

A shared PostgreSQL transaction advisory lock serializes fixture admission, protected validation, password reset and deletion. The compound command consumes a hash of provider plus verified callback state, reserves email for a server-generated user ID, creates user/profile/provider rows and writes both receipts atomically. Two independently valid provider codes for the same state can reach two public callbacks, but only one flow is admitted. A random command ID by itself would not provide this property.

Only existing tables are used. Test schema materialization selects the generated `sessions` and `verificationTokens` DDL from migration `0016`; there is no new production schema or migration:

| Existing table | Fixture namespace and contents | Lifetime |
| --- | --- | --- |
| `sessions` | `ba03-lineage:` plus SHA-256 of a signed backend source proof; immutable owner and exact proof expiry | Cascades on user deletion; exact-source abort deletes it |
| `verificationTokens` | `ba03-flow:` plus hashed verified flow; token is SHA-256 of the proof | No users FK; retained after abort/deletion and for at least the whole signed-state/source replay window |

Neither table stores a raw provider code, state, cookie, signing key or token. Existing account rows store the provider subject needed for linking, but omit access/refresh/ID tokens in this proof. Flow rows are retained after abort/deletion so a second valid code cannot reopen the consumed attempt. The proof does not implement cleanup or a production retention policy.

Test-only operator setup creates uniquely owned, transactionally tracked roles, takes real table locks, revokes the old fixture role's DML and grants the new fixture role. Backend writes run under `SET LOCAL ROLE` for the new role; the old role demonstrably gets `42501`. This models fixture table capabilities. It does not inventory production memberships, owners, SECURITY DEFINER functions, other writers or issuers. The enforced foundation marker alone is not a fence. Legacy binaries that can read credentials and mint tokens without database writes remain a separate gate.

## Cookie lineage, age and mutation races

The outer cookie is produced and decoded by public NextAuth JWT APIs. It contains a backend-signed source JWT with a distinct purpose, issuer, audience and random key. The source proof binds user ID, source SID, generation, verified flow, fixed expiry and original authentication age. A signed JWT is readable if exposed; it is not an encrypted token. Its key/purpose cannot authenticate as an OIDC ID token or as the outer NextAuth cookie.

The fixture `/protected` endpoint requires all of: valid outer cookie; valid source signature and purpose; exact user/SID agreement; exact hashed source receipt and expiry; matching flow receipt; surviving user; and current cutoff generation without deletion. It checks the deadline after asynchronous reads. Changing receipt ownership or extending its expiry fails closed. Reset and deletion use the foundation security mutation in the same transaction as the actual bcrypt credential write or user deletion.

A deterministic barrier resets or deletes the owner **after backend commit and before NextAuth encodes its new cookie**. The resulting outer cookie still decrypts successfully. The protected endpoint rejects it because the backend generation changed or the user/receipt disappeared. A new cookie `iat` or random web SID alone cannot establish valid authority after this race. A final reread before encoding would still leave a race unless validators checked backend lineage.

The fresh post-reset acceptance case starts a new, cookie-less `ProofBrowser`. It proves a new verified flow can receive generation 1 while the old encoded generation-0 source stays rejected. Clearing a stale/revoked actor cookie and the subsequent sign-in/linking recovery experience are not proved. Production adoption must handle that explicitly rather than treating a stale cookie as authenticated link intent.

OIDC `auth_time`, when supplied and valid, is carried unchanged. Missing `auth_time` remains explicitly unknown. Neither ID-token `iat`, RPC time nor new cookie time supplies fresh authentication age. The default one-hour source deadline, and one-second expiry regression, are **fixture-only**. They do not change released web session duration or require hourly login. Production adoption must preserve ordinary rolling sessions through backend-owned renewal while retaining the original authentication age and current generation.

Only public CSRF/sign-in/callback actions and the fixture protected endpoint are exposed. NextAuth session renewal, signout and every production native/watch/web validator remain outside this slice. Keys are random per fixture instance; the single-listener concurrency proof does not establish restart continuity, shared replica keys or rotation operations. A cookie accepted by stock decryption is insufficient; adoption requires all relevant validators to consume the backend proof and a reviewed renewal/revocation implementation.

The fixture protected endpoint maps every validation exception to `401`, including database failures. That is a bounded proof convenience, not a production outage contract. Production database/RPC unavailability must remain retryable unavailability, distinguished from revoked credentials; client logout, account switching and offline-state behavior must not be triggered by that outage.

## Publication and failure decisions

Before-commit faults roll back identity, profile, provider link, reservation and both receipts together. A lost committed HTTP reply publishes no cookie and leaves an identity that a fresh, independently verified flow can use; it does not compensate by deleting a committed account. Its unexposed source receipt expires normally. Cookie-encoding failures revoke only the exact source receipt and keep identity plus consumed-flow evidence. An older sibling session remains valid.

Stock NextAuth wraps `events.signIn` with `eventsErrorHandler`, logs the error and swallows it. Actual stock characterization shows a successful redirect with a usable cookie after the event throws. An event exception is therefore not a rollback or publication policy.

The guarded fixture records its own request-local late failure, buffers the public handler response and calls an authenticated exact-proof backend abort before publishing. It strips newly issued session cookies and reports failure. The cookie captured inside the buffer is also rejected by the protected endpoint because its source receipt was revoked. Abort preserves flow consumption and cannot revoke another SID. This wrapper is proof code, not a production route or a general promise that every NextAuth hook failure is observable.

## Evidence and remaining gates

The primary agent's aggregate typecheck passed **58 tasks**; the final backend
typecheck passed **13 tasks** after the last source fix. Full `vp check` passed
with **0 errors and 623 existing warnings**, and final changed-file checks
reported no warnings or errors. All legacy native suites, the foundation and
this proof passed together: **177 tests in eight files, 21.85 seconds**, on
owned PostgreSQL18.6 infrastructure.

The local OIDC fixture has **16 real HTTP tests**, independently reviewed and rerun: signature/JWKS/audience, client authentication, exact registered redirect, S256, one-use concurrency, actual expiry, two valid codes sharing one state, cancellation/failure, nonce mismatch and historical versus absent authentication time. Independent run: **16/16**, 7.09 seconds total, clean teardown and zero lint warnings/errors.

The author's final PostgreSQL18 run passed **43/43** tests (27 main public-handler cases plus 16 OIDC cases), 14.12 seconds total. The final independent PostgreSQL15 run passed **43/43**, 10.19 seconds total, with clean teardown. Independent source/security/test/schema review approved the bounded proof, and a second independent source/doc reviewer re-reviewed the encoder fix with no remaining actionable finding. The independent reviewer also checked all five changed TypeScript files: zero lint/format warnings/errors and a clean `git diff --check`.

Backend `vp exec tsc --noEmit -p packages/backend/tsconfig.json` passes; this worktree's existing project includes `src/**/*`, including all proof tests/fixtures. `vp exec tsc --noEmit --listFilesOnly -p packages/backend/tsconfig.json` confirmed all four new TypeScript files are included. Focused tests run through `vp test run --config .boardsesh/backend-qa.config.ts src/auth/current-store/__tests__/nextauth-public-handler.test.ts src/auth/current-store/__tests__/fixtures/local-oidc.test.ts --reporter=agent`; the ignored QA configuration selects owned local PostgreSQL18, or PostgreSQL15 with `BOARDSESH_AUTH_QA_PG_VERSION=15`, and a fresh randomly salted worker database.

Additional independent source review identified a failure-observation gap: exceptions in an awaited pre-encode hook or the actual public encoder were caught inside NextAuth before the wrapper observed them. The source-cookie encode path now marks the request failure before rethrowing across that library boundary. Separate regressions use a throwing async hook and an actual public encoder serialization rejection from a cyclic synthetic claim, without mocking the library. They prove exact-source abort and retained flow evidence; a sibling source remains valid. The reset race also verifies the actual stored bcrypt hash and accepts a fresh generation-1 verified flow while continuing to reject the old generation-0 cookie.

This document makes no production activation claim. Remaining work includes configured Google/Apple/Facebook behavior, explicit linking policy, all existing creation/transfer receipts, production trusted transport and App Router handling, mail/password registration plus verification delegation, source renewal and validator adoption, deletion/provider-subject policy, deploy/role fencing, production collision decisions and operational recovery. Deployed service roles, origin/SMTP configuration and credentials have not been established by these local fixtures. No one-by-one NextAuth adapter RPC or distributed transaction lease is introduced.
