# Better Auth implementation evidence and decisions

Parent: [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975).
Design: [Better Auth migration](./better-auth-migration.md).
Started: 2026-11-04, from `origin/main` at `796746a5db`.

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
| 2026-11-04 | Use supported extension APIs with a transaction-bound authority. | Stock provider family invalidation and consent are insufficient for the partner contract. The [OAuth evidence](./better-auth-prototype.md) distinguishes provider behavior from tested custom guards. |
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

## Acceptance ledger

| Child | Evidence/status |
| --- | --- |
| BA-01 #6976 | Identity/native/session/OAuth/browser, configured Facebook, legacy web/recovery/transfer, pre-cutover refresh, real process restart and both new/pending-old Redis watch proofs implemented and independently reviewed. Source-provenance and operational proofs below keep the overall gate open. |
| BA-03 #6977 | Complete [source writer inventory](./better-auth-writer-inventory.md); no production writer switch or database role fence. |
| BA-02 #4847 | Read-only audit, 21 tests and local execution delivered. Current production counts and ownership resolutions remain unknown; no final uniqueness migration is enabled. |
| BA-04 #6978 | Prototype cookie/JWT lineage, clock-aware cutoffs, tombstones and reset races pass; production import still depends on one writer and ownership-verified collision resolution. |
| BA-05 #6979 | Blocked on the authority and session bridge. |
| BA-06 #6980 | Canonical native, pre-cutover refresh and both Redis watch formats pass. Pending source-less pairing requires an authenticated snapshot or fenced issuer; full HTTP behavior and device/offline QA remain acceptance work. |
| BA-07 #6981 | Tested guards preserve family ancestry after expiry/pruning and offline access after browser-session expiry, alongside client ownership, consent binding and Disconnect. Production router, app-specific subjects and operational guards remain unimplemented. |
| BA-08 #6982 | Blocked on first-party adoption and partner authority. |
| BA-09 #6983 | Production rollout requires restored-database and real-device evidence. |
| BA-10 #6984 | NextAuth remains until the migration readiness gate passes. |

## Reproduce the delivered proofs

Install with `vp install --frozen-lockfile`. The Postgres administrator must be
local; `AUTH_PROTOTYPE_DATABASE_URL` defaults to
`postgresql://postgres:postgres@127.0.0.1:5433/postgres`. Each test owns a fresh
randomly named `boardsesh_ba01_*` database, applies only the separate generated
migration registry, and removes that owned database afterward. The factory
rejects remote hosts, non-admin database paths and URL options. Nothing reads a
production `DATABASE_URL` fallback.

Run `vp run test:auth-prototype`. To run the real HTTPS browser proof, install
Chromium with `vp exec playwright install chromium` from `packages/web`, then run
`vp run test:auth-prototype:browser` from the root. OpenSSL creates a temporary
self-signed fixture certificate; the test removes it afterward. CI runs both
proofs in the backend job with its local Postgres service. The ordinary backend
and web Vitest projects exclude the isolated proof files.

The schema source is generated by
`vp dlx auth@1.7.17 generate --config packages/backend/src/auth/prototype/schema-config.ts --output packages/db/src/auth-prototype/schema.ts --yes`.
Its separate `index.ts` adds explicitly owned bridge, OAuth and native lifecycle
tables. Generate migration changes from `packages/db` using
`vp exec drizzle-kit generate --config auth-prototype.drizzle.config.ts`.
The production schema and `packages/db/drizzle` journal never import this index.
The generated provider schema's exact-email uniqueness and non-unique provider
subject index are **not** BA-02's required final database invariants.

The audit command is
`vp exec tsx packages/backend/src/scripts/audit-auth-identities.ts`, with an
explicit `AUTH_IDENTITY_AUDIT_DATABASE_URL` pointing to a local restored or
disposable database. It refuses a default or remote URL, uses a read-only
repeatable-read transaction, and emits fresh counts plus per-run keyed HMAC
references. No raw emails, provider subjects, password hashes or tokens appear
in its output. See the inventory for its scope and operational limits.

## Measured evidence

