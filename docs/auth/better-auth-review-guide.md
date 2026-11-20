# Better Auth implementation review guide

This is the review entry point for [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975). Updated 2026-11-20. The accepted direction is in [better-auth-migration.md](better-auth-migration.md). Every switch and the order to turn them on is in [better-auth-rollout.md](better-auth-rollout.md). **No production authority switch, identity backfill, account merge, account deletion or production grant change has been performed. The epic and every child issue except BA-01 remain open.**

The [acceptance ledger](better-auth-implementation.md#acceptance-ledger)
separates merged code, open PRs and remaining closure evidence for every child.
Only BA-01 is closed because the later issues include deployment, restored-data
rollback and real-device criteria. Partner Stage A allowlist is [recorded live
since November 17](https://github.com/boardsesh/boardsesh/issues/7430#issuecomment-6950404188),
with terms, API domain and developer gating merged. This does not activate the
first-party authority. Phase A and Phase B are built behind
`AUTH_BROWSER_SESSION_MODE`; #7880 emptied the backend and www cutover blocker
lists. The [browser-session contract](better-auth-browser-session.md#status)
records the remaining owner preconditions and physical/browser acceptance.
An empty code blocker list does not activate production.

BA-05 was re-scoped on 2026-11-16 by [#7596](https://github.com/boardsesh/boardsesh/issues/7596). Its design is in [better-auth-browser-session.md](better-auth-browser-session.md). Docs carrying a "Superseded by #7596" banner describe historical browser binding decisions whose implementation has been removed. The [publication investigation](better-auth-session-publication.md) retains the race characterization; its superseded decisions do not override the replacement design.

## Review by responsibility

Earlier slice PRs were consolidated into main. Their historical readiness,
commit hashes and repeated local test totals are not current acceptance
criteria. Use the implementation ledger for delivery status and these notes
for contracts and deliberate limits:

| Responsibility | Review references |
| --- | --- |
| Identity writers and lock order | [Writer inventory](better-auth-writer-inventory.md), [fixed system-owner order](better-auth-fixed-system-owner-order.md), [board owners](better-auth-system-board-owner.md), [batch jobs](better-auth-batch-system-users.md), [location preparation](better-auth-location-batch-preparation.md) and [location adoption](better-auth-location-writer-adoption.md). |
| Account deletion and developer fixtures | [Deletion transaction](better-auth-account-deletion.md), [deleted-account readers](better-auth-deletion-readers.md) and [development seed guard](better-auth-dev-auth-seed-guard.md). |
| Credential and provider writes | [Password recovery](better-auth-password-recovery.md), [UID-bound verification](better-auth-uid-verification.md), [web OAuth identity](better-auth-web-oauth-identity.md), [provider security](better-auth-provider-security-adoption.md) and [App Router OAuth proof](better-auth-app-router-oauth.md). |
| Browser publication and compatibility | [Browser-session design](better-auth-browser-session.md), [publication investigation](better-auth-session-publication.md), [cookie response order](better-auth-browser-cookie-order.md) and [released-client contracts](better-auth-released-client-contracts.md). |
| Operator qualification and rollback | [Rollout order](better-auth-rollout.md), [writer fence](better-auth-writer-fence-proof.md), [credential capabilities](better-auth-credential-writer-capability.md), [user-reference catalog](better-auth-user-reference-catalog.md), [identity mirror](better-auth-identity-mirror.md) and [identity import](better-auth-identity-import.md). |

[#7596](https://github.com/boardsesh/boardsesh/issues/7596) replaces the browser
binding, renewal, proof-cookie, lease and coordinator design. B5d removed the
backend binding and anonymous-provider cores, their shared protocols and
`CURRENT_STORE_BROWSER_BINDING_MODE`. The binding tables, grants and
`private-browser-v1` capability profile remain without a schema migration;
retaining those database objects does not retain a runnable binding service. The [removal inventory](better-auth-browser-session.md#what-is-removed-and-why)
identifies that boundary. Older renewed-lineage, session-publication and web
credential notes do not override the browser-session design.

## Decisions to review

**User decision:** an authenticated password set/change keeps the requesting device signed in and revokes other credentials. Forgotten-password reset revokes every session. The current [lifecycle test map](better-auth-implementation.md#current-test-map) covers continuation and revocation; production adoption remains separately gated. Continuation retains original authentication age and expiry.

**Agent implementation decisions:** separate default-off adoption from production activation; never fall back to legacy credential writes after an enabled command fails; reject ambiguous normalized owners instead of choosing one; do not repair incomplete authority while processing a request. Existing accounts are not merged or reassigned.

Deleted or ambiguous email keys remain reserved in the unmounted foundation. This is a safety default for the implementation, not approval of a permanent re-registration or privacy-retention policy. For provider link/unlink, use the [approved security contract](better-auth-provider-security-adoption.md); an older prototype continuation does not override it.

New verification receipts bind to an immutable user ID, purpose, email identity, security generation and original expiry. A harmless same-user case/whitespace change may preserve validity. An unbound live historical link remains unavailable rather than selecting whichever account currently matches its email. Resend keeps generic authoritative responses, including after SMTP failure; unknown SQL/protocol outcomes remain unavailable.

Recovery telemetry uses a conservative agent privacy decision: remove the entire query and fragment of a recognized reset URL, redact detached recovery query collections as a whole, and mask reserved `prN_` capabilities even in standalone message text. This drops reset-page campaign/source attribution along with credentials; URLs without recovery capabilities stay unchanged. It changes reporting payloads, not browser navigation or recovery request semantics. Header and telemetry protections apply to existing legacy links as well as staged UID-bound links.

Installed native registration retains immediate sign-in, including when web verification is enabled. Lost registration replies never trigger compensating account deletion or automatic command retries. The mobile body-read failure after received 201 headers is documented as an existing thrown error; it is not a proof of unknown commit acknowledgement before headers.

## Evidence and limits

The [current test map](better-auth-implementation.md#current-test-map) identifies
live suites. The removed BA-01 prototype's measurements and earlier stack
qualification are available in Git history and their PRs; they do not establish
current-head test results or deployed readiness.

Owned local database, restricted-role, signing and socket tests establish their
stated implementation boundaries. They do not prove deployed IAM, real
keychain/device behavior, provider setup, SMTP/ingress behavior or
restored-database rollback. The App Router compound/continuation fixtures are
synthetic, not mounted production behavior. Stock email linking, verification
mutation and Apple actor-cookie loss remain migration requirements.

Recovery header and telemetry protection applies to legacy and staged links,
but first-hop coverage remains a release requirement: the recovery note records
trailing-slash 308 headers and development-renderer cache behavior as limitations.
Canonical-page assertions alone do not close that gate.

Migration numbers and test totals in older slice notes describe their recorded
checkout. Use the checked-in migration journal and current source for present
identities; historical clean replay or a local preview does not qualify a
production cutover or restored-database rollback.

## Remaining activation gates

1. Adopt every current credential/security writer, including OAuth creation/link/unlink, recovery, password changes, deletion and jobs. A manifest flag is not a database or issuer fence.
2. Establish fresh, read-only production collision evidence and verified ownership resolutions before final email uniqueness. No merge, deletion or owner reassignment is authorized.
3. Make HTTP, WebSocket, cookie, native/watch, refresh and offline consumers enforce one revocation and lineage authority, including outages and races between verification and issuance. A returned password verdict is not continuing session authority.
4. Prove every historical recovery/verification issuer and deadline, capable-reader retention, actual production roles, delivery/origins, provider registrations, mobile/watch compatibility and mutation-safe restored-database rollback.
5. Complete first-party acceptance independently from partner OAuth registration, consent, token families and Disconnect. Retire NextAuth only after those first-party gates; retain the installed-client compatibility API.

The [native OAuth follow-up](better-auth-native-oauth.md) records that released iOS clients attempt browser fallback after any non-cancelled native failure, including conflicts and outages. Endpoint-only native adoption cannot establish end-to-end collision or writer safety while that fallback reaches the existing web OAuth writers. No client update or silent fallback removal is assumed. Its low-level mobile proof invokes `oauthNativeSignIn` and the real auth-store directly; SDK wrappers, nonce generation and device behavior remain distinct from that HTTP/storage proof.
