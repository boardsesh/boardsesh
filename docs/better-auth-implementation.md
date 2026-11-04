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

## Acceptance ledger

| Child | Evidence/status |
| --- | --- |
| BA-01 #6976 | Substantial runnable identity/native/session/OAuth/browser proof implemented and independently reviewed. Remaining compatibility and operational proofs below keep the overall gate open. |
| BA-03 #6977 | Complete [source writer inventory](./better-auth-writer-inventory.md); no production writer switch or database role fence. |
| BA-02 #4847 | Read-only audit, 21 tests and local execution delivered. Current production counts and ownership resolutions remain unknown; no final uniqueness migration is enabled. |
| BA-04 #6978 | Blocked on prototype, one writer and ownership-verified collision resolution. |
| BA-05 #6979 | Blocked on the authority and session bridge. |
| BA-06 #6980 | Blocked on the authority and session bridge. |
| BA-07 #6981 | Tested prototype guards for family isolation, client ownership, consent binding and Disconnect. Production router, app-specific subjects and operational guards remain unimplemented. |
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
| OAuth provider and guarded lifecycle | 43 cases passed, including joined reset/code-redemption races and POST reconnect consent. The earlier 39 were independently rerun; the final reviewer ran the complete expanded suite. |
| Offline schema generation | A regression proves the complete auth configuration initializes without constructing a Postgres client. The pinned CLI generated the same 11 core tables and exited cleanly. |
| Real Chromium over local HTTPS | 2 cases passed: secure HttpOnly shared-domain cookies, sibling subdomain session reads, OAuth state/code/issuer redirects, logout, and RFC 8414/OIDC proxy routing. |
| Independent cross-reviews | Native/bridge 33 cases, identity/provider 41 cases, OAuth 39 cases, web auth regression 85 cases and CI guard 50 cases passed in independent runs. Findings were fixed and re-reviewed. |
| Full repository typecheck | `vp run typecheck` passed; final change verification is recorded with the implementation PR. |
| Separate Drizzle registry drift check | `vp exec drizzle-kit generate --config auth-prototype.drizzle.config.ts` reported no schema changes after generation. |

**Final combined proof: 9 files / 144 tests passed in 25.62 seconds**, including
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

Before BA-03 changes production writers, finish the legacy NextAuth JWE/chunked
cookie, native pre-cutover refresh-record, browser-transfer-token, Garmin pairing,
configured Facebook and pre-cutover recovery-link proofs. Recreate processes,
not only handler objects, and measure HTTP/WebSocket revocation windows.
Password reset/sign-out/deletion proofs do not establish change/set-password,
verification or provider-link mutation coverage.

The browser fixture skips consent for its managed client. Server tests exercise
consent binding, but the real-browser proof does not exercise a product consent
UI, www-to-auth credentialed cross-origin XHR/CORS, Safari/WebKit, or real
production forwarding/origin headers. Those remain separate tests.

Production also needs a database-enforced writer fence covering stale deployments
and jobs, indexed lifecycle ownership instead of fixture scans, final normalized
email/provider constraints after ownership-verified collision resolution, old
refresh migration, push-device cleanup, real iOS/Android/Garmin and offline
account-isolation QA, restored-database mutation-safe cutover/rollback, monitoring,
and separate partner app-registration/subject/workout gates. A global advisory
lock proves serialization only for callers that participate; it is not a fence
against an old writer. No merge, deletion or reassignment of production accounts
is authorized by this implementation.