| Evidence | Result |
| --- | --- |
| Identity import, signed Google/Apple login, native facade and session freshness | 63 authored cases passed. RSA fixtures replace only remote JWKS transport; real signature, issuer, audience, nonce and subject checks execute. |
| Read-only identity audit | 19 pure/URL cases and 2 real-Postgres cases passed. Tests compare source rows before/after and remeasure after a new synthetic insert. |
| Signed legacy bridge, idempotency, reset/sign-out races and rollback | 16 cases passed, including unknown freshness, deleted-session tombstones and a post-mutation injected failure. |
| OAuth provider and guarded lifecycle | 51 cases passed independently, including expired/pruned refresh ancestry, day-91 offline access, retained expired sessions, and deletion of a consenting climber while the same developer app and another grant survive. |
| Offline schema generation | A regression proves the complete auth configuration initializes without constructing a Postgres client. The pinned CLI generated the same 11 core tables and exited cleanly. |
| Real Chromium over local HTTPS | 4 cases passed independently in 8.5 seconds: secure HttpOnly shared-domain cookies, website/app credentialed CORS and preflight, server-rendered session reads, hostile JavaScript origin isolation, OAuth redirects and discovery routing. See the [browser proof](./better-auth-browser-proof.md). |
| Application process replacement and crash rollback | 18 cases passed independently, including actual SIGKILL at a pre-commit barrier, rejected-startup cleanup, persisted revocation, and unknown authentication age after replacement. See the [process proof](./better-auth-process-proof.md). |
| Pre-cutover native/watch refresh import | 34 cases passed independently; preserve source ownership/hash/expiry, reject new admission after canonical signout while retaining known live bindings, and retain an immutable epoch through verification cleanup. See the [refresh proof](./better-auth-legacy-refresh-proof.md). |
| Durable old recovery binding | 34 cases passed independently after cleanup, mutable-caller and cutover-extension fixes; canonical reset invalidates both imported purposes in the mutation transaction. |
| Genuine legacy web credentials | 56 cases passed, including the real NextAuth encoder crossing a second boundary. Signed expiry, clock grace and cutoff accounting remain distinct. |
| Browser-native legacy transfer | 71 cases passed independently, plus all 17 native facade regressions. Uses the actual web producer, preserves non-fresh age, rejects source tombstones and atomically consumes/mints. See the [transfer proof](./better-auth-transfer-proof.md) for the source-less returning-user compatibility gate. |
| Configured Facebook callback | 22 cases passed independently with actual Better Auth handlers and synthetic Graph transport, including stock-state race characterization and guarded one-winner behavior. See the [Facebook proof](./better-auth-facebook-proof.md). |
| Pending old Garmin codes | 40 cases passed independently with real Redis PTTL/GETDEL, fixed cutover, canonical-signout denial, sibling preservation, reset races and explicit SQL/Redis failure boundaries. See the [legacy watch proof](./better-auth-legacy-watch-proof.md). |
| Final source-denial and explicit-origin review | 163 cases passed independently in 12.68 seconds: 6 origin, 12 web bridge, 71 transfer, 34 old refresh and 40 pending watch cases; selected lint clean and all findings re-reviewed. |
| Independent cross-reviews | Native/bridge 33 cases, identity/provider 41 cases, OAuth 39 cases, web auth regression 85 cases and CI guard 50 cases passed in independent runs. Findings were fixed and re-reviewed. |
| Full repository typecheck | `vp run typecheck` passed; final change verification is recorded with the implementation PR. |
| Separate Drizzle registry drift check | `vp exec drizzle-kit generate --config auth-prototype.drizzle.config.ts` reported no schema changes after generation. |

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
work needed. It does not satisfy every BA-01 acceptance criterion or complete
epic #6975. None of the child issues should be closed from test counts alone.

Before BA-03 changes production writers, finish production-shaped handoff and
source-provenance acceptance. The configured Facebook, old pending Garmin,
pre-cutover refresh, JWE/chunked-cookie,
purpose-bound old recovery, browser transfer and actual process-replacement experiments now pass;
historical ownership must still be established for actual recovery links.
Measure HTTP/WebSocket revocation windows through every production validator.
Password reset/sign-out/deletion proofs do not establish change/set-password,
verification or provider-link mutation coverage.
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
