# Better Auth implementation evidence and decisions

Parent: [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975).
Design: [Better Auth migration](./better-auth-migration.md).
Started: 2026-11-04, from `origin/main` at `796746a5db`.

Production migration remains gated. For what is merged, what is open and the order of switches, see the acceptance ledger below and [better-auth-rollout.md](./better-auth-rollout.md). The decision log and measurements further down are dated history, kept as written. The user's password policy is to keep the
current device signed in, revoke other credentials, and revoke every session
after forgotten-password reset.

## Execution plan

1. Implement BA-01 as an isolated, pinned, reproducible Postgres/Drizzle prototype.
2. Inventory every current identity writer and prepare the read-only BA-02 audit.
3. Run native identity, recovery, browser and OAuth protocol tests against two authorities sharing Postgres.
4. Obtain independent security and code review, fix findings, and re-review.
5. Record gate results, implement subsequent work only when its prerequisites pass, and publish a reviewable draft PR.

This file records implementation decisions and measured evidence. An unfinished
test or an upstream feature description is not a passed acceptance criterion.

## Decision log

| Date | Decision | Reason and consequence |
| --- | --- | --- |
| 2026-11-04 | Preserve the epic's prototype gate. | None of its child issues has implementation evidence. Production authentication must not switch before compatibility and concurrency proofs pass. |
| 2026-11-04 | Pin Better Auth, OAuth Provider and Drizzle adapter to `1.7.17`. | Exact stable packages were published before this investigation; use matching versions and the checked-in lockfile. Upgrades must rerun the gate suite and receive security review. |
| 2026-11-04 | Keep prototype dependencies development-only and its schema outside production exports. | The prototype must not mount endpoints, create production tables, issue production credentials or change installed-client behavior. |
| 2026-11-04 | Use real Postgres with two independent Better Auth instances. | An in-memory adapter cannot prove database serialization, persistence or cross-instance races. Every run owns its disposable database. |
| 2026-11-04 | Prepare a privacy-preserving read-only identity audit. | Existing duplicate figures are historical. No account merge, reassignment or deletion is authorized. |
| 2026-11-04 | Use supported extension APIs with a transaction-bound authority. | Stock provider family invalidation and consent are insufficient for the partner contract. |
| 2026-11-04 | Treat a provider HTTP 500 as transaction failure. | The handler translates thrown exceptions into responses. The outer transaction must explicitly roll back a 500; protocol errors that intentionally revoke reused credentials still commit. Failure injection verifies this distinction. |
| 2026-11-04 | Preserve unknown legacy age as non-fresh. | Historic native JWTs contain rolling `iat` without original authentication time. Their canonical session gets an epoch sentinel; ordinary use works while sensitive operations require real reauthentication. |
| 2026-11-04 | Use account-wide legacy cutoffs where historic tokens lack session lineage. | Exact-token fingerprints support idempotency but cannot prove device-specific ownership of later rolling tokens. The prototype never claims otherwise. Ordinary logout preserves approved partner connections. |
| 2026-11-04 | Prototype logout accepts an unexpired consumed refresh ancestor. | A refresh racing logout must not leave a successful descendant alive. This deliberately strengthens the old inactive-token 401 into success for that narrowly bounded case; unknown/expired tokens still reject, and a removed ancestor cannot revoke a later fresh login. Production protocol adoption needs explicit review of this difference. |
| 2026-11-04 | Keep one email-normalization function in the backend. | New audit, fixture import and native facade use `normalizeAccountEmail`, preserving dots and plus suffixes. This does not reroute existing production writers. |
| 2026-11-04 | Allow exact same-day dependency pins for the disposable spike. | `vp install` recorded narrow `minimumReleaseAgeExclude` entries for the matching upstream packages and CLI. This exception does not authorize an automatic production upgrade; inspect advisories, review changes and rerun the complete gate before any upgrade. |
| 2026-11-04 | Generate the schema offline. | Better Auth initializes OAuth resource seeds eagerly. Generation now uses the Drizzle mock only for schema discovery with empty resource seeds; a regression fails if it constructs a Postgres client. Actual protocol tests still use real Postgres. |
| 2026-11-04 | Guard both GET and form POST authorization. | The provider supports both transports. Reconnect consent must use the actual form body on POST, ignoring misleading URL parameters; the reviewer reproduced and fixed the missing POST guard. |
| 2026-11-04 | Use a separate local Postgres for final QA. | The shared instance was blocked on WAL/file-sync I/O during broad tests. An isolated Postgres 15.17 container with temporary storage produced a clean run; this does not prove database crash durability. |
| 2026-11-04 | Give the browser fixture a separate required typecheck. | The first Docker web CI build exposed backend imports from the fixture in the slim production context. The product tsconfig now excludes that folder; a dedicated fixture tsconfig and aggregate task keep its full typecheck required without expanding the production context. |
| 2026-11-04 | Preserve the backend's explicit 60-second legacy-web clock policy. | Signed expiry and accepted `validUntil` remain separate. The bridge compares raw signed issue time minus the allowance with revocation cutoffs, so an ahead-clock credential cannot bypass reset. Unknown web authentication age stays non-fresh. |
| 2026-11-04 | Bind old recovery links only with proven original ownership. | Synthetic issuance evidence supplies immutable user IDs. Stable user/purpose supersession markers block replay and delayed import across changed cutover arguments; real links without ownership evidence remain a readiness exception. |
| 2026-11-04 | Share recovery invalidation with canonical reset. | Reset/compromise invalidates both imported purposes in the same transaction; ordinary sign-out retains valid mailbox recovery links. Independent tests caught and closed an initially facade-only invalidation gap. |
| 2026-11-04 | Keep watch issuance behind the canonical native service. | Redis proves a one-time user/session binding; a trusted internal method rechecks live ownership under the lifecycle fence and reuses existing native token issuance. There is no second watch password or JWT policy. |
| 2026-11-04 | Persist migration epochs outside expiring verification records. | Cleanup must never let a caller supply a later cutover and reopen old refresh or recovery imports. The dedicated metadata table has no expiry or user foreign key; source snapshots and dates are copied before awaiting the lifecycle fence. |
| 2026-11-04 | Import old native refresh hashes without inferring authentication age. | Preserve owner, hash and exact original expiry, then use the same rotating native facade. Source row creation is not login time. A canonical cutoff or conflicting immutable source binding rejects import. |
| 2026-11-04 | Test actual process replacement and a kill before commit. | Two Node processes share Postgres. An IPC barrier proves the mutation reached the open transaction before SIGKILL; a survivor observes rollback, and a retry survives replacement. Postgres crash and restored-production rollback remain unproved. |
| 2026-11-04 | Preserve consumed refresh ancestry independently of provider cleanup. | Expiring or pruning an ancestor must not let its replay leave rolling descendants alive. Hash-only family metadata remains while descendants can live; closing the family removes its sidecars. Natural-expiry retention cleanup is a separate production gate. |
| 2026-11-04 | Finalize approved offline token rows before publication. | Pinned provider issuance validates the original browser session first. A transaction-bound after-token hook detaches only the exact newly issued offline grant from that session before commit. This is tested Drizzle augmentation, not stock configuration or a background repair; reset, Disconnect and deletion still revoke it. |
| 2026-11-04 | Exercise the current backend CORS helper in a real browser. | Website and app origins perform actual credentialed preflight, login, server-side cookie reads and logout. The forwarding model replaces hostile headers; deployed ingress, actual product pages and Safari remain gates. Shared-domain cookies require trusting every matching server. |
| 2026-11-04 | Budget CI for the full backend and cold browser installation. | Run 41891846044 passed backend, serial and prototype tests before its 20-minute timeout cancelled Chromium installation. Increase only that job to 30 minutes; preserve every required check. |
| 2026-11-04 | Treat browser handoff issuance separately from source authentication. | The actual returning-user issuer omits source session identity. A recent handoff cannot bypass reset or a prior source tombstone; ambiguous source-less exchange requires real reauthentication. Proven live mapped lineage can retain its existing age. This compatibility limit blocks production adoption until source issuance is fenced and identified. |
| 2026-11-04 | Explicitly enable origin and CSRF checks even in test mode. | Pinned Better Auth otherwise silently skips origin checks under `NODE_ENV=test`. The base configuration sets both disabling flags to false, and advanced overrides merge with those defaults. Six real-request regressions cover hostile cookie origins, redirect destinations and first-login navigation in both configurations. |
| 2026-11-04 | Serialize social callback state consumption too. | The actual Facebook callback's stock state read/delete permits two subjects to authenticate against the same state/cookie under a deterministic race. The existing transaction-bound wrapper and lifecycle fence produce one winner; the unsafe stock behavior is explicitly characterized rather than counted as a safe configuration. |
| 2026-11-04 | Record source denial for canonical session signout. | A fresh non-legacy canonical session previously left no tombstone, allowing an unbound pending handoff/watch code to restore access. Its deletion now records a permanent denial in the same transaction. Newly unseen legacy admissions reject; known live mappings, unrelated canonical sessions and offline partner grants survive. |
| 2026-11-04 | Preserve pending old Garmin codes within a fixed admission window. | Real Redis PTTL and GETDEL retain remaining validity, bounded by a permanent 300-second cutover epoch. The epoch commits before the destructive Redis operation. SQL mint failure cannot restore the consumed code; no distributed exactly-once claim or in-memory fallback is made. |
| 2026-11-04 | User decision: keep the current device signed in after authenticated password set/change. | Revoke other credentials and replace the requesting session atomically; retain its proven original authentication age. Forgotten-password reset revokes every session. The lifecycle proof implements and independently verifies this policy; production adoption remains gated. |
| 2026-11-04 | Separate session revocation eligibility from authentication age. | Canonical creation stamps a trusted generation, and every account revocation increments its durable generation. A replacement binds the current generation while retaining original `createdAt`/authentication time. This handles equal-millisecond changes and ahead-clock cutoffs without making an old login fresh; unbound legacy rows retain conservative date checks. |
| 2026-11-04 | Deny unseen old credentials after any account cutoff. | A newer rolling legacy `iat`, even with an unseen session identifier, is not proof of authentication after reset. Fresh canonical authentication uses the current generation instead. This strengthens the source-provenance gate without changing released endpoints. |
| 2026-11-04 | Fence each protected operation in the transport proof. | Actual loopback HTTP and WebSocket commands revalidate canonical state within the mutation fence. A committed response may arrive after reset; subsequent commands reject. The proof does not replace the product's cache/GraphQL context or claim a production latency SLA. |
| 2026-11-04 | Test a restricted-role database fence before choosing production grants. | An owner transaction drains old table writes, transfers DML capability and rejects already-connected, genuinely prepared and queued stale statements. Retained reads do not fence stateless issuers. PUBLIC, membership, ownership and superuser counterexamples prevent treating named-role revocation alone as a production policy. |
| 2026-11-04 | Bind new verification links to a receipt as well as the actual signed JWT. | The public producer includes user ID, but stock verification permits stateless replay and older email-only forms. A random nonce and hashed, purpose-bound receipt enforce original ownership, exact expiry, resend supersession and single use without creating a login or rewriting imported timestamps. |
| 2026-11-04 | Use the exact shared email normalization in fixture ownership checks. | PostgreSQL `btrim`/`lower` differs from JavaScript trim/lowercase for historical whitespace and Unicode. Complete fixture scans use `normalizeAccountEmail`; production normalized indexes and reservations remain required. |
| 2026-11-04 | Separate issuer clock-read bounds from expiry transport policy. | Actual Better Auth and legacy native producers read clocks separately. Both get a named 60-second nominal-span allowance; canonical verification still expires exactly at signed `exp`, while old native JWTs preserve the installed backend's 60-second transport tolerance. Neither grants fresh authentication. |
| 2026-11-04 | Agent decision: apply current-device continuation to explicit provider link/unlink. | Reuse the password continuation helper, preserve authentication age/expiry, and revoke old credentials. This is not a user answer about provider policy. Linking preserves local email/verification and never merges or reassigns a subject. The narrow Facebook trust setting proves provider-account ownership through authenticated Graph exchange, not mailbox ownership. |
| 2026-11-04 | Consume validated browser-link intents even when provider work fails. | Keep receipt consumption in the outer transaction and provider/credential changes in a savepoint. Cancellation, rejection or late policy failure requires a new flow while original credentials survive; wrong/stale actors reject before consumption. A final supported after-hook observer corrects the pinned callback's saved302/late403 behavior. |
| 2026-11-04 | Use one source-bound canonical browser-to-native handoff. | A signed JWT with readable claims carries a distinct purpose/key and exact120-second deadline. A hashed single-use receipt binds the same user/session/generation; native issuance reuses the canonical source and never creates fresh authentication. A valid optional cookie must match the exact source session. |
| 2026-11-04 | Independent gate decision: implement BA-03 over the existing store. | Supported-API capability and concurrency evidence permits implementing backend centralization, reservations and fencing. This does not authorize activating a writer switch, importing identities or launching partners. The final configured Google browser-code fixture closes the last identified prototype capability gap; deployed provider/device and operational gates remain. |
| 2026-11-04 | Keep prototype test discovery separate from current-store implementation tests. | Explicit prototype and identity-audit patterns retain all 28 proof files. The new BA-03 current-store tests need the ordinary backend worker database setup and must not enter the isolated prototype project when the PRs merge. Independent discovery review verified both boundaries. |
| 2026-11-09 | Move the three Better Auth packages to backend `dependencies` for partner OAuth (#6981). | Partner OAuth is the first production use, so this supersedes "development-only" above, at the same exact `1.7.17` pins. Nothing outside `auth/prototype` imports them yet; `scripts/__tests__/better-auth-boundary.test.ts` fails if web, mobile or another production module starts to. Dependabot ignores `better-auth` and `@better-auth/*`, so an upgrade only arrives in a gated PR. The `minimumReleaseAgeExclude` entries are gone because every pinned version is past pnpm's 24-hour window. `telemetry.enabled: false` does not beat `BETTER_AUTH_TELEMETRY=1`, which turns telemetry on regardless, so never set that variable or `BETTER_AUTH_TELEMETRY_ENDPOINT` in a deployed service. |
| 2026-11-09 | Add the partner authority in `auth/partner/`, reached only through `loadPartnerAuthority` (#6981). | `PARTNER_OAUTH_MODE` defaults to `off`, and with it off no Better Auth code loads; `better-auth-boundary.test.ts` fails if a production module imports the folder before routes ship. Better Auth runs on `users` read-only: an adapter guard refuses identity writes, and a real Postgres trigger proves no flow attempts one. One long-lived instance joins each request's transaction through an `AsyncLocalStorage` Drizzle handle. Building an instance refuses to start with `BETTER_AUTH_TELEMETRY` on. |
| 2026-11-10 | Partner consent reads the www NextAuth session on every request and stores every consent link (#6981, F13). | No Better Auth cookie and no `api`-only session (fast-path decision 3). A sign-in counts under 30 days old and after the last password write; the legacy verifier moved out of the prototype to `auth/legacy-web-credentials.ts` and now reads `auth_time`. Consent links are single-use rows bound to climber, login, app and connection generation. Once `PARTNER_OAUTH_MODE` leaves `off` (the web reads it too), new web sign-ins carry `link_guarded`, which consent requires, and a web OAuth link into a session that could not itself approve an app is refused, so linking cannot buy a fresh `auth_time`. Caps count a connection from its first code exchange. Details in [integration-platform.md](./integration-platform.md#consent-and-the-www-session). |
| 2026-11-10 | Check `/v1` bearer tokens with one read of the provider's hashed token rows, not by calling its introspection (#6981, F10). | The provider's `requireActiveAccessToken` needs an endpoint context and makes five or six reads, and still passes a token with no audience. The `/v1` check hashes with the provider's own `hashToken` and joins the token to its grant, connection and client in one read on the primary. It refuses everything stock introspection refuses, which the route tests check state by state, and adds the audience, DPoP, connection and generation checks. A provider upgrade must rerun those tests, because a new token column the provider starts to check would not be checked here. |
| 2026-11-10 | Add partner app registration and the admin script (#6982, F12). | The console's GraphQL entry (`graphql/resolvers/oauth-clients/partner-registration.ts`) is the second module allowed into `auth/partner/`, and loads only `mode`, `load-authority` and the pure `registration-rules`; with `PARTNER_OAUTH_MODE` off it answers `NOT_FOUND` before authentication, limits or the database. Registration calls the provider's managed `adminCreateOAuthClient` with consent, PKCE, grants, scopes and the resource fixed and `private_key_jwt` refused, then reads the row back and rolls back on any difference. The provider gets the developer as its session only inside a server call this module makes (an `AsyncLocalStorage` store), never from a request. `partner-app-admin.ts` suspends by `oauth_client.disabled` and revokes through `partner_revoke_user()` as `boardsesh_runtime`, dry run by default. Details in [integration-platform.md](./integration-platform.md) "What the backend does today (F12)". |
| 2026-11-10 | Publish `logbook:read` and serve the logbook routes (#6981, L4). | `logbook:read` joins `PARTNER_SCOPES`, so discovery and the consent screen list it only now that `GET /v1/logbook/changes` and `GET /v1/logbook/ticks/{id}` exist (launch gate 10); consent details mark it `includesOnlyMeTicks` (decision 21). The routes reuse the `/v1` bearer check unchanged. Their `c3.` cursors are sealed with a key derived from the `PARTNER_OAUTH_SECRETS` version they name, so rotating that secret keeps old cursors readable while the old version is listed, and removing it sends their apps back to a full sync with `410`. Details in [integration-platform.md](./integration-platform.md#the-routes-as-built-l4). |

## Acceptance ledger

Checked against GitHub on 2026-11-16. Every switch named here is listed in [better-auth-rollout.md](./better-auth-rollout.md); none is on in production.

| Child | State | Evidence and what is left |
| --- | --- | --- |
| BA-01 #6976 | **Closed** | The prototype proof (#7280) and the fully migrated catalog check (#7321) are merged. The prototype itself is deleted (#7620); live web proofs are in `packages/web/auth-proofs/`. Production acceptance is tracked in the later children. |
| BA-03 #6977 | Open | The backend current-store service, reservations, fencing and the selected writers for password, recovery, registration, verification, provider ownership, account deletion and location owners are on main (#7323, #7350, #7438 to #7441, #7443, #7456 to #7459, #7462, #7467, #7471). They run only when their mode is on, and no mode is on. Left: deployed role fence, the two activation code gates, and every mode switch in the rollout doc. |
| BA-02 #4847 | Open | Case-insensitive lookup (#7426), normalized new writes (#7429), the private resolution tool (#7433, #7448) and the read-only audit are merged. Left: the 17 contact emails, resolving approved groups, then the unique index and stored-form check in draft #7436. #7432 (read-only consolidation preview) and #7446 are open. #7444 is labelled do-not-merge because it merges accounts without ownership proof. |
| BA-04 #6978 | Open | The dark legacy bridge and denials (#7439), the identity mirror and gated import and reconcile (#7438, #7437), and the authority module (#7471) are merged. `auth-authority activate` refuses on two code gates (#7626 closed the lock-order gate). Nothing has been fenced, prepared, imported or activated in production. #7591 is fixed (#7630): deletion keeps working after `prepare` and is unavailable only from `activate` until the staged deletion mode is on. The writer fence wiring is open as #7631. The email resolution tool refuses under another authority (#7649). |
| BA-05 #6979 | Open, re-scoped | #7596 replaces the staged browser design with one shared-domain session cookie and one central client guard ([design](./better-auth-browser-session.md)). Phase A removed the web side of the staged design: the first-password web layer (#7617), renewal custody (#7618), leases, expired binding, browser password, the coordinator, the provider web layer, the binding web core and proof cookies, with every readiness function that returned `false`. The backend binding core stays until B5. Client guards #7632 and #7634 are merged. #7588, #7592 and #7594 close with the removal. Phase B is blocked on BA-04. |
| BA-06 #6980 | Open | Released-client contract replay (#7450), token-keyed refresh limits (#7447), ancestry through the native callback (#7463) and watch pairing and transfer ancestry (#7464) are merged, as is the Garmin owner-scoped outbox (#7442) and dead-lettering of refused ticks (#7633). Left: original-key installed watch, queued ticks, hardware and FIT QA, and downgrade. |
| BA-07 #6981 | Open | The partner OAuth tables, authority, routes, `/v1` API, hourly sweep and launch suite are merged (#7361, #7393 to #7396, #7400, #7403, #7404). `PARTNER_OAUTH_MODE` is off in production. Left: stages A to D. |
| BA-08 #6982 | Open | Developer console, consent screens, connected apps and the end-to-end journey are merged (#7406, #7408, #7411). The developer terms are a draft until the owner approves them. #7597 (consent every time for apps without a secret and for native apps) and nightly CI for the journey (#7605) are merged. #7598 (console changes need a recent sign-in) is open as PR #7652. |
| BA-09 #6983 | Open | [better-auth-rollout.md](./better-auth-rollout.md) lists every switch and the order. Left: restored-database and real-device evidence, then the switches. |
| BA-10 #6984 | Open | NextAuth remains. No removal until the migration readiness gate passes. |

### NextAuth import ratchet

`scripts/__tests__/next-auth-import-ratchet.test.ts` stops NextAuth spreading while it waits for removal. It scans tracked source under `packages/{web,backend,shared,db,mobile}` and `scripts/`, plus every `package.json`, for `next-auth`, `next-auth/*`, `@next-auth/*` and `@auth/*` (including `@auth/drizzle-adapter`), type-only imports, mocks and dynamic imports included. A file may reference them only if it is listed in `scripts/__tests__/next-auth-import-ratchet.allowlist.txt`. The test fails when an unlisted file references NextAuth, and fails again when a listed file no longer does or no longer exists, so the list only shrinks. To shrink it, delete the paths the failure message names from the allowlist in the same PR that removes the imports. The test prints how many files still import next-auth. It runs with the other `scripts/__tests__` guards.

## Reproduce the delivered proofs

Install with `vp install --frozen-lockfile`.

The BA-01 prototype suites, their generated schema and migration registry,
`vp run test:auth-prototype`, `vp run test:auth-prototype:browser` and the
Playwright HTTPS browser proof were deleted in
[#7620](https://github.com/boardsesh/boardsesh/pull/7620). What survives from
them: the web credential and cookie proofs in `packages/web/auth-proofs/`
(live NextAuth-route code, with their own `vp` tasks and CI steps) and the
native JWT clock test `packages/backend/src/__tests__/native-jwt-clock.test.ts`.
The per-proof pages linked below point to the live tests that cover the same
behavior.

The audit command is
`vp exec tsx packages/backend/src/scripts/audit-auth-identities.ts`, with an
explicit `AUTH_IDENTITY_AUDIT_DATABASE_URL` pointing to a local restored or
disposable database. It refuses a default or remote URL, uses a read-only
repeatable-read transaction, and emits fresh counts plus per-run keyed HMAC
references. No raw emails, provider subjects, password hashes or tokens appear
in its output. See the inventory for its scope and operational limits.

## Measured evidence

These rows and combined runs record results from the BA-01 prototype suites
as they stood when measured. Those suites and their `AUTH_PROTOTYPE_DATABASE_URL`
setup were deleted in #7620. Treat the numbers as history, not as commands to rerun.

| Evidence | Result |
| --- | --- |
| Identity import, signed Google/Apple login, native facade and session freshness | 63 authored cases passed. RSA fixtures replace only remote JWKS transport; real signature, issuer, audience, nonce and subject checks execute. |
| Read-only identity audit | 19 pure/URL cases and 2 real-Postgres cases passed. Tests compare source rows before/after and remeasure after a new synthetic insert. |
| Signed legacy bridge, idempotency, reset/sign-out races and rollback | 16 cases passed, including unknown freshness, deleted-session tombstones and a post-mutation injected failure. |
| OAuth provider and guarded lifecycle | 51 cases passed independently, including expired/pruned refresh ancestry, day-91 offline access, retained expired sessions, and deletion of a consenting climber while the same developer app and another grant survive. |
| Offline schema generation | A regression proves the complete auth configuration initializes without constructing a Postgres client. The pinned CLI generated the same 11 core tables and exited cleanly. |
| Real Chromium over local HTTPS | 4 cases passed independently in 8.5 seconds: secure HttpOnly shared-domain cookies, website/app credentialed CORS and preflight, server-rendered session reads, hostile JavaScript origin isolation, OAuth redirects and discovery routing. See the [browser proof](./better-auth-browser-proof.md). |
| Explicit provider link/unlink and shared continuation | [51 provider cases](./better-auth-provider-link-proof.md) and 32 password cases passed independent security QA on PostgreSQL15/18 in27.05/27.35 seconds. Real provider verification, ownership/freshness, usable methods, callback intent, formPOST and late policy rollback are exercised. |
| Canonical browser-to-native handoff | [43 cases](./better-auth-canonical-handoff-proof.md) passed two independent reviewers on both database versions. Source/session/generation binding, exact expiry, single use, account switching, mutation races, rollback and publication failures pass. Signed claims are readable; no production rollout claim. |
| Configured Google browser callback | [9 cases](./better-auth-google-browser-callback-proof.md) independently pass on PostgreSQL15/18 in2.50/2.46 seconds. Actual public code exchange checks configured client/redirect/PKCE/state and subject ownership. This browser path trusts the authenticated token endpoint; separate native tests prove JWKS/signature/audience/nonce verification. |
| Application process replacement and crash rollback | 18 cases passed independently, including actual SIGKILL at a pre-commit barrier, rejected-startup cleanup, persisted revocation, and unknown authentication age after replacement. |
| Pre-cutover native/watch refresh import | 34 cases passed independently; preserve source ownership/hash/expiry, reject new admission after canonical signout while retaining known live bindings, and retain an immutable epoch through verification cleanup. See the [refresh proof](./better-auth-legacy-refresh-proof.md). |
| Durable old recovery binding | 34 cases passed independently after cleanup, mutable-caller and cutover-extension fixes; canonical reset invalidates both imported purposes in the mutation transaction. |
| Genuine legacy web credentials | 56 cases passed, including the real NextAuth encoder crossing a second boundary. Signed expiry, clock grace and cutoff accounting remain distinct. |
| Browser-native legacy transfer | 71 cases passed independently, plus all 17 native facade regressions. Uses the actual web producer, preserves non-fresh age, rejects source tombstones and atomically consumes/mints. See the [transfer proof](./better-auth-transfer-proof.md) for the source-less returning-user compatibility gate. |
| Configured Facebook callback | 22 cases passed independently with actual Better Auth handlers and synthetic Graph transport, including stock-state race characterization and guarded one-winner behavior. |
| Pending old Garmin codes | 40 cases passed independently with real Redis PTTL/GETDEL, fixed cutover, canonical-signout denial, sibling preservation, reset races and explicit SQL/Redis failure boundaries. See the [legacy watch proof](./better-auth-legacy-watch-proof.md). |
| Final source-denial and explicit-origin review | 163 cases passed independently in 12.68 seconds: 6 origin, 12 web bridge, 71 transfer, 34 old refresh and 40 pending watch cases; selected lint clean and all findings re-reviewed. |
| Trusted generation and transport follow-up | 61 cases passed independently in 6.64 seconds: 10 generation, 17 native, 18 legacy bridge and 16 real HTTP/WebSocket cases. See the [transport proof](./better-auth-transport-proof.md) for in-flight and product-integration limits. |
| Existing native/Expo-web identity storage | 250 cases in 7 existing files passed in 14.10 seconds, covering auth storage/session/provider races. These are baseline client regressions, not migration traffic, SecureStore hardware or real-device evidence. |
| Authenticated password set/change | 28 cases passed independently in 24.76 seconds. Requesting-device replacement preserves original age; old requester/native/partner/recovery credentials reject; equal/ahead clocks and forgotten reset pass. See the [lifecycle proof](./better-auth-lifecycle-proof.md). |
| Candidate PostgreSQL writer fence | 10 cases passed independently on both PostgreSQL 15.17 and CI's 18.6 server version, including real prepared/queued stale writes, privilege rollback, bypass characterizations and pre/post-commit setup cleanup. The [proof](./better-auth-writer-fence-proof.md) changes no production grants or writer paths. |
| Canonical new verification links | 41 cases passed independently in 25.78 seconds, including actual public issuance, original-user receipts, single use/resend, exact JS-normalized collisions, policy hooks and rollback. See the [verification proof](./better-auth-verification-proof.md). |
| Actual legacy native issuer clocks | 17 new cases plus 18 bridge cases passed independently in 6.73 seconds. Actual exchange/signature output exercises encoder pauses, ahead clocks, signed expiry/grace and runtime subject validation. See the [native clock proof](./better-auth-native-clock-proof.md). |
| Independent cross-reviews | Native/bridge 33 cases, identity/provider 41 cases, OAuth 39 cases, web auth regression 85 cases and CI guard 50 cases passed in independent runs. Findings were fixed and re-reviewed. |
| Full repository typecheck | `vp run typecheck` passed; final change verification is recorded with the implementation PR. |
| Separate Drizzle registry drift check | Generating from the separate prototype registry (since deleted) reported no schema changes. |

**Initial combined proof: 9 files / 144 tests passed in 25.62 seconds**, including
clean database teardown. This run used
`AUTH_PROTOTYPE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:15475/postgres`
on isolated Postgres **15.17** (image
`sha256:29342cb52157b098821961d2c14eec3c019071f56a5d559e990cf07cf541ea9b`).
The exact runtime was Node **22.22.2**, Drizzle **0.45.2**, postgres-js **3.4.9**,
and local Vite+ **0.3.0**, with package artifacts locked in `pnpm-lock.yaml`.

Earlier combined runs completed all assertions but failed database cleanup under
shared Postgres I/O contention. The harness now awaits eager plugin initialization
and bounds connection/statement/lock waits; the clean isolated rerun includes
those fixes. Interrupted broad backend runs are not recorded as passed tests.

**Expanded combined proof: 13 files / 262 tests passed in 26.34 seconds**, with
clean teardown on isolated Postgres 15475 and Redis 15476. The real Chromium
proof passed **2/2** again through its separately required typecheck. The added
cases are documented in the [legacy web proof](./better-auth-legacy-web-proof.md),
[legacy recovery proof](./better-auth-legacy-recovery.md) and
[watch proof](./better-auth-watch-proof.md):

- 53 real NextAuth encoder/decoder cases, including clock grace and cookie conflicts.
- 11 joined cookie-to-authority cases, including reset, logout and wrong-account races.
- 28 old recovery cases, independently rerun after shared reset invalidation was wired.
- 26 real Redis watch cases, independently rerun after review fixes.

The watch proof uses Redis **7.4.11**, an eight-character code with a 300-second
TTL, NX allocation and atomic GETDEL. Tests cover a committed mint whose
response is lost, plus a deterministic reset before a delayed response is used.
Race tests described as two start orders assert the final fail-closed property;
they do not claim both possible serialized winners unless a barrier proves them.

**Durable lifecycle combined proof: 16 files / 396 tests passed in 35.08 seconds**,
including clean database/process teardown. It adds the process-replacement,
pre-cutover refresh and browser-transfer suites, plus the reviewed recovery,
clock-read and OAuth fixes above. The expanded HTTPS suite passed **4/4** in an
independent run. The full aggregate TypeScript check is required again before
publishing this slice.

**Final combined proof: 19 files / 471 tests passed in 46.91 seconds**, with
clean database/process teardown and explicit origin/CSRF checks enabled. This
includes the Facebook, pending-old-watch, strict-origin and canonical-signout
follow-ups. Real Chromium passed **4/4** under the explicit checks. The full
repository `vp run typecheck` passed **59 tasks**, and generated Drizzle
verification reported no schema changes. Final PR evidence records lint and
hook results; earlier interrupted backend runs remain distinct from passing CI.

**Password continuation and transport combined proof: 22 files / 527 tests passed
in 38.75 seconds**, with clean teardown. This run includes generation-bound
replacement, the user-approved continuation policy, rolled-old-issue-time denial
and actual HTTP/WebSocket operation proofs. HTTPS Chromium passed **4/4** again
in **11.2 seconds** and the full aggregate TypeScript check passed **59 tasks**.
Candidate writer-fence evidence has passed separate independent review; its
later combined validation is recorded below.

**Cross-version combined proof: 25 files / 595 tests passed on both servers**,
with clean teardown: **62.49 seconds on PostgreSQL 15.17** and **61.04 seconds on
PostgreSQL 18.6**. Both use the same real Redis 7.4.11 service with owned
namespaces. The latter matches CI's server version and uses a separate cached
PostGIS image, not the exact CI container artifact. No test is skipped or
weakened for a server version. The current batch includes the user-approved
password continuation, canonical verification, legacy native clock policy and
candidate database fence. Provider linking and email change remain separate.
The real HTTPS Chromium proof passed **4/4 on PostgreSQL 18.6 in 8.3 seconds**.
The final aggregate typecheck passed **59 tasks**; repository `vp check` passed
with **0 errors and 623 existing warnings**. Isolated Drizzle generation
reported no schema changes. Independent reviews and re-reviews above cover
every new source change in this batch.

**Provider continuation and canonical handoff combined proof: 27 files /693 tests
passed on both servers**, with clean teardown: **78.05 seconds on PostgreSQL15.17**
and **52.35 seconds on PostgreSQL18.6**. The full aggregate typecheck again passed
**59 tasks**; repository `vp check` passed with **0 errors and623 existing warnings**.
The generated schema did not change. The new provider, shared password helper
and handoff sources received independent review, fixes and independent dual-version
reruns. The four HTTPS tests previously passed on the unchanged browser fixture
and base authority; they are not new provider browser-navigation evidence.

**Final configured-provider combined proof: 28 files /702 tests passed on both
servers**, with clean teardown: **77.74 seconds on PostgreSQL15.17** and
**77.07 seconds on PostgreSQL18.6**. The aggregate typecheck passed **59 tasks**.
The new Google test passed selected-file lint with zero warnings/errors and
independent dual-version QA. It changes no runtime source, schema or dependency.

The published `0487eaca0b` slice passed [full remote CI run 41916355530](https://github.com/boardsesh/boardsesh/actions/runs/41916355530):
**59,948 passed, 0 failed, 23 skipped**. Backend, serial, prototype, HTTPS browser,
typecheck, lint, guard, migration, mobile bundle and Docker web jobs all passed.
The increased backend budget resolved the measured Chromium-install timeout.
PR #7280 was marked ready for review after checking that it had no review
comments or merge conflicts. The later discovery-only compatibility follow-up
still requires its own committed-head CI. Its independent review retained all
28 files; the same **702 cases passed on PostgreSQL18.6 in58.97 seconds** and the
full aggregate typecheck again passed **59 tasks**. This does not close the
epic's production gates. The first current-store service slice is independently
reviewed in [PR #7282](https://github.com/boardsesh/boardsesh/pull/7282).

The local development audit at **2026-11-04 18:11:40 UTC** measured 53 users,
1 credential, no provider links, 40 non-normalized addresses, and zero
normalized-email collision groups. Of those fixture/catalog users, 52 had no
sign-in method. These are **local development measurements**, not current
production counts or ownership decisions. The audit changes no records.

The normal development server was started with the prepared QA notes. Startup
logged their path; the dev metadata endpoint returned the same notes and branch.
This verifies review setup, not new production auth adoption.

## Readiness decision and remaining work

**No production first-party cutover and no partner launch.** The prototype
demonstrates supported library integration and exposes the custom lifecycle
work needed. The prototype capability gate permits BA-03 implementation;
epic #6975 remains incomplete. No child issue is closed from test counts alone.

**BA-03 implementation may proceed over the existing authoritative store.**
Independent security review mapped the pinned supported APIs, provider mutation,
handoff and concurrency evidence to its prerequisite; no unsupported library
capability remains that must block building the service. This is separate from
activating its production writers. The configured Google browser authorization-code
callback now has its own independently reviewed fixture, closing the precise
transport gap found by the audit. Its browser assurance is documented separately
from native Google verification and actual deployed-provider/device validation.

Before activating BA-03 writers, finish source-provenance and mixed-version
acceptance. The configured Facebook, old pending Garmin,
pre-cutover refresh, JWE/chunked-cookie,
purpose-bound old recovery, browser transfer and actual process-replacement experiments now pass;
historical ownership must still be established for actual recovery links.
Measure HTTP/WebSocket revocation windows through every production validator.
Password reset/sign-out/deletion, authenticated change/set-password and canonical
verification, [provider link/unlink](./better-auth-provider-link-proof.md) and
[canonical handoff](./better-auth-canonical-handoff-proof.md) proofs now pass.
Email change remains separate work. Verification creates no login or new authentication
age. The current-device continuation proof uses browser cookies;
native storage and actual settings-screen adoption remain unproved.
The released browser-transfer producer omits source session identity for returning
users. Its recent handoff timestamp cannot prove authentication after revocation;
source-less rejection in the proof exposes a compatibility gap to resolve in the
fenced issuer, rather than evidence that every existing handoff already migrates.

The browser fixture skips consent for its managed client. Server tests exercise
consent binding, and Chromium now proves www/app-to-auth credentialed CORS and
server cookie forwarding. Product consent UI, Safari/WebKit and actual production
forwarding/origin configuration remain separate tests.

Production also needs a database-enforced writer fence covering stale deployments
and jobs, indexed lifecycle ownership instead of fixture scans, final normalized
email/provider constraints after ownership-verified collision resolution, a fenced
production refresh migration, push-device cleanup, real iOS/Android/Garmin and offline
account-isolation QA, restored-database mutation-safe cutover/rollback, monitoring,
and separate partner app-registration/subject/workout gates. A global advisory
lock proves serialization only for callers that participate; it is not a fence
against an old writer. No merge, deletion or reassignment of production accounts
is authorized by this implementation.
