# Better Auth migration: backend-owned identity without disrupting installed clients

Status: accepted direction, implementation gated on the proofs below. This is a
design and backlog, not a deployed authentication system. Updated 2026-10-27 in
[PR #6974](https://github.com/boardsesh/boardsesh/pull/6974).

For implementation PRs, decisions, measured QA and outstanding activation gates,
start with the [implementation review guide](./better-auth-review-guide.md).

The target is self-hosted **Better Auth with its OAuth Provider plugin**, running
inside `packages/backend`, with PostgreSQL and Drizzle schemas/migrations owned by
`packages/db`. Next.js remains a presentation client for account and consent
pages. React Native, Expo web, and Garmin keep their existing user experience.

The [integration platform](./integration-platform.md) owns third-party access,
and [partner-api.md](./partner-api.md) owns its public protocol. This document
owns first-party identity, credentials, compatibility, and the migration. The
[mobile auth flow](./mobile-auth-flow.md) and [OAuth setup guide](./oauth-setup.md)
describe the current system until implementation changes them.

Implementation evidence, decisions and the current no-go gate are recorded in
[the implementation ledger](./better-auth-implementation.md). The isolated
[OAuth prototype](./better-auth-prototype.md) and
[writer/installed-client inventory](./better-auth-writer-inventory.md) are
supporting evidence, alongside the [HTTPS browser](./better-auth-browser-proof.md),
[process replacement](./better-auth-process-proof.md) and
[pre-cutover refresh](./better-auth-legacy-refresh-proof.md) proofs. They do not
imply a production authority switch.

## Decisions and completion criteria

| Decision | Required outcome |
| --- | --- |
| Backend owns authentication | One identity and credential policy serves web, native, watch, and partner consent; Next.js does not remain an independent authority |
| Keep the installed-client protocol | Existing native and watch endpoints remain supported through a long-lived backend adapter; removing NextAuth does not require removing those endpoints |
| Email identity is case insensitive | Trimming and changing capitalization always resolves to the same account; database uniqueness prevents concurrent duplicate registration |
| Preserve ordinary sessions | No migration-induced mass logout, password reset, or forced application update; security-sensitive operations and exceptional ambiguous accounts may require verified recovery |
| Separate delivery gates | First-party migration and partner OAuth/API launch have separate acceptance and release gates; this planning PR does not implement either |

The debt being removed is split ownership: web-owned recovery, duplicate sign-in
logic, backend decryption of NextAuth cookies, and native signing coupled to
`NEXTAUTH_SECRET`. NextAuth is already self-hosted. Changing its name without
centralizing these responsibilities would leave the debt in place.

## Current contracts to inventory

| Surface | Current behavior that matters |
| --- | --- |
| Web | NextAuth v4 JWT sessions in potentially chunked cookies; shared production cookie domain; Google/Apple/Facebook links; credentials login; stale-tab sign-out guarded by user ID and `authSessionId` |
| Native | Email registration/login and Google/Apple ID-token login in `handlers/native-auth.ts`; browser fallback transfer-token exchange; `{ jwt, refreshToken, expiresAt, userId }` responses and optional account-creation receipt |
| Access credentials | Seven-day HS256 JWT, issuer `boardsesh`, audience `boardsesh-mobile`, `sub = users.id`; backend also accepts NextAuth JWE cookies |
| Refresh credentials | Opaque random token stored as a SHA-256 hash; each successful rotation issues another 90-day token; active old clients never naturally stop using this protocol |
| Watch | Garmin pairing issues the same native token pair; the watch cannot adopt browser cookies just because the phone updates |
| Recovery | Web registration, verification, forgot/reset password, and set-password routes; issued email links must remain usable for their original validity period |
| Storage | Stable `users.id` throughout product data; bcrypt in `user_credentials`; provider subject links in `accounts`; nullable verification timestamp; emails currently lack uniqueness |
| Offline | Native keeps established local identity through network/keychain failures; only confirmed credential rejection triggers logout; credential generations prevent stale work resurrecting an account |

Inventory actual callers, domains, redirect URIs, response fields, error/status
semantics, headers, cookie variants, account-deletion paths, export jobs, widgets,
and HTTP/WebSocket authentication before adding a new handler. The table is a
starting point, not permission to remove an unlisted consumer. Keep current
Google/Apple/Facebook application registrations and subject mappings.

The code supports duplicate-by-case credential lookup. That is evidence of a
compatibility requirement, not a current production count. A read-only audit
must establish the actual collision groups and affected login methods without
putting emails, password hashes, or tokens in GitHub issues or logs.

## Target ownership

```mermaid
flowchart LR
    Native[Installed mobile apps and watches] --> Compat[Existing protocol adapters]
    Web[Web account and consent pages] --> Auth[Backend Better Auth authority]
    Compat --> Auth
    Auth --> DB[(Postgres / Drizzle)]
    Apps[Third-party apps] --> OAuth[Better Auth OAuth Provider]
    OAuth --> Auth
    Apps --> API[Scoped public API]
    API --> Connections[Connection and scope checks]
    Connections --> DB
```

Better Auth owns identity, provider links, password policy, verification,
recovery, and canonical first-party session state. A backend compatibility
module translates existing request/response protocols and validates legacy
credentials against that same state. It must not grow a second registration,
password, or revocation policy. Any retained token family/lineage tables belong
to this authority and participate in its revocation transactions.

Third-party tokens are a separate security domain. They never pass through
first-party `validateToken`, never mint mobile credentials through a generic
exchange endpoint, and never acquire full GraphQL/WebSocket access. Separate
keys, purposes, audiences, and route guards are required even when both systems
use the same library and database.

Mount the new backend auth handler at `/api/auth`. Partner OAuth endpoints use
the provider's `/api/auth/oauth2/*` paths and published discovery metadata. The
old native/watch paths remain adapters. Web callback URLs and old recovery URLs
need forwarding or compatibility handlers during transition; do not change
provider registrations until both old in-flight callbacks and new callbacks
have a tested destination. Test cookie forwarding, origins, CSRF protection,
SSR, Expo web, and the existing native deep-link/browser fallback behavior.

## Identity and case-insensitive emails

Define one shared pure normalization function: trim surrounding whitespace and
lowercase the complete address. Do not strip plus suffixes, remove dots, or infer
provider aliases. Use the same rule for registration, credentials login,
forgot/reset password, verification/resend, email changes, and any allowed email
linking. Provider subjects remain the primary key for an existing social link.
That function is `normalizeAccountEmail` in `@boardsesh/auth-protocol/account-email`,
shared by web and backend. Until the unique index exists, lookups use the same
module's `resolveAccountEmail`: rows storing the typed text exactly win, then the
one row storing it in other capitals; several such rows name nobody.

The invariant is **one normalized email identity per account address**, enforced
by PostgreSQL, not a pre-insert application check. The spike must choose either a
normalized column with a unique constraint and enforced write normalization, or
an equivalent unique expression index compatible with Better Auth's lookups.
Every writer, including OAuth account creation and old web endpoints, must obey
it. Generate checked-in migrations with `vp exec drizzle-kit generate` from
`packages/db`; do not hand-write migration SQL or apply schema changes from a
library startup hook.

Resolve existing collisions before enabling the final unique invariant:

1. Audit exact duplicates, normalized collisions, whitespace variants, missing
   provider links, and verification states. Classify product data and credentials
   attached to each existing user ID.
2. Stop creating new collisions while cleanup runs. Route all account creation
   through the authoritative backend and use a database-enforced normalized-email
   reservation/serialization strategy that covers existing collision groups.
3. Produce an explicit resolution for each group. Prove ownership of accounts
   before linking or merging; do not select the first row, choose the oldest
   account, or treat possession of an unverified email as account ownership.
4. Preserve every tick, playlist, board, social relationship, provider link, and
   offline owner boundary. Any merge, data deletion, or reassignment requires a
   separately reviewed and approved resolution; this document authorizes none.
5. Validate the normalized unique constraint and exercise concurrent registration
   and OAuth races. The migration cannot be declared complete with ambiguous
   groups still hidden behind a permanent password-search workaround.

Unaffected accounts retain their existing `users.id`. If an approved collision
resolution changes an owner, specify the ID mapping, existing-session policy,
and offline-cache reconciliation explicitly; never silently redirect an old
session into another person's account. Ambiguous groups may need targeted
support. Preserve their authenticated access while resolving them where safe,
but do not issue reset links that choose an arbitrary account in the group.

New verification and recovery records bind to a **user ID, purpose, expiry, and
single-use secret**, with the intended address recorded where needed. Legacy
email-keyed links get an explicit safe resolution path for their remaining
lifetime; an ambiguous link must not reset whichever row happens to be first.
Address normalization must not invalidate an otherwise unambiguous issued link.

## Passwords and provider links

Import bcrypt hashes using a tested custom verifier; Better Auth's default
password hashing is scrypt. Preserve password bytes exactly. Do not rehash
stored hashes, require password resets, or alter Unicode handling as an incidental
migration step. Keep bcrypt writes during the rollback window unless every
remaining reader, including the rollback version, understands the new format.

Establish **one authoritative credential writer before copying credentials**.
Registration, password reset/change/set, provider linking/unlinking, verification,
email changes, and account deletion must use it. An additive backfill needs a
recorded cutover boundary and reconciliation so an older copied hash cannot
overwrite a concurrent reset. If temporary mirrored writes are necessary, they
must commit atomically in the same Postgres transaction; a best-effort hook or
background dual-write is insufficient. Prove the adapter transaction boundaries.

Better Auth's credential account and user/session schemas differ from ours.
Keep compatibility columns/tables while old readers exist, preserve verification
timestamps, and map their meaning to the library's boolean without marking
unverified accounts verified. Adding constraints or changing column types in
place is not a safe coexistence strategy. Backfills must be idempotent and
report count/mapping discrepancies before traffic moves.

Import social links by `(provider, provider subject)` against the existing user
ID, including Apple private-relay identities. Email matching alone is not an
import strategy. Retain established links even if a provider changes its email
claim. Configure account linking deliberately; do not weaken verification rules
to imitate `allowDangerousEmailAccountLinking`.

Test Google, Apple, and Facebook on the surfaces where they are currently
supported, including cancellation, native nonce/audience checks, existing links,
and browser fallback. Better Auth's ID-token sign-in rejects a missing email
before resolving a linked account in the reviewed version. Prove a supported
persisted-email mapping for that case. Apple's own documentation says email
normally remains in later identity tokens, so this is an edge-case test rather
than a claim that all returning Apple sign-ins fail.

## Session bridge and revocation

A valid old credential proves its established identity, not that its holder just
signed in. Bridge only after full signature/decryption, issuer/audience where
applicable, expiry, user-state, and revocation checks. Never trust a client-side
JWT decode as authorization.

Record a stable legacy identity/credential lineage, canonical session, original
expiry, migration time, and authentication age when known. Preserve trustworthy
age; when it is unknown, mark the migrated session non-fresh and require actual
reauthentication for sensitive actions. Better Auth uses `createdAt` for its
normal freshness test: creating a row with the current time must not upgrade an
old cookie's assurance. The spike must prove supported implementation of this
rule; disabling freshness checks is not an acceptable workaround.

Repeated exchange must be idempotent while the session is valid and fail after
revocation. Persist revocation tombstones for the entire remaining validity of
the legacy credential and its descendants. A legacy `authSessionId` can help
identify lineage, but not every historic token has one. When stable per-session
lineage cannot be recovered, use a documented account-wide cutoff or require
reauthentication; do not claim device-specific revocation that the old token
format cannot enforce. Credential `iat` on a renewed token is not proof of
recent password/provider authentication.

| Event | Required behavior during coexistence |
| --- | --- |
| Ordinary session migration | Preserve access and normal renewal without granting fresh-login privileges |
| Sign out / revoke a session | End the canonical session and all credentials linked to it; old cookies/JWTs cannot mint it again |
| Account recovery / compromised-account revocation | Invalidate all first-party credentials and exchange paths for that user, and end active third-party connections; enforce the same cutoff in every legacy validator |
| Ordinary first-party sign-out | Does not by itself end an explicitly approved offline partner connection |
| Connected Apps disconnect | End that app's connection, applicable token families, and pending workouts; preserve unrelated app connections |

Existing signed JWTs do not become revocable merely because new Better Auth
sessions are database-backed. Every first-party request validator and bridge
must consult canonical revocation state. Bound or invalidate caches across
instances, and specify what happens to an already-authenticated WebSocket after
revocation. Fail closed for online protected operations when revocation state
cannot be read; keep the app's offline local-state policy separate.

Use separate new signing/encryption secrets and purpose-specific legacy
verification keys. Stop old issuance before considering a legacy key retired.
Never retire keys on a guessed 90-day timer while active old clients are still
renewing credentials. New compatible JWTs may preserve their public claim shape
while being issued and revoked by the new authority; prove the key transition
against every backend instance and supported client.

### Credential stamps (BA-04 PR 1)

Every credential issued from BA-04 PR 1 on records what a later reader needs to
end it. Every reader decides them from BA-04 PR 2 on ("Credential cutoffs" below).

| Credential | Stamps | Renewal |
| --- | --- | --- |
| Native JWT | `gen`, `ngen` (the `auth_subject_cutoffs` generation and native generation, 0 with no row); `auth_time` for a password, registration or provider sign-in only | Via refresh |
| Native refresh row | `subject_generation`, `native_generation`, `authenticated_at`, `session_id` | A child copies all four, so a rotation never makes a sign-in newer |
| Pre-stamp refresh row (all NULL) | none | Its child is stamped generation 0 and 0, keeps an unknown `authenticated_at`, and gets a new `session_id` its descendants keep |
| Web JWE | `gen` beside the existing `auth_time` | A rotation keeps `gen`; a cookie from before the claim is stamped 0 |

A transfer token or watch code hands over a login made elsewhere, so what it
mints has no `auth_time`. `native_generation` exists so an app sign-out can end
the app's and watch's credentials and leave the website signed in, so the web
JWE carries no `ngen`.
Stamping 0 where a generation is unknown is safe because generations only rise:
a low stamp can end a credential sooner, never let it outlive a reset.

The native issuer reads the generations in a statement that starts after it holds
`users FOR KEY SHARE`. The locking statement's own snapshot is taken before it
waits, so it misses a reset that held `users FOR UPDATE` and committed during
that wait.

### Credential cutoffs (BA-04 PR 2)

One pure function, `decideCredential` (`packages/backend/src/auth/credential-cutoffs.ts`),
decides every first-party credential from its stamps and the climber's state.
Every reader calls it: the HTTP and GraphQL validators (`middleware/auth.ts`,
`handlers/auth-admission.ts`), the WebSocket handshake, subscribe check and
one-second sweep (`websocket/setup.ts`), and the native refresh issuer. The web
(`credential-admission.server.ts`) sends the exact cookie to the backend's
`authenticatedUserId`, so it gets the same answer.

| Credential | Used while | Authentication age |
| --- | --- | --- |
| Web JWE without `gen` (before PR 1) | generation is 0, `authSessionId` not denied | `auth_time` if present, else unknown |
| Web JWE with `gen` | `gen` equals generation, `authSessionId` not denied; native generation is never compared (decision 10) | `auth_time` if present, else unknown |
| Native JWT without `gen`/`ngen` | generation and native generation are both 0 | unknown |
| Native JWT with `gen`, `ngen` | both equal the current generations | `auth_time` if present, else unknown |
| Refresh row with NULL stamps | not revoked, both generations 0 | unknown |
| Refresh row with stamps | not revoked, both stamps equal the current generations | `authenticated_at` if present, else unknown |
| Any, account deleted or missing | never | n/a |

- A missing stamp stands for 0. A stamp present but not a whole number of at
  least 0 is refused. A stamp must equal the generation: higher is refused too.
- Age is read only from `auth_time` or `authenticated_at`, never from whether
  `gen` is there: a transfer token or watch code mints `gen` without `auth_time`.
  Nothing requires fresh authentication yet; BA-04 PR 9 adds that check.
- A refresh whose parent no longer matches is answered 401 and mints nothing.
  A child copies its parent's stamps, so without this the app would get a token
  pair every reader refuses and loop refresh, 401, refresh. The app signs out.
- No query is added. The admission read already joined `auth_subject_cutoffs`
  for `deleted_at`; it now also returns `generation` and `native_generation`
  from the same statement. Plan, buffers and timing are unchanged
  (docs/db-connectivity.md, "Admission reads have their own pool").
- The decision also takes denied web logins (`authSessionId`). No table holds
  them until BA-04 PR 6 and nothing writes one until web sign-out does (PR 9),
  so the read returns none today.

**A refused credential is answered, never served as signed out.** GraphQL HTTP
and the WebSocket handshake take an optional credential. One that is expired,
not signed by us or unreadable still runs as anonymous, so public reads keep
working. One we signed that `decideCredential` refuses (deleted or missing
account, a cutoff, a malformed stamp) does not:

| Transport | Answer |
| --- | --- |
| GraphQL HTTP | 401, body `{"errors":[{"message":"Authentication is required","extensions":{"code":"UNAUTHENTICATED"}}]}` |
| WebSocket handshake | closed 4401 before any ACK |

Served as anonymous, a phone that reconnects after a reset kept showing a
signed-in climber whose every action failed with "Authentication required",
until its proactive refresh up to about 6 days later. On a 401 or 4401 every
shipped app (2.0 onwards) refreshes once; the refresh answers 401 for the same
credential, and the app signs out. The Garmin watch does the same and returns to
pairing. The web reader (`credential-admission.server.ts`) reads this 401 as a
denial, and the 200 a backend from before this answered for the same cookie.
Under `observe` only a deleted account is refused, so only it gets 401 or 4401.

**Unavailable is never denied.** A read that fails or misses its deadline answers
503 on HTTP, refuses a new socket with 1013, and never closes an open socket from
the sweep, even when the generation has in fact moved; the socket closes 4401 on
the first sweep that can read it. A socket that starts a subscription during an
outage is still closed with 1013 so the client reconnects (unchanged since #7350).

**`AUTH_CUTOFF_ENFORCEMENT`** (backend, default `enforce`):

| Value | Effect |
| --- | --- |
| unset, empty, `enforce` | Every denial above is refused |
| `observe` | A credential refused only by a cutoff (generation, native generation, denied login, malformed stamp) is used anyway and logged as `observed`: the behaviour of the build before PR 2. A deleted account is still refused |

The backend refuses to start with `observe` while any staged writer mode is on
(`CURRENT_STORE_WEB_AUTH_MODE`, `CURRENT_STORE_WEB_OAUTH_MODE`,
`CURRENT_STORE_NATIVE_REGISTRATION_MODE`, `CURRENT_STORE_NATIVE_OAUTH_MODE`,
`CURRENT_STORE_SYSTEM_BOARD_OWNER_MODE`, `CURRENT_STORE_ACCOUNT_DELETION_MODE`,
`CURRENT_STORE_BATCH_SYSTEM_USERS_MODE`), or with any other value. Each staged
command also refuses its authority under `observe`, so a reset never bumps a
generation that no reader enforces.

**Logs.** `[auth-cutoff] credential refused by a cutoff` with `reader`
(`request`, `socket-sweep`, `refresh`), `outcome` (`denied` or `observed`) and
`reason`, once per kind per 10 s with a count line after. No user ID, token or
claim. Deletions are not logged here. The web logs
`auth_generation_read_unavailable` and sends it to Sentry as a warning when its
sign-in read of the generation fails; that sign-in is stamped 0 and, for a
climber whose generation has moved, answered 401 before any cookie is sent.

With no cutoff rows, which is production until a staged writer mode is on, every
generation is 0 and every existing credential matches, so nobody is denied. Once
any cutoff row exists, this build is the rollback floor
(docs/production-deploy.md, "Credential cutoff rollback floor").

### Per-user locks (BA-04 PR 3)

Until this PR every staged command took `FOR UPDATE` on the one current
`auth_email_projection` row, so one slow transaction, or a burst of sign-ins
naming an account being deleted, stalled every staged command for everyone.
That row lock is gone. Commands now meet only on the climber they touch:

| Step | Lock | Who |
| --- | --- | --- |
| 1 | `pg_advisory_xact_lock_shared(6975, 2)`, then the manifest read without a row lock | every staged command; shared, so commands never wait for each other |
| 2 | the address's creation lock, before its reservation row is read (and a provider subject's lock before its link) | registration, provider sign-in, system identities |
| 3 | the climber's `users` row: `FOR UPDATE` to write, `FOR KEY SHARE` to sign in | everything; a reservation owner is read unlocked, its row locked, then the reservation locked and re-checked |
| 4 | reservation, cutoff, credentials and accounts, purpose state and receipts, refresh rows | in that order |

Only an authority switch or activation takes the gate exclusively, with a 2 s
lock limit (`lockAuthorityGateExclusively`). Account deletion takes the gate at
its first statement and keeps its wall-before-user order; its bookkeeping takes
the reservation after the user row, the same order every command uses, so a
command waiting on a deleting account holds nothing the deletion needs. Only the
gate wait and the bookkeeping run under the 5 s statement and 4 s lock limits;
content and the cascade keep the connection's own (45 s on the backend).

A sign-in, forgot-password or resend-verification gives up on a held climber
row after 250 ms and answers the retryable unavailable reply (503), never a wrong
password; reset, verify, set-password and deletion keep 4 s. A web sign-in whose
password matched no one takes no user lock. Through one backend's own pool of
five connections, with a deletion holding one account and 16 wrong-password
sign-ins plus 4 forgot-passwords naming it, an unrelated web sign-in took 287 to
326 ms and a native one 17 to 28 ms. At the earlier 4 s limit, 16 wrong-password
sign-ins through the same pool made an unrelated web sign-in wait 16 s.

**What changes for a live sign-in.** No `CURRENT_STORE_*` mode is on in
production, so the only live code touched is native issuance:

- Password sign-in gives up on a held user row after 250 ms instead of 4 s and
  answers 503 "Authentication is temporarily unavailable", which the app retries.
  The only long holder in production is a deletion of that same account.
- Password sign-in reads the hash and generation with the bcrypt candidates (one
  more join in the same statement), and the issuer's post-lock statement re-reads
  them (a join on `user_credentials` in the statement that already read the
  generation). If either moved, the answer is 401 "Invalid email or password"
  and nothing is issued. Same statement count as before.
- Refresh takes the user lock and reads the generations once, then decides the
  parent on them. It used to take the lock and read them twice. Five statements
  fewer per refresh.
- `recordSecurityMutation` takes `users FOR UPDATE` itself, so every generation
  writer excludes an issuer holding `users FOR KEY SHARE`.

Measured on the local test Postgres, the same handlers over HTTP, legacy modes,
before and after, three alternating rounds (median per round):

| Path | Before | After |
| --- | --- | --- |
| Native password sign-in, bcrypt cost 10, 40 runs | 55.6 to 57.7 ms | 57.0 to 57.9 ms |
| Native password sign-in, bcrypt cost 4 (database share), 300 runs | 3.04 to 3.53 ms | 3.11 to 3.21 ms |
| Native refresh, 300 runs | 3.44 to 3.93 ms | 2.55 to 2.75 ms |
| Statements per sign-in / per refresh, besides BEGIN and COMMIT | 7 / 11 | 7 / 6 |
| Unrelated staged sign-in while a deletion holds another account and 16 sign-ins name it | 3,942 to 3,962 ms | 21 to 25 ms |

The first row's spread is bcrypt's; the second isolates the database work.

**Known gap, staged web only.** The web stamps a password sign-in's cookie with a
generation it reads after the backend's `authenticated` reply
(`auth-options.ts`, `signInGeneration`). A reset committing in that gap yields a
cookie stamped with the new generation from a password checked before it. The
reply should carry the generation the backend checked; that is a protocol change
for a later PR and has no reach while `CURRENT_STORE_WEB_AUTH_MODE` is off.

## Native, watch, and browser compatibility

The compatibility API is an accepted long-lived product contract. It preserves
request paths, body/response fields, JWT subject/issuer/audience, refresh
rotation, status semantics, and watch pairing. The new authority can own those
credentials without making old installations understand Better Auth cookies.
Do not promise a fixed adapter retirement date. Retirement requires an explicit
client-support decision and evidence about active installations.

Preserve existing SecureStore keys through migration or provide a tested
transactional handoff. Keep refresh-before-access-token persistence, concurrent
refresh deduplication, and generation checks after asynchronous work. Exercise
logout/account-switch races, partial keychain writes, and interrupted migration.

Network failure, rate limiting, server unavailability, and transient storage
failure must not be collapsed into invalid credentials. Preserve downloaded
boards and pending offline mutations during those failures. A confirmed expired
or revoked credential follows the current account-isolation cleanup. Offline
local identity never permits an expired token to authorize a server request.

For web and Expo web, preserve HttpOnly credential handling, cookie chunk cleanup,
shared-domain transitions, SSR authentication, and stale-tab sign-out protection.
Never move browser tokens into AsyncStorage, localStorage, or IndexedDB. Test
cross-origin requests and cookies rather than assuming the native Expo plugin
implements the browser deployment contract.

## Proof gates before rollout

Use a pinned, mutually compatible Better Auth/core/provider/Drizzle/Expo package
set. The research reviewed Better Auth v1.7.14; that is evidence, not permission
to install an unbounded latest version or a claim that a Boardsesh prototype has
passed. Record the tested versions, schema output, and results in the spike.

| Gate | Evidence required |
| --- | --- |
| Identity | Existing IDs, bcrypt credentials, verification state, provider subjects, and normalized email collisions handled; parallel account creation cannot duplicate an identity |
| Lifecycle | All credential writers use one authority; outstanding recovery links survive safely; concurrent reset/backfill/link operations cannot restore old state |
| Session security | Old web/native credentials migrate without becoming fresh; revoke/reset blocks replay through every path; cache and WebSocket behavior proven across two backend instances |
| Installed clients | Existing mobile, watch, web, and Expo web flows work; offline/partial-write/account-switch tests preserve owner isolation and pending work |
| Partner authorization | PKCE S256, exact callbacks, opaque scoped tokens, code/refresh single-use races, replay handling, and whole-connection disconnect pass independently of first-party session tests |

The provider must not require a private fork or an alternate credential authority
to meet these invariants. If a proof fails, record the missing supported hook or
semantic guarantee and revisit the design before rollout. Keeping current auth
temporarily is a possible delivery decision, not an automatic fallback silently
installed alongside Better Auth.

## Rollout, rollback, and retirement

Start with additive schema and a read-only inventory, then route lifecycle writes
through one authority. Rehearse import/backfill and compatibility in an isolated
environment before moving selected test accounts. Increase migration cohorts
only after checking login/refresh/recovery success, bridge failures, owner
mismatches, and latency against the old path. Logs contain reason codes and
internal correlation identifiers, never passwords, cookies, tokens, or raw email.

Set numerical stop thresholds from a measured baseline in the rollout issue,
including zero tolerated account-owner mismatches or accepted revoked credentials.
Have an operator-owned switch to stop new migrations without breaking already
migrated sessions or letting old writers resume independently.

Rollback means returning traffic to a compatible application version while
preserving the current authoritative credential state. It does not mean restoring
a stale database snapshot. Rehearse rollback after registration, password reset,
email change, provider linking/unlinking, session revocation, and partner disconnect.
Old passwords and revoked tokens must remain invalid; newly registered users
must still sign in. Retain additive schema and the compatibility authority until
that rollback window is deliberately closed.

Retire NextAuth issuance, callbacks, server/client APIs, adapters, and dependency
only when callers have moved and in-flight browser/recovery flows are covered.
Retire legacy verification separately, with measured issuance/usage and bounded
credential validity. Keep old native/watch endpoint adapters under the agreed
support policy. Update current-operation guides as each stage ships; do not
describe the target as current behavior prematurely.

## Implementation backlog

The linked epic and child issues below are the implementation source of truth.
This PR documents and creates that work; merging it does not complete the epic.

Epic: [#6975: Epic: migrate to one self-hosted Better Auth authority without user disruption](https://github.com/boardsesh/boardsesh/issues/6975).

| Work | Issue | Depends on |
| --- | --- | --- |
| BA-01: auth: prove Better Auth migration and OAuth Provider compatibility | [#6976](https://github.com/boardsesh/boardsesh/issues/6976) | — |
| BA-03: auth: centralize existing credential writes and recovery before migration | [#6977](https://github.com/boardsesh/boardsesh/issues/6977) | [#6976](https://github.com/boardsesh/boardsesh/issues/6976) |
| BA-02: Normalize account emails and add a case-insensitive unique index | [#4847](https://github.com/boardsesh/boardsesh/issues/4847) | [#6976](https://github.com/boardsesh/boardsesh/issues/6976), [#6977](https://github.com/boardsesh/boardsesh/issues/6977) |
| BA-04: auth: migrate identity authority and bridge legacy session lineage | [#6978](https://github.com/boardsesh/boardsesh/issues/6978) | [#6976](https://github.com/boardsesh/boardsesh/issues/6976), [#4847](https://github.com/boardsesh/boardsesh/issues/4847), [#6977](https://github.com/boardsesh/boardsesh/issues/6977) |
| BA-05: auth: migrate web and Expo web without changing account behavior | [#6979](https://github.com/boardsesh/boardsesh/issues/6979) | [#6977](https://github.com/boardsesh/boardsesh/issues/6977), [#6978](https://github.com/boardsesh/boardsesh/issues/6978) |
| BA-06: auth: preserve native and Garmin clients through the compatibility facade | [#6980](https://github.com/boardsesh/boardsesh/issues/6980) | [#6977](https://github.com/boardsesh/boardsesh/issues/6977), [#6978](https://github.com/boardsesh/boardsesh/issues/6978) |
| BA-07: auth: add isolated partner OAuth with explicit token lifecycles | [#6981](https://github.com/boardsesh/boardsesh/issues/6981) | [#6976](https://github.com/boardsesh/boardsesh/issues/6976), [#6977](https://github.com/boardsesh/boardsesh/issues/6977), [#6978](https://github.com/boardsesh/boardsesh/issues/6978) |
| BA-08: integrations: connect developer registration, consent, and Disconnect to OAuth | [#6982](https://github.com/boardsesh/boardsesh/issues/6982) | [#6979](https://github.com/boardsesh/boardsesh/issues/6979), [#6981](https://github.com/boardsesh/boardsesh/issues/6981) |
| BA-09: auth: validate and roll out the migration with mutation-safe rollback | [#6983](https://github.com/boardsesh/boardsesh/issues/6983) | [#6979](https://github.com/boardsesh/boardsesh/issues/6979), [#6980](https://github.com/boardsesh/boardsesh/issues/6980) |
| BA-10: auth: retire NextAuth while retaining supported compatibility contracts | [#6984](https://github.com/boardsesh/boardsesh/issues/6984) | [#6983](https://github.com/boardsesh/boardsesh/issues/6983) |

The first sequence is prototype → centralize current-store writers → resolve
email collisions and enforce uniqueness → import into Better Auth and bridge
sessions. Web and native/watch adoption then proceed independently. Partner
authorization has its own readiness gate. BA identifiers are stable tracking
labels; the dependency column determines execution order.

The email work reuses #4847 rather than creating a duplicate. Its original
2026-08-28 measurements remain historical context; a fresh audit is required.

## Research references

| Source | What it establishes |
| --- | --- |
| [Auth.js migration guide](https://better-auth.com/docs/guides/next-auth-migration-guide) | Schema and client/API migration; not a turnkey import of existing NextAuth sessions |
| [Drizzle adapter](https://better-auth.com/docs/adapters/drizzle) and [database model](https://better-auth.com/docs/concepts/database) | PostgreSQL/Drizzle integration and model mapping; our repository still owns migrations |
| [Password configuration](https://better-auth.com/docs/authentication/email-password#configuration) | Default scrypt, configurable hash verification, credential-account storage |
| [Session management](https://better-auth.com/docs/concepts/session-management) | Creation-time freshness and revocation/cache behavior that the bridge must respect |
| [Expo integration](https://better-auth.com/docs/integrations/expo) | Native integration support; not proof of Boardsesh offline/storage semantics |
| [Apple setup](https://better-auth.com/docs/authentication/apple) and [Apple's identity guidance](https://developer.apple.com/documentation/signinwithapple/authenticating-users-with-sign-in-with-apple) | Native audiences and the distinction between first-response profile fields and later ID-token email claims |
| [OAuth Provider](https://better-auth.com/docs/plugins/oauth-provider) | Custom scopes, PKCE, offline access, token revocation, consent deletion, and immediate secret rotation; product connection policy remains integration work |

Better Auth is selected for its Node/TypeScript/Postgres fit and ability to
consolidate first-party authentication and third-party authorization. Ory
Kratos/Hydra remains a viable service-based alternative with more operational
components; keeping current auth plus a maintained OAuth server avoids an
immediate identity migration but leaves ownership split. Neither alternative
removes the email cleanup, session compatibility, or rollback obligations above.
