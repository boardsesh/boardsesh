# Better Auth implementation review guide

This is the review entry point for [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975). Updated 2026-11-05. The accepted direction is in [better-auth-migration.md](./better-auth-migration.md). **No production authority switch, identity backfill, account merge, account deletion or production grant change has been performed. The epic and its child issues remain open.**

## Review order

| PR | Review scope | Dependency |
| --- | --- | --- |
| [#7280](https://github.com/boardsesh/boardsesh/pull/7280) | Isolated Better Auth 1.7.17 migration, legacy credential and OAuth lifecycle proofs | Based on main; no production handler adoption |
| [#7282](https://github.com/boardsesh/boardsesh/pull/7282) | Existing native password policy extracted into the backend service | Based on main |
| [#7283](https://github.com/boardsesh/boardsesh/pull/7283) | Generated reservation, projection, cutoff and security-event foundation | Based on main; migration 0290; no activation/backfill |
| [#7284](https://github.com/boardsesh/boardsesh/pull/7284) | Public NextAuth callback delegation proof using real HTTP and OIDC | Stacked on #7283; test fixtures only |
| [#7285](https://github.com/boardsesh/boardsesh/pull/7285) | Default-off web registration and password delegation | Stacked on #7284; includes #7282 through an explicit prerequisite merge |
| [#7286](https://github.com/boardsesh/boardsesh/pull/7286) | Default-off UID-bound verification and resend | Stacked on #7285; migration 0291 |
| [#7287](https://github.com/boardsesh/boardsesh/pull/7287) | Independently opted-in native registration reservations | Stacked on #7286 |
| [#7288](https://github.com/boardsesh/boardsesh/pull/7288) | Independently opted-in native Apple/Google identity reservations | Stacked on #7287 |
| [#7289](https://github.com/boardsesh/boardsesh/pull/7289) | Paired UID-bound password recovery and unconditional web/mobile capability redaction | Stacked on #7288; migration 0292 |
| [#7290](https://github.com/boardsesh/boardsesh/pull/7290) | Actual App Router/configured-provider callbacks and browser actor-cookie proof | Stacked on #7289; test fixtures only |
| [#7299](https://github.com/boardsesh/boardsesh/pull/7299) | Server encoding versus cookie publication, rolling renewal and delayed-response browser races | Stacked on #7290; test fixtures only |

These are unmerged review candidates. Each PR's exact head, checks, review threads and description are the current readiness record; historical green results do not qualify a changed head. The separate proof branch is not a production credential authority. The latest current-store branch contains the preceding implementation notes; #7280 carries its own detailed proof ledger, [better-auth-implementation.md](https://github.com/boardsesh/boardsesh/blob/feat/6975-better-auth/docs/better-auth-implementation.md).

The [password recovery follow-up](./better-auth-password-recovery.md) records the paired UID-bound issuer/consumer and measured QA. Credential delegation remains default-off. Its reset-link headers, shared web/mobile Sentry redaction and fixed legacy-route diagnostics apply in every mode. Privacy coverage is partial: actual trailing-slash 308 first hops omit the configured headers, and the pinned development renderer overrides browser cache control. Production activation requires validated first-hop protection; canonical-page checks and telemetry tests do not close that gate.

The [actual App Router follow-up](./better-auth-app-router-oauth.md) adds a test-only proof of configured Google, Apple and Facebook callbacks, exact attempt/actor ownership and real browser cookie transport. Its 90 normal cases are included in a 474-case regression selection; four browser cases run separately. The compound adapter and same-origin continuation are explicitly synthetic fixtures, not mounted production behavior. Stock email linking, verification mutation and Apple actor-cookie loss remain documented migration requirements.

The [session-publication follow-up](./better-auth-session-publication.md) separates actual server-side token encoding from browser cookie publication before adding authoritative source records. It characterizes the shipping one-argument server reader, actual GET/POST rolling renewal and delayed browser response ordering. It changes tests and documentation only; no new source schema or production adoption is implied.

## Decisions to review

**User decision:** an authenticated password set/change keeps the requesting device signed in and revokes other credentials. Forgotten-password reset revokes every session. The isolated prototype proves atomic replacement while retaining original authentication age and expiry. Current production password routes have not adopted this policy yet.

**Agent implementation decisions:** separate default-off adoption from production activation; never fall back to legacy credential writes after an enabled command fails; reject ambiguous normalized owners instead of choosing one; do not repair incomplete authority while processing a request. Existing accounts are not merged or reassigned.

Deleted or ambiguous email keys remain reserved in the unmounted foundation. This is a safety default for the implementation, not approval of a permanent re-registration or privacy-retention policy. Source-bound provider link/unlink continuation is likewise a prototype decision, not a new user-approved account policy.

New verification receipts bind to an immutable user ID, purpose, email identity, security generation and original expiry. A harmless same-user case/whitespace change may preserve validity. An unbound live historical link remains unavailable rather than selecting whichever account currently matches its email. Resend keeps generic authoritative responses, including after SMTP failure; unknown SQL/protocol outcomes remain unavailable.

Recovery telemetry uses a conservative agent privacy decision: remove the entire query and fragment of a recognized reset URL, redact detached recovery query collections as a whole, and mask reserved `prN_` capabilities even in standalone message text. This drops reset-page campaign/source attribution along with credentials; URLs without recovery capabilities stay unchanged. It changes reporting payloads, not browser navigation or recovery request semantics. Header and telemetry protections apply to existing legacy links as well as staged UID-bound links.

Installed native registration retains immediate sign-in, including when web verification is enabled. Lost registration replies never trigger compensating account deletion or automatic command retries. The mobile body-read failure after received 201 headers is documented as an existing thrown error; it is not a proof of unknown commit acknowledgement before headers.

## Evidence and limits

The isolated migration proof has 702 cases across 28 files, independently checked on PostgreSQL 15.17 and 18.6; its own browser run passed four cases. Historical combined QA before main's wall-device migration covered all ten candidates through #7290: 474 backend/consumer cases across 21 files, all 702 isolated proofs, 39 framework/header cases, four separate browser cases and all 60 uncached typecheck tasks passed. The merge needed no conflict resolution or lock regeneration. The frozen install preserved the lockfile hash. Prototype databases and fixture roles returned to their zero baseline; ordinary salted worker databases remain. Mobile bundles were not repeated in that combined run. This result does not substitute for qualification of the subsequently repaired stack.

The earlier nine-candidate run covered 384 backend/consumer cases, the same 702 isolated proofs, 39 framework/header cases and 60 uncached type tasks. Its corrected task-runner invocation put flags before the task; an initial run had forwarded them after the task instead. Those runs overlap the ten-candidate evidence and must not be added as distinct coverage.

Before the restack, the native reservation slice qualified 22 new backend cases and nine tests invoking actual mobile registration and auth-store code, with native host and SecureStore I/O substitutes. Its final regression selection covers 278 distinct cases across 13 files; the new/shared 85 and actual-mobile nine passed on both PostgreSQL versions. Both independent final reviewers approved that candidate. Full type checking passed 59 tasks and final backend checking passed 13. One default-concurrency attempt aborted in the Rust task runner; the originating task passed alone and the full graph passed at concurrency two. Repository lint had zero errors and 623 existing warnings.

These tests exercise owned local databases, restricted fixture logins, actual HTTP, real signing, rollback and selected consumer logic. They do not prove deployed IAM, real device/keychain behavior, production provider setup, SMTP/ingress behavior or restored-database rollback. Ordinary salted backend worker databases are retained by the shared harness; normal fixture teardown closes owned roles, listeners and child processes. See each slice's note for exact measurements and deliberate counterexamples.

Before the restack, the native OAuth slice qualified 51 backend cases and 11 low-level mobile OAuth cases. Its final combined PostgreSQL 15 run passed all 340 current-store/native/callback cases across 15 files; PostgreSQL 18 selections covered the same cases. The full mobile suite passed 28,091 tests across 1,866 files with two skips; mobile types and iOS/Android bundle checks passed. Simulator and screenshot checks explicitly skipped on Linux. Both independent reviewers and cloud review reported no remaining findings at that earlier head. No production mobile code, native configuration or provider registration changed.

## Migration repair after main advanced

Main added `0289_board_lit_by_wall_device` while these candidates were unmerged. The repair preserves that SQL, snapshot, board column and all upstream BLE changes. It retains the repository bot's generated foundation migration 0290 and regenerates verification 0291 and recovery 0292 from the compiled merged schema, rather than editing migration SQL or snapshot identities by hand. Each auth SQL file is byte-identical to its original; each new snapshot adds only its intended tables and retains every preceding table and other schema section. The final journal contains 293 entries. The linked slice notes record hashes and exact generator evidence.

The old heads remain backed up. The native extraction, public callback proof, native registration and native OAuth retain their original patches. The App Router proof/fix source is unchanged; its leaf review guide is refreshed for repair status. The web-password prerequisite merge retains both the repaired public-proof and native-service parents, without duplicating the old native commit. Independent reviewers check the regenerated metadata and final source; canonical typechecking, runtime qualification and new-head CI remain separate gates.

During repair, concurrent verification selections each passed 62/63 cases; the actual public verification did not redeem its link. The unchanged isolated case and full 31-case file passed, followed by serial **63/63** runs on PostgreSQL 18 (23.09 seconds) and 15 (23.10 seconds). The cause is unproved; a transport-timeout explanation remains a hypothesis. Assertions and deadlines are unchanged. Safe failure-only diagnostics were added, and heavy type graphs run one at a time to limit host contention.

The shared local development database had already applied the original auth migrations. Its timestamp-based dev applier is not a hash-aware renumber reconciliation, so the repair leaves that database and its ledger untouched. Preview restart requires an isolated owned database with the repaired schema. Owned test-schema execution does not establish deployment or restored-database rollback safety.

The repaired ten-candidate tree subsequently qualified on refreshed main `5237a01847` in unpublished automatic merge `aafca528`: **474 normal cases across 21 files (277.97 seconds), all 702 isolated proofs (66.02 seconds), 39 header cases (3.21 seconds), four separate real-browser cases (19.44 seconds), and all 60 canonical typecheck tasks with no cache hits**. Source and lock hashes stayed unchanged, with no manual merge resolution or lock regeneration. Both owned clusters began and ended with zero prototype databases and fixture roles; ordinary salted worker databases remained. Offline compiler placeholders do not establish a live-backend or device proof.

A fresh isolated repaired-head full-Next preview qualified five bounded legacy-auth UI flows across two retained browser runs: login, actual guarded sign-out, wrong-password rejection, invalid-email recovery and invalid-reset rejection. The first run stopped after three qualified flows at a cold-form timeout; the later run separately observed React handler readiness before qualifying recovery errors. A separate negative-only replay classified the expected 401/400 console messages, with no unexpected console/page errors. Independent review approved the evidence. Browser contexts closed and the preview remained running; no valid reset, SMTP, provider/device or all-session revocation was tested.

## Remaining activation gates

1. Adopt every current credential/security writer, including OAuth creation/link/unlink, recovery, password changes, deletion and jobs. A manifest flag is not a database or issuer fence.
2. Establish fresh, read-only production collision evidence and verified ownership resolutions before final email uniqueness. No merge, deletion or owner reassignment is authorized.
3. Make HTTP, WebSocket, cookie, native/watch, refresh and offline consumers enforce one revocation and lineage authority, including outages and races between verification and issuance. A returned password verdict is not continuing session authority.
4. Prove every historical recovery/verification issuer and deadline, capable-reader retention, actual production roles, delivery/origins, provider registrations, mobile/watch compatibility and mutation-safe restored-database rollback.
5. Complete first-party acceptance independently from partner OAuth registration, consent, token families and Disconnect. Retire NextAuth only after those first-party gates; retain the installed-client compatibility API.

The [native OAuth follow-up](./better-auth-native-oauth.md) records that released iOS clients attempt browser fallback after any non-cancelled native failure, including conflicts and outages. Endpoint-only native adoption cannot establish end-to-end collision or writer safety while that fallback reaches the existing web OAuth writers. No client update or silent fallback removal is assumed. Its low-level mobile proof invokes `oauthNativeSignIn` and the real auth-store directly; SDK wrappers, nonce generation and device behavior remain distinct from that HTTP/storage proof.
