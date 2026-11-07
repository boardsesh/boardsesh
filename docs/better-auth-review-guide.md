# Better Auth implementation review guide

This is the review entry point for [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975). Updated 2026-11-05. The accepted direction is in [better-auth-migration.md](./better-auth-migration.md). **No production authority switch, identity backfill, account merge, account deletion or production grant change has been performed. The epic and its child issues remain open.**

## Review order

| PR | What is ready to review | Dependency and current status |
| --- | --- | --- |
| [#7280](https://github.com/boardsesh/boardsesh/pull/7280) | Isolated Better Auth 1.7.17 migration, legacy credential and OAuth lifecycle proofs | Based on main; ready, CI passed; no production handler adoption |
| [#7282](https://github.com/boardsesh/boardsesh/pull/7282) | Existing native password policy extracted into the backend service | Based on main; ready, CI passed |
| [#7283](https://github.com/boardsesh/boardsesh/pull/7283) | Generated reservation, projection, cutoff and security-event foundation | Based on main; ready, CI passed; no activation/backfill |
| [#7284](https://github.com/boardsesh/boardsesh/pull/7284) | Public NextAuth callback delegation proof using real HTTP and OIDC | Stacked on #7283; ready, CI passed; test fixtures only |
| [#7285](https://github.com/boardsesh/boardsesh/pull/7285) | Default-off web registration and password delegation | Stacked on #7284, includes #7282; ready, CI passed |
| [#7286](https://github.com/boardsesh/boardsesh/pull/7286) | Default-off UID-bound verification and resend | Stacked on #7285; ready, CI passed; cloud review found no issues |
| [#7287](https://github.com/boardsesh/boardsesh/pull/7287) | Independently opted-in native registration reservations | Stacked on #7286; ready, CI passed; cloud review found no issues |

These are unmerged review candidates. The separate proof branch is not a production credential authority. The latest current-store branch contains the preceding implementation notes; #7280 carries its own detailed proof ledger, [better-auth-implementation.md](https://github.com/boardsesh/boardsesh/blob/feat/6975-better-auth/docs/better-auth-implementation.md).

## Decisions to review

**User decision:** an authenticated password set/change keeps the requesting device signed in and revokes other credentials. Forgotten-password reset revokes every session. The isolated prototype proves atomic replacement while retaining original authentication age and expiry. Current production password routes have not adopted this policy yet.

**Agent implementation decisions:** separate default-off adoption from production activation; never fall back to legacy credential writes after an enabled command fails; reject ambiguous normalized owners instead of choosing one; do not repair incomplete authority while processing a request. Existing accounts are not merged or reassigned.

Deleted or ambiguous email keys remain reserved in the unmounted foundation. This is a safety default for the implementation, not approval of a permanent re-registration or privacy-retention policy. Source-bound provider link/unlink continuation is likewise a prototype decision, not a new user-approved account policy.

New verification receipts bind to an immutable user ID, purpose, email identity, security generation and original expiry. A harmless same-user case/whitespace change may preserve validity. An unbound live historical link remains unavailable rather than selecting whichever account currently matches its email. Resend keeps generic authoritative responses, including after SMTP failure; unknown SQL/protocol outcomes remain unavailable.

Installed native registration retains immediate sign-in, including when web verification is enabled. Lost registration replies never trigger compensating account deletion or automatic command retries. The mobile body-read failure after received 201 headers is documented as an existing thrown error; it is not a proof of unknown commit acknowledgement before headers.

## Evidence and limits

The isolated migration proof has 702 cases across 28 files, independently checked on PostgreSQL 15.17 and 18.6; its own browser run passed four cases. All seven published branches combined automatically without conflicts, manual resolutions or lock regeneration: 278 backend cases, all 702 isolated proofs, 15 framework/header cases and 60 typecheck tasks passed. The type check had no cache hits. Browser runtime was not repeated in that combined run.

The native reservation slice adds 22 backend cases and nine tests invoking actual mobile registration and auth-store code, with native host and SecureStore I/O substitutes. Its final regression selection covers 278 distinct cases across 13 files; the new/shared 85 and actual-mobile nine pass on both PostgreSQL versions. Both independent final reviewers approved it. Full type checking passed 59 tasks and final backend checking passed 13. One default-concurrency attempt aborted in the Rust task runner; the originating task passed alone and the full graph passed at concurrency two. Repository lint has zero errors and 623 existing warnings.

These tests exercise owned local databases, restricted fixture logins, actual HTTP, real signing, rollback and selected consumer logic. They do not prove deployed IAM, real device/keychain behavior, production provider setup, SMTP/ingress behavior or restored-database rollback. Ordinary salted backend worker databases are retained by the shared harness; normal fixture teardown closes owned roles, listeners and child processes. See each slice's note for exact measurements and deliberate counterexamples.

## Remaining activation gates

1. Adopt every current credential/security writer, including OAuth creation/link/unlink, recovery, password changes, deletion and jobs. A manifest flag is not a database or issuer fence.
2. Establish fresh, read-only production collision evidence and verified ownership resolutions before final email uniqueness. No merge, deletion or owner reassignment is authorized.
3. Make HTTP, WebSocket, cookie, native/watch, refresh and offline consumers enforce one revocation and lineage authority, including outages and races between verification and issuance. A returned password verdict is not continuing session authority.
4. Prove every historical recovery/verification issuer and deadline, capable-reader retention, actual production roles, delivery/origins, provider registrations, mobile/watch compatibility and mutation-safe restored-database rollback.
5. Complete first-party acceptance independently from partner OAuth registration, consent, token families and Disconnect. Retire NextAuth only after those first-party gates; retain the installed-client compatibility API.

The [native OAuth follow-up](./better-auth-native-oauth.md) records that released iOS clients attempt browser fallback after any non-cancelled native failure, including conflicts and outages. Endpoint-only native adoption cannot establish end-to-end collision or writer safety while that fallback reaches the existing web OAuth writers. No client update or silent fallback removal is assumed. Its low-level mobile proof invokes `oauthNativeSignIn` and the real auth-store directly; SDK wrappers, nonce generation and device behavior remain distinct from that HTTP/storage proof.
