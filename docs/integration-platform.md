# Integration platform: how third-party apps connect to Boardsesh

This is the canonical design for every third-party integration. A climbing
app, a training planner, a coach's spreadsheet script or somebody's weekend AI
project all connect the same way: register an app, send the climber through
OAuth, read what the climber allowed, keep it in sync. No app gets a private
endpoint, a hand-made client row or a scope nobody else can ask for.

Written 2026-10-27, after the Sequence workout spec (#5530) and the DivePeaks
logbook request. The target is that the cost of one more ordinary integration is
zero engineering time on our side.

Status, 2026-11-10: milestone 1 is built behind `PARTNER_OAUTH_MODE`, which is
`off` in production. It shipped on the fast path: on today's identity system,
ahead of the Better Auth migration (see [Roadmap](#roadmap)). Turning it on, and
the stages that follow, are in [Running partner OAuth](#running-partner-oauth).

| Doc | What it holds |
| --- | --- |
| This file | The architecture, the decisions and their alternatives, the risks, the roadmap and the acceptance test |
| [partner-api.md](./partner-api.md) | The contract an app developer builds against: OAuth, the logbook, workouts, webhooks, errors, limits, versioning. It becomes the public developer docs in milestone 2 |
| [partner-workouts-internal.md](./partner-workouts-internal.md) | The design behind the workouts part of the API (milestone 3): the workout row, the `/w/` launch link, the mobile pre-session card, results |
| [integration-consumers.md](./integration-consumers.md) | What Sequence and DivePeaks each need, mapped onto the API above. Test cases, not specs |
| [better-auth-migration.md](./better-auth-migration.md) | Moving first-party identity and sessions to Better Auth, including old native apps and Garmin watches, rollout gates and rollback |

The `partner-*` file names are historical (code comments cite them by name).
The documents themselves no longer use "partner": every integrator is an
**app**, the person who registers it is a **developer**, the Boardsesh user is
the **climber**, and a climber's approval of one app is a **connection**
(an application-owned connection record, independent of any one token).

---

## Contents

1. [What an app can and cannot do](#what-an-app-can-and-cannot-do)
2. [Decisions](#decisions)
3. [Assessment of the Sequence plan](#assessment-of-the-sequence-plan)
4. [Authorization server](#authorization-server)
5. [Self-service registration](#self-service-registration)
6. [The public API](#the-public-api)
7. [Incremental sync](#incremental-sync)
8. [Data boundaries and LEGAL.md](#data-boundaries-and-legalmd)
9. [Operations](#operations)
10. [Running partner OAuth](#running-partner-oauth): the owner's runbook
11. [Webhooks (later)](#webhooks-later)
12. [Developer experience](#developer-experience)
13. [Roadmap](#roadmap)
14. [Acceptance test: an agent integrates alone](#acceptance-test-an-agent-integrates-alone)
15. [Open questions](#open-questions)

---

## What an app can and cannot do

An app acts for one climber at a time, with that climber's approval, inside
the scopes the climber saw on the consent screen.

| Scope | Grants | Milestone |
| --- | --- | --- |
| `logbook:read` | Every tick the climber has logged on any board: date, climb, board type and layout, angle, status, attempts, grades, stars, their comment. Includes ticks whose Boardsesh audience is "only me" | 1 |
| `profile:read` | The climber's display name and avatar URL | 1 |
| `workouts:write` | Create and cancel planned workouts for the climber | 3 |
| `workouts:read` | Read a workout the app created, with its results | 3 |
| `offline_access` | Keep a refresh credential for the other granted scopes when the climber is away | 1 |

Not available, by design, at any milestone on this roadmap:

- Other climbers' data. Party sessions mix climbers; an app only ever sees
  ticks whose `user_id` is the connected climber.
- Board catalogs in bulk: hold positions, climb lists, setter lists,
  community stats. A tick carries a summary of the climb it is on (id, name,
  grade, board) and nothing else. Apps that want a catalog use the public
  nightly snapshots ([board-snapshots-dataset.md](./board-snapshots-dataset.md)).
- Board control, queues, party sessions, Bluetooth. Those are what LEGAL.md
  means by using Boardsesh "as its service", and they stay first-party.
- Writing ticks. Possible later as `logbook:write`; nobody has asked yet.
- Acting without a climber (client-credentials tokens). Nothing in the first
  use cases needs it.

---

## Decisions

Each decision has the alternative it beat. "Kept" means the Sequence plan
(#5530) already decided it and this design keeps it.

### D1. Boardsesh is the OAuth authorization server (kept)

Apps get scoped, revocable tokens from us; nobody hands an app a Boardsesh
password, and Apple, Google and email/password accounts all work the same way
because the consent page only needs the climber to be signed in to
boardsesh.com. The rejected shape (Boardsesh as an OAuth *client* of each app,
like Strava) is in [partner-workouts-internal.md](./partner-workouts-internal.md):
it asks every small app to run an identity provider.

### D2. Self-hosted Better Auth for identity and OAuth

Better Auth, with `@better-auth/oauth-provider`, is the selected direction.
It runs in the existing Node backend with Postgres through Drizzle. Next.js
renders the login and consent pages; it no longer owns identity decisions.
The first-party migration is specified separately in
[better-auth-migration.md](./better-auth-migration.md) ([epic #6975](https://github.com/boardsesh/boardsesh/issues/6975)). It preserves ordinary
sessions and includes a maintained compatibility API for old native apps and
Garmin watches, all backed by the same identity authority. Security events may
require real reauthentication. The partner API does not ship merely because
the identity migration has shipped, or vice versa.

Partner OAuth ships first, on the fast path. Better Auth runs only as the OAuth
server: it reads `users` and never writes it, email and social sign-in are off,
and NextAuth keeps first-party sign-in. Consent reads the www NextAuth cookie on
every request, and a database trigger on `user_credentials` ends connections
when a password changes. The rest of this decision, moving first-party identity
to Better Auth, follows on its own schedule ([Roadmap](#roadmap)).

| Option | Assessment |
| --- | --- |
| **Better Auth + OAuth provider** | Chosen: one TypeScript identity authority and authorization server in our backend. Requires proving native login, session migration, database mapping and the OAuth configuration below |
| Existing auth + `oidc-provider` | Preserves today's login implementation but leaves identity/session ownership split between web and backend. Retained as a comparison, not an automatic fallback |
| Ory Kratos + Hydra | Self-hosted identity and OAuth services with a larger operational footprint; OSS release and commercial-feature differences need separate assessment |
| Keycloak | A standalone identity server; native sign-in and existing-session preservation would require a separate migration proof |
| Hand-written authorization server | Rejected: we would own protocol implementation and its security maintenance |

The initial compatibility investigation pins Better Auth and the provider to
**1.7.14**. Pin matching versions in implementation and re-run the gates on
upgrades. The [provider documentation](https://www.better-auth.com/docs/plugins/oauth-provider)
describes supported integration points; the pinned source and tests settle
version-specific behavior. No undocumented internal hook is assumed here.
If a gate fails, stop that rollout and revise the decision explicitly. Do not
quietly add a different provider, fork protocol code, or launch weaker behavior.

The milestone 0 proof must cover these independent gates:

1. **Identity compatibility.** Import existing IDs, bcrypt credentials,
   provider subjects and verified state; preserve browser/native sessions and
   old device contracts as the migration doc requires. Email identity is
   case-insensitive across every entry point. Audit and resolve collisions
   before enforcing database uniqueness; never merge accounts automatically
   just because normalizing an address makes them collide.
2. **Web and native auth boundary.** Mount the supported Node handler under
   `/api/auth`, with issuer `https://api.boardsesh.com/api/auth`. Prove SSR,
   cookie scope, CSRF, trusted origins, continuation parameters and a complete
   `www` login/consent round trip in Safari on iOS and Chrome on Android.
   Existing and newly issued first-party credentials resolve through one
   authority, including revocation and password recovery.
3. **OAuth configuration.** Enable only authorization-code and refresh grants,
   S256 PKCE for all clients, published application scopes and `offline_access`.
   Disable open dynamic registration and client-credentials grants. Configure
   opaque access tokens (`disableJwtPlugin: true`) for the exact resource
   `https://api.boardsesh.com/v1`, and validate client type independently from public/confidential
   authentication. Native clients get the allowed loopback/private-scheme
   behavior; browser clients keep web redirect validation. Prove token use
   after first-party session expiry/sign-out and rotation beyond day 90.
4. **Atomic protocol and connection lifecycle.** Race authorization-code and
   refresh redemption against two backend instances using real Postgres.
   Only one concurrent redemption may issue a usable successor; replay
   detection and connection disconnect must invalidate all intended artifacts
   even when issuance races revocation. Demonstrate supported transaction and
   extension points; a check followed by a write is not sufficient. Verify
   the token-vs-connection revocation rules below, secret rotation, suspension,
   password reset, account deletion and rollback.
5. **API integration.** Prove discovery at the issuer's metadata URL, accurate
   advertised auth methods, uncached opaque-token introspection and resource
   binding for public and confidential apps, per-app CORS including errors,
   distributed rate limits, and the complete adversarial suite below. Record
   p95 authentication cost and database load. No cached positive result may
   keep a disconnected connection usable.

App registration, consent presentation, connection lifecycle, abuse controls
and the resource API remain Boardsesh code. Better Auth owns credential and
protocol mechanics. OpenID Connect sign-in and MCP registration remain later
features, each with its own configuration and acceptance tests.

### D3. REST with an OpenAPI contract, not the internal GraphQL schema

The internal GraphQL schema is the mobile app's API. It changes every week,
its shapes follow the mobile SQLite tables (`syncTicks` returns snake_case
rows with internal columns), and its auth context is a full user session.
None of that can become a promise to outside developers.

| Option | Verdict |
| --- | --- |
| Versioned REST under `/v1`, described by a committed OpenAPI 3.1 document | **Chosen.** Small surface, explicit scopes per route, cursor pagination is natural, rate limits map to routes, and every coding agent and code generator already understands OpenAPI. The web `/docs` page already renders Swagger UI from zod with `@asteasolutions/zod-to-openapi` |
| A second, constrained public GraphQL schema | Unknown clients write unknown queries; cost limits help but a sync contract wants one access path we can index for. Deprecation-by-field is a weaker contract than a path version. It would also share Yoga and its plugins with the internal schema, which is the coupling D5 forbids |
| Expose `syncTicks` and friends with OAuth tokens | Turns the offline-sync wire format into a public contract |

The `/docs` page also publishes the internal GraphQL SDL today. Milestone 2
labels that tab "internal, unsupported, changes without notice" and points
integrators at the REST API.

### D4. Opaque tokens and explicit connection revocation

Access tokens live 1 hour, refresh tokens 90 days and rotate on every use,
authorization codes 60 seconds and work once. Access tokens are opaque and
looked up in storage on every API call, so revoking a connection takes
effect on the next request. These lifetimes are configured and tested, not
inferred from library defaults. Refresh requires explicit `offline_access`;
it remains usable after an ordinary first-party sign-out. The acceptance
tests cover rotating refresh tokens after 90 days of continuous use.

RFC 7009 token revocation and disconnect are different operations. Revoking
an opaque access token removes that token; its refresh credential may still
work. Revoking a refresh token removes it and its associated access tokens,
not every independently issued credential for that climber and app. Disconnect
invalidates the whole connection, all its token families and remembered
consent, and revokes unfinished workouts. Neither tokens nor client IDs carry
a promised prefix or length; the provider generates them and clients treat
them as opaque strings.

### D5. API tokens never pass `validateToken` (kept)

`packages/backend/src/middleware/auth.ts` `validateToken` is the first-party
identity for `/graphql`, sessions, everything, with a 60-second success
cache. An API token that satisfied it would be a full account session with a
different label. API tokens are checked by their own function on their own
router (`/v1/*`), with no cache. The migration's first-party compatibility API
is not an exception: an app's OAuth token cannot call native auth, Garmin,
GraphQL, the developer console or a first-party session endpoint.

### D6. A transactional change log first, webhooks later

Revised 2026-10-27 after review. The first draft reused the phone's sync
cursor: `(updated_at, id)` with a 30-second stability window. That cursor can
permanently miss a row whose transaction commits more than 30 seconds after it
started, and the draft papered over the gap with a monthly full resync. A
monthly resync is reconciliation, not a guarantee, and does nothing for an app
that stops syncing before it runs.

The public feed bootstraps from a complete, bounded snapshot of the climber's
current public logbook, then reads a change log written by a trigger in the same
transaction as every tick write, and only serves entries below the Postgres
transaction horizon, the oldest transaction still in flight. Nothing below the
horizon can still commit, so the feed never moves past a change that could
later appear. The protocol, its guarantees and its proof are in
[Incremental sync](#incremental-sync). Webhooks arrive in milestone 4 as thin
"go sync" notifications, never as the only copy of data.

### D7. Self-service registration from milestone 1

The Sequence plan had "no self-serve portal in v1: send us your redirect
URIs". That is the one decision this design reverses outright: a hand-seeded
client row is a private channel, and the first consumers would be built on
it. A signed-in climber with a verified email registers an app on a web page,
gets a `client_id` (and a secret if confidential) on the spot, and can use it
immediately. Early access is the same page behind a flag, not a different
path.

### D8. Each app sees its own id for a climber

`GET /v1/me` returns `usr_` plus a random id minted the first time a climber
connects that app (`oauth_subjects`), stable across reconnects. It is not
`users.id`. Two apps cannot join their data on it, and the public contract
does not leak an internal key. Today the row is minted on the app's first
`GET /v1/me` (22 base-62 characters, 130 random bits); Disconnect never
deletes it, so a reconnect reads the same id.

### D9. A stable public hostname: `api.boardsesh.com`

The Sequence plan used `ws.boardsesh.com`. The backend host has moved once
and may move again (#6632, #5700). `api.boardsesh.com` is a proxied CNAME to
the same backend service, managed in `infra/cloudflare` like `ws`, so a
backend move never changes a URL a developer stored. The OAuth issuer and
every OAuth endpoint (`/api/auth/oauth2/authorize`, `/api/auth/oauth2/token`,
`/api/auth/oauth2/revoke`, and metadata under the `/api/auth` issuer) live on
`api.boardsesh.com`, where Better Auth runs. Only
the screens a climber looks at (sign-in, consent) live on `www`.

### D10. Consent runs on `www`, the decision is recorded on the backend

The consent screen is a Next page under `/oauth/consent` on `www`. It presents
the backend-validated client, redirect host and requested scopes, then submits
through Better Auth's supported consent/continuation flow. The backend owns
session validation, continuation integrity, CSRF and account-security checks.
The milestone 0 proof determines the exact supported UI integration; no
`oidc-provider` interaction cookie or handler survives this design. Credentialed
requests from `www` use an exact trusted-origin allowlist, independently from
the credential-free third-party API CORS policy below.

App registration and Connected apps use first-party backend operations. They
wrap the provider's supported APIs and our application policy. A third-party
OAuth token cannot call them; `DELETE /v1/connection` is the intentionally
narrow exception for an app to disconnect its own current connection.

---

## Assessment of the Sequence plan

The plan in `partner-api.md` / `partner-workouts-internal.md` (#5530, September
2026) was already written as "a general partner API" and most of its security
model holds. Measured against the platform goals:

### Already aligned

- Boardsesh as authorization server; PKCE S256 for every client, confidential
  ones included; exact redirect URI match; system browser only, no WebView.
- Opaque tokens checked against current authority state on every call;
  single-use codes, refresh rotation and replay protection tested under
  concurrent requests. Token revocation is distinguished from Disconnect (D4).
- A connection as the unit the climber sees and revokes; no cache on
  partner auth; the hard separation from `validateToken`.
- Consent-page hardening: validate everything before redirecting anywhere,
  CSRF bound to the session, parameters re-validated on POST,
  `frame-ancestors 'none'`.
- Prerequisites it found: AASA must exclude `/oauth`, and `/auth/login`'s
  `callbackUrl` must be constrained first. AASA now excludes it
  (`WEB_ONLY_PATH_PREFIXES`); the `callbackUrl` work is tracked in milestone 0
  below.
- Postgres, not Redis, for single-use codes, because Redis fails open when
  unconfigured.
- Per-client Redis rate limits instead of the per-IP limiter, which behind
  the proxy is one shared bucket.
- Path versioning with additive changes on `v1` and six months of overlap.
- `Idempotency-Key` plus a unique `externalRef` for writes.
- pg-boss with the job enqueued in the same transaction as the state change.
  That queue now exists (`packages/backend/src/services/job-queue.ts`), which
  removes the plan's biggest dependency.
- Ticks in results filtered to the connected climber, never the whole party.

### Generalize

- Registration by email → self-service web page (D7).
- "Partner" → "app" everywhere, `/v1/partner/*` → `/v1/*`, `ws` →
  `api.boardsesh.com` (D9). The edge's default-deny exemption has followed the
  path to `/v1/` (`AUTOMATION_DEFAULT_DENY_EXEMPT_PATH_PREFIXES` in
  `packages/web/app/lib/crawler-policy.ts`).
- Webhook URL, secret and event list move off the client row onto per-app
  webhook settings the developer edits in the console (milestone 4).
- Client ids are provider-generated opaque strings. Examples do not reserve
  a prefix or length and no client gets a hand-assigned brand-specific id.
- Text addressed to Sequence inside the public contract (the Strava opt-out
  paragraph, "the same way Sequence's own tokens behave", the logbook mapping
  table) moves to [integration-consumers.md](./integration-consumers.md).
- Connected apps only on mobile → also on the web account settings, so a
  climber can disconnect from any browser.

### Missing

- A read path for the logbook. The plan only returned ticks as workout
  results, so an app could see climbs done inside its own workouts and
  nothing else. DivePeaks needs the whole logbook; Sequence's logbook does too.
- Incremental sync, tombstones and cursor expiry.
- Abuse controls that work without a human: per-developer app caps, a daily
  cap on new connections per app, reserved names, an "unreviewed app" label
  on consent, a suspend switch.
- Rules for public clients: which redirect URIs a self-registered app may
  use (RFC 8252 loopback and private-use schemes).
- A per-app ceiling across all climbers; the plan only limited per climber.
- RFC 8414 metadata, a machine-readable contract, a quickstart, llms.txt.
- Developer terms and the privacy-policy line saying data a climber sends to
  an app is then governed by that app.
- Things the plan assumed exist and do not: refresh-token reuse detection
  (`native-auth.ts` has neither a `replaced_by` column nor reuse handling, so
  it was never a copy; Better Auth integration must prove it, see D2), and
  revocation on password reset (the reset route revokes nothing today, not
  even mobile refresh tokens).
- A feed that cannot miss rows. Reusing the phone's 30-second window would
  have inherited its long-transaction hole (D6).

### Overengineered for a first release

- Webhooks before any read path: four events with the full results in the
  body, built before a single app has read anything. The delivery mechanics
  (ledger, retry table, 410 handling, two secrets during rotation) are sound
  and carry into milestone 4 unchanged; what changes is the timing, the event
  count and the fat bodies.
- Derived and guessed fields in the results contract: `restBeforeSeconds`
  (arithmetic on `climbedAt`), `blocks[].done` ("a best guess" for freeform
  blocks), `totals` (a sum the app can do), `round` ("always `null`"). Each is
  a field we would have to keep forever. Results now carry ticks in the same
  shape as the logbook, plus `blockIndex`; apps derive the rest.
- `workout.opened`, `workout.cancelled`, `workout.expired` events. Status is
  readable with `GET`.

### Defer

- Workouts (`workouts:*`, the `/w/` launch, the mobile card) to milestone 3,
  after the logbook proves the OAuth core. Sequence gets value in milestone 1:
  board ticks flowing into its logbook.
- Webhooks to milestone 4.
- App-to-app consent, verified-domain badges, dynamic client registration,
  an MCP server, SDKs.

### Risks the plan did not cover

- **The results payload leaked session invite links.** It carried
  `session.id` and `session.url`. A session id is its invite link (see the
  comment on `userTicks` in `packages/backend/src/graphql/resolvers/ticks/queries.ts`,
  and `docs/websocket-implementation.md`: an Unlisted link joins). Handing it to
  a third party hands them a way into the climber's session. Removed; no public
  type carries a session id.
- **Consent from a stale session.** The migration must validate legacy
  cookies and current sessions against the same account security state.
  A rolling JWT `iat` is not proof of a recent login. A reset or security
  revocation must prevent an old web, native or watch credential from
  authorizing a new app. If a legacy session cannot establish the required
  assurance, ask for real reauthentication; ordinary migration is not a
  reason to sign everyone out. The migration doc owns this shared policy.
- **Self-registered webhook URLs are an SSRF vector** (milestone 4): see
  [Webhooks](#webhooks-later).
- **A library at the centre of auth.** Pin Better Auth and its provider,
  gate upgrades on migration and protocol suites, and keep UI/application
  policy separate from library integration. A provider upgrade must not
  silently weaken revocation or change the old native/watch contract.
- **Secret encryption has no key versioning.** `@boardsesh/crypto` derives
  one AES key from `AURORA_CREDENTIALS_SECRET` with a fixed salt. Better Auth
  secret storage must follow the pinned provider's requirements for opaque
  tokens, and any application-encrypted material needs versioned keys.
  Webhook signing-secret rotation is a separate milestone 4 concern. OAuth
  client-secret rotation is immediate; no previous-secret overlap is promised.

---

## Authorization server

### Endpoints

The issuer is `https://api.boardsesh.com/api/auth`. Use the provider's native
paths; there are no `/oauth/token` aliases. Discovery is authoritative and is
validated against the configured handler before publication. For this pathful
issuer, RFC 8414 derives the canonical metadata URL by inserting the well-known
path before `/api/auth`: route `/.well-known/oauth-authorization-server/api/auth`
to Better Auth's handler as well as mounting `/api/auth/*`. A mount limited to
`/api/auth/*` is insufficient. Test discovery using an unmodified OAuth client.

| Endpoint | Served by | Notes |
| --- | --- | --- |
| `GET /api/auth/oauth2/authorize` on `api` | Better Auth OAuth provider | Validates client, redirect and PKCE before continuing to login/consent; untrusted redirects are never followed |
| `/oauth/consent` on `www` | Next page | Renders the supported provider consent flow, requiring a current first-party session |
| `POST /api/auth/oauth2/consent` on `api` | Better Auth OAuth provider | Supported session-bound consent API, with the provider's continuation and CSRF checks |
| `POST /api/auth/oauth2/consent-details` on `api` | Boardsesh, inside the authority | What the consent screen shows for an open consent link. See [Consent and the www session](#consent-and-the-www-session) |
| `POST /api/auth/oauth2/token` on `api` | Better Auth OAuth provider | Authorization-code and refresh grants only; each client uses its registered authentication method |
| `POST /api/auth/oauth2/revoke` on `api` | Better Auth OAuth provider | RFC 7009 token revocation, distinct from disconnect |
| `GET /.well-known/oauth-authorization-server/api/auth` on `api` | Better Auth handler, explicitly forwarded outside its base mount | Canonical RFC 8414 metadata for the pathful issuer; the provider's `/api/auth/.well-known/oauth-authorization-server` alias may also be served, with identical metadata |
| `DELETE /v1/connection` on `api` | Boardsesh public API | Any valid user-delegated API access token can disconnect only its own app/climber connection; no extra scope |

The authorization response carries the issuer in `iss` (RFC 9207). The app
does not claim `api.boardsesh.com`; `/oauth` on `www` is excluded from iOS
association before consent launches. First-party auth paths and their old
native/watch aliases are owned by the migration doc, not this API contract.

### Routes and the mode switch

`PARTNER_OAUTH_MODE` is read once, from the environment. No request can
choose it. Five production modules outside `auth/partner/` may reach into that
folder: `handlers/partner-auth.ts` (these routes), `handlers/public-api/router.ts`
(the `/v1` API), `graphql/resolvers/oauth-clients/partner-registration.ts` (the
developer console's operations, see [Self-service registration](#self-service-registration)),
`services/partner-oauth-sweep.ts` (the [retention sweep](#retention-sweep)) and
`graphql/resolvers/connected-apps/connected-apps.ts` ([Connected apps](#connected-apps)).
With the mode `off` the first three answer nothing new, and none loads Better Auth.
The sweep and Connected apps run in every mode, so they load only plain-SQL partner
modules. `scripts/__tests__/better-auth-boundary.test.ts` holds that list and what each
may import. Backend and web parse it with the same function
(`@boardsesh/auth-protocol/partner-oauth-mode`): an absent, empty or misspelled
value is `off`.

**Set it on the web service too, every time it changes.** The web reads its own
environment to decide whether to guard OAuth account links and to mark new
sign-ins `link_guarded` (see [Consent and the www session](#consent-and-the-www-session)).
Turn the web on first, then the backend; turn the backend off first. A mismatch
fails closed rather than open: while the web reads `off`, its sign-in and consent
pages show "isn't available" whatever the backend serves, and a sign-in made
meanwhile carries no `link_guarded`, so it cannot approve an app after the web is
switched on either. `infra/railway/config.ts` refuses any web value but
`off`, `hold`, `allowlist` or `open`, since the web would read a typo as `off`. It
cannot compare the web's value with the backend's: the plan reads one service at
a time, and the backend is inventory-only there.

| Mode | What the backend does |
| --- | --- |
| `off` (default, and any unrecognised value) | Every partner route is `404`, every developer console operation answers `NOT_FOUND`, and Better Auth is never loaded |
| `hold` | Every partner route answers `503` with `Retry-After: 60`, and every console operation `SERVICE_UNAVAILABLE`, without loading Better Auth |
| `allowlist`, `open` | The routes below are served. The two modes are meant to differ only in who can register an app; for now both register only developers in `PARTNER_OAUTH_DEVELOPER_ALLOWLIST` (see below) |

Only these exact method and path pairs are served, and only on `api.boardsesh.com`:
`GET /api/auth/oauth2/authorize`, `POST /api/auth/oauth2/consent`,
`POST /api/auth/oauth2/consent-details`, `POST /api/auth/oauth2/token`,
`POST /api/auth/oauth2/revoke`, RFC 8414 metadata at both paths above, and
`GET /api/auth/error`, the page the provider sends a browser to when it must not
send it to the app. Token, revoke and both consent routes also answer a CORS
preflight, which never reaches Better Auth. The path is matched byte for byte
against what the client sent, so a trailing slash, a doubled slash, different case,
a percent-encoded byte or `HEAD` is a `404`. `disabledPaths` also refuses the other
stock routes inside Better Auth, except the two with path parameters.

The `/v1` API adds `GET /v1/me`, `DELETE /v1/connection`, `GET /v1/logbook/changes`
and `GET /v1/logbook/ticks/{id}`, matched the same way (the tick id is one path
segment), plus their CORS preflights, and `GET /v1/openapi.json`. Under `hold`
every one of them answers `503` with `Retry-After: 60` in the API error shape.

`GET /v1/openapi.json` is the committed `generated/openapi.json` byte for byte. It
needs no token, reads no database and answers any origin
(`Access-Control-Allow-Origin: *`, nothing credentialed), cached for 5 minutes.

Availability is protected before any transaction opens:

- A body is buffered first, up to 64 KB and for at most 5 seconds. Over the size
  is `413`, over the time is `408`, with the connection closed either way.
- At most 3 requests run at once, one for an authorize and two for `/v1`, with token
  work first, then `/v1`, then authorize. 16 more wait per kind, for at most 1
  second. Anything else gets `503` and `Retry-After` at once. `/v1` never holds the
  third permit, so an app's polling always leaves one for its refreshes. One address
  may hold at most 8 of the shared `/v1` lane's 18 places (2 running, 16 waiting);
  past that its requests wait in an overflow lane with one of the two permits and 13
  places, at most 8 of them its own (below).
- Discovery and a signed-out authorize take no transaction.
- Rate limits use the table under Operations and run first. Per-connection refresh
  and the app limits never reach a lock. The first replay of a spent code closes
  that code's tokens under the lock. Every later replay answers `invalid_grant`
  without taking the climber's row lock.
- The whole-app count is checked before serving and charged only after a token
  response succeeds, because a public `client_id` is no secret: charging it by name
  would let anyone spend an app's budget. Revoke is not charged at all, since it
  answers `200` for any token. A burst can pass the check together, so one instance
  can overshoot by up to 19 requests (3 running, 16 queued).
- The per-connection refresh count applies only to a current, unexpired refresh
  token. It is checked before the transaction and charged after the response only
  when the token's own app authenticated and the provider got past that: a success,
  `invalid_grant`, `invalid_scope` or `invalid_target`. Anything refused earlier,
  including the token sent under another app's `client_id`, never takes a lock, and
  the per-address limit covers it, so a confidential app's token without its secret
  cannot spend the count. A public app authenticates by `client_id` alone, so every
  authenticated attempt it makes is charged. An expired token that was never used is
  refused before the lock; an expired used one still trips reuse, once. The charge
  lands before the request's admission permit is released, so one instance can
  overshoot by at most 2 (3 permits).
- A `client_id` outside `[A-Za-z0-9_-]`, at most 128 characters, cannot name a real
  app and bills a shared invalid bucket.
- The client address for a limit is `CF-Connecting-IP` only from a verified
  Cloudflare edge, otherwise the last `X-Forwarded-For` hop. An IPv6 client counts
  as its /64, and an IPv4-mapped address as that IPv4 address. The `/v1` lane
  decision alone groups IPv6 wider, at /48 (below).
- Cloudflare Workers on other zones all reach us from one address,
  `2a06:98c0:3600::103`, so keyed by address every Worker-hosted app would share
  one bucket worldwide. For that exact address, reported by a verified Cloudflare
  edge, the OAuth routes key every per-address limit (60 authorizes, 60 consents,
  1,200 body reads, 60 token and 600 refresh requests per app, and 8 bodies in
  flight) by the `CF-Worker` zone instead (`cf-worker:<zone>`), one hostname of two or more
  labels, lower-cased. The Worker writes that header, so all zones together also
  count against a ceiling of 10 times each limit on the Worker address (operation
  names ending `-worker-egress`; 600 authorizes, 12,000 body reads, 32 bodies in
  flight). A zone is charged before the ceiling, so a zone over its own limit
  spends none of it. A missing or malformed `CF-Worker` leaves the request on the
  Worker address's own bucket at the normal limit, and the header means nothing
  from any other address or from a request that did not come through Cloudflare
  (`getPartnerLimitIdentity` in `utils/client-ip.ts`). Someone who can make
  Cloudflare report many zones can still fill the ceiling: that takes 12,000 body
  reads a minute, where one address took 1,200 before. `/v1` uses the same
  identity for its lanes and its failed-lookup count (below).
- A Redis command that takes over 100 ms falls back to the per-instance memory limit.

For `/v1`, in this order:

1. No `Authorization: Bearer` header is a `401` at once, with no lookup.
2. A `/v1` admission permit, then the token lookup on the primary. The two `/v1`
   permits, 16 waiting and the 1 s deadline are what bound the database work junk
   tokens can cause. The lane is chosen by how many requests an address has in
   flight, never by how many of them failed. An address may hold 8 places in the
   shared lane, running and waiting together. Its 9th and later requests wait in
   the overflow lane instead: at most one of the two permits, 13 places (1
   running, 12 waiting), at most 8 per address, and served only when the shared
   lane has nobody waiting. That is routing, not refusal. A burst of 16 from one
   address fits (8 shared, then 8 in overflow), so a partner polling many
   climbers at once is served, only slower. One junk sender holds at most 8 of
   the shared lane's 18 places and 8 of overflow's 13, so it can never fill either
   lane. The counts are per instance and live in the gate
   (`auth/partner/admission.ts`), so they cost no Redis call.

   A few senders at their share can still fill a lane between them: three at 8
   are 24 for the shared lane's 18. So when a lane's queue is full, the newest
   waiter of the address holding the most places gives its place up to the new
   request, but only if that address holds more places than the newcomer would
   after taking one, so after the swap it still holds at least as many and equals
   never trade places back and forth. A shared waiter that
   gives its place up moves to overflow if its address has room there, and is
   refused (`503`) otherwise; an overflow waiter that gives its place up is
   refused. Three flooding addresses therefore settle at 6 shared places each, and
   an address with nothing in flight is always queued while any address holds 2
   or more places with one of them waiting. Before this rule, three addresses each
   holding 8 junk lookups made a fourth address's valid token answer `503`.

   This replaced routing on failures (30 failed lookups a minute sent an address
   to a one-permit lane with 4 places), which sidelined honest partners. One with
   about 2,000 climbers produces about 33 expired-token `401`s a minute, and behind
   shared egress everyone's `401`s count together. Measured: after 31 legitimate
   `401`s, 11 of a 16-request burst answered `503` (69%).

   For the lane alone, an IPv6 address counts as its /48, not its /64. One site is
   routinely given a /48, so a sender rotating through fresh /64s inside it (one per
   30 junk lookups was enough under the old rule to refuse 78% of valid tokens)
   still holds only 8 shared places. The cost falls on people behind carrier NAT:
   public clients call `/v1` from climbers' phones, and every phone behind one
   carrier-NAT IPv4 address, or one mobile carrier /48, shares one address's 8
   places. Their 9th concurrent request and later ones wait in the overflow lane,
   one at a time, and answer `503` with `Retry-After: 2` only when that lane's 8
   places are also full. Partner mode is off, so there is no `/v1` traffic to size
   this against yet; if carrier groups overflow in practice, raise the share, not
   the grouping. What this
   does not stop is a sender holding many /48s (one /32 is 65,536 of them), each
   keeping one request waiting: 18 such addresses fill the shared lane with no
   address larger than a newcomer. That is the same "many addresses" class as
   the token endpoint's per-address limits, for a Cloudflare rule.

   Cloudflare Workers count by zone, the same `getPartnerLimitIdentity` key as
   the OAuth routes: each zone is its own address here, with its own 8 shared and
   8 overflow places. The Worker writes the zone header, so every zone behind the
   Worker address together also holds at most 12 of the shared lane's places and
   8 of overflow's, and the give-up rule weighs a Worker request by that shared
   count. Forged zones can fill the Worker share, but never take the 6 shared and
   5 overflow places left for everyone else, and they are the first to give a
   place up to anyone else. Inside a full Worker share the same give-up rule runs
   among the zones: the zone holding the most places gives its newest waiting
   place to a zone that would hold fewer. So two junk zones holding all 12 shared
   and 8 overflow Worker places cannot shut out a third zone with nothing in
   flight; before this, its valid token answered `503` at once.
3. A lookup that finds no usable token is charged to the address: 600 a minute, the
   sizing of the token endpoint's per-address refresh bound. Past that the address
   gets `429` instead of `401`. Only a failed lookup is ever refused for this count;
   a valid token never sees it, in a status or a `RateLimit-*` header, and it no
   longer changes which lane a request waits in. Many partners share one address
   (carrier NAT, cloud NAT gateways and shared hosting), so refusing on the count
   before a lookup would let one sender of junk lock all of them out. A Worker is
   counted by zone, so one zone's junk never turns another zone's expired-token
   `401`s into `429`s. Unlike the OAuth routes, nothing counts every zone
   together: this count is charged after the lookup, so a ceiling on it would
   save no database work, and its only effect would be to let one junk Worker
   turn every Worker partner's `401`s into `429`s. A Worker that forges new zone
   names dodges its own 600; the lanes above still hold every Worker zone
   together to its share of the database.

Measured on a laptop, two runs, with 48 concurrent junk loops from one address for
2 s and a valid token sent every 20 ms from another address and from the flooding
address itself:

| Valid token from | Failure-count routing (before) | Concurrency routing |
| --- | --- | --- |
| Another address | `503` on 2 of 57 (19 of 27 with no separate lane) | `503` on 0 of 93 and 0 of 65 |
| The flooding address | 14 of 61 served | 22 of 93 and 12 of 65 served |
| A 16-request burst after 31 `401`s | 5 of 16 served | 16 of 16, in 10 of 10 bursts |

The flooding address's own valid token waits in the overflow lane behind its own
junk, as before. It is never refused with `429`.
4. Only once a token has passed are the connection (120 a minute,
   `api-connection`) and the app (6,000 a minute, `api-app`) charged. A caller
   without a valid token for them cannot spend either.

### Consent and the www session

Code: `auth/partner/consent.ts`, `first-party-session.ts`, `connection-caps.ts`.
The consent pages on `www` call the two consent routes with the climber's cookie;
everything that decides lives here.

**Who is signed in.** Only the www NextAuth session cookie says. The session
bridge decrypts it with the strict legacy verifier (`auth/legacy-web-credentials.ts`:
pinned algorithms, required claims, chunked and duplicate cookies fail closed) on
every authorize and consent request. No Better Auth cookie is ever set, and the
adapter never finds a session by token, so a correctly signed Better Auth cookie
still signs no one in. A signed-out authorize is one with no NextAuth cookie,
which is why it can run outside a transaction.

**When a sign-in counts** (decision 19). The cookie must carry an `auth_time`
the web wrote at sign-in (#6981 F5), under 30 days old, written beside
`link_guarded: true` (so the web was guarding links when it was minted), and more
than 60 seconds after the climber's last password write
(`user_credentials.updated_at`, from the database clock). The 60 seconds cover a
web clock running ahead of the database. Web and backend apply this as one
function, `isSignInGoodForPartnerConsent` in `@boardsesh/auth-protocol/auth-time`.
A missing, fractional, non-positive or future (beyond 60 s of skew) `auth_time`
is unknown, and unknown is too old. A cookie that fails any of this sends authorize
to `/oauth/sign-in`, and consent answers `401 login_required`. A deleted account's
cookie, which stays decryptable for 30 days, reads as signed out. The sign-in
check runs after the request takes `users` FOR SHARE, so a consent queued behind
a password reset sees the reset. `user_credentials` is read, never locked: the
legacy reset locks that row before `users`.

The bridge keeps one `oauth_session` row per NextAuth login (user, `authSessionId`,
`auth_time`), created under `users` FOR SHARE, with `created_at` set to the sign-in
time. The provider takes a code's auth time and `max_age` from that column.

The web side closes the one way an old cookie could get a new `auth_time`: an
OAuth callback that links an unlinked provider account into a live session, after
which NextAuth's jwt callback writes `auth_time` as if the climber had just signed
in. `oauth-link-guard.server.ts` gives legacy-mode callbacks a request-local
adapter whose `linkAccount` refuses that link (NextAuth's `error=Callback`) unless
the session's own sign-in passes the same rule consent applies, password write
included, so a cookie from before a reset cannot buy a new sign-in time either.
Requiring `link_guarded` there too means a sign-in bought while the guard was off
cannot be laundered through a second link once it is on. Signing in with a
provider account already linked to the climber, creating an account, and linking
by verified provider email with no session all work as before.

The guard, and the `link_guarded` mark, are on only while the web's
`PARTNER_OAUTH_MODE` is not `off`. This defers the cost; it does not avoid it.
NextAuth re-issues the session cookie on every use, but writes `auth_time` and
`link_guarded` only on a sign-in, so a climber who stays active and never signs
out keeps a cookie without them indefinitely. On the day the mode leaves `off`,
every climber is in that position: they are asked to sign in again before they
can approve an app, and before they can link a Google, Apple or Facebook account
into their session. Signing in once clears both.

**`prompt=login`** is dropped. Stock Better Auth answers it by asking for a
Better Auth sign-in, which never happens here, so it would loop; the 30-day rule
already asks for a real sign-in when one is due.

**Consent links.** Every time the provider sends a signed-in climber to the
consent screen, the link's signature is stored as an `oauth_consent_interactions`
row: climber, bridged login, app, connection generation (0 when there is no
connection yet) and the link's 600-second expiry. The consent post must present a
row that is open, unexpired, for this climber, this login and this app, at the
generation the connection has now; it is locked and spent in the same
transaction, whether the climber allows or declines. So a link answers once,
cannot be answered by someone else or after an account switch, and cannot
reconnect an app the climber disconnected meanwhile. A first-time consent has no
connection row to lock, so the fence checks the generation again when it binds
the code, and rolls the whole request back if a Disconnect moved it.

**Cross-site requests.** Both consent routes take only `Origin:
https://www.boardsesh.com`, exactly, whatever the cookies say. SameSite=Lax lets
every `*.boardsesh.com` subdomain send the session cookie, so a cookie is no proof
of where a request came from.

**Caps** (decision 22). An app holds at most `max_active_connections` (25)
live, unrevoked connections and gains at most `max_new_connections_per_day` (20)
in any 24 hours; a reconnect counts as new. A connection goes live, and
`connected_at` is set, when the app first redeems a code for it, not when the
climber approves. An approval nobody redeems counts for nothing: its code dies in
60 seconds, a first-time connection stays a row with no `connected_at`, and an
approved reconnect stays not revoked but not live. So throwaway accounts that
approve and walk away fill no place.

The caps are enforced at the exchange, under the connection lock the redemption
already holds and then the app's `oauth_app_policy` row FOR NO KEY UPDATE, so two
codes redeemed at once cannot both take the last place. A refusal there rolls the
token request back and answers `400 invalid_grant` with the reason; the code is
not spent. The same check also runs when the climber approves, only so a full app
turns them away at once: that refusal rolls the request back (consent, code and
the spent link alike) and sends the browser to the app with
`error=temporarily_unavailable` (`access_denied` for an app with no policy row,
which can never gain connections).

Public clients are the limit of this. A confidential app's code can only be
redeemed with its secret, so only the app itself can make a connection live. A
public app authenticates by `client_id` and PKCE, and anyone can run its flow end
to end, for example to their own loopback redirect, so someone with N accounts
can take N of its places and up to 20 a day. The caps bound the blast radius
during allowlisted stages; they are not abuse-proof for public apps. The owner
raises the app's caps in its policy row, and `revoke-user` (F12) ends the
offending accounts' connections.

**What the screen shows.** `POST /api/auth/oauth2/consent-details` with
`{ "oauth_query": "<the page's query>" }` answers, for an open link and the same
checks as the post, without spending it:

```json
{
  "client": {
    "clientId": "bsk_…",
    "name": "Sequence",
    "homepageUrl": "https://…",
    "privacyPolicyUrl": "https://…",
    "termsUrl": null,
    "publisherName": "Sequence Climbing Ltd",
    "redirectHost": "com.example.app"
  },
  "scopes": [{ "scope": "profile:read", "includesOnlyMeTicks": false }],
  "reconnect": false,
  "reviewed": false,
  "expiresAt": "2026-11-10T12:10:00.000Z"
}
```

Facts only; the page words them in the climber's language. `includesOnlyMeTicks`
is true for `logbook:read` (decision 21), so the screen can say that approving
shares ticks the climber keeps to "only me". `logbook:read` is in the scope list
(`PARTNER_SCOPES`) and in discovery since its routes shipped (L4). Nothing about the
account that registered the app is sent: its display or account name is the
developer's own, not something a climber should see. `publisherName` is the
publisher the developer typed at registration (`oauth_app_policy.publisher_name`),
and `null` for an app registered before that column existed; the screen then shows
no "Made by" line, with nothing in its place.

**Refusals on both consent routes.** Each is `{ "error": "<code>",
"error_description": "<English text>" }` with `cache-control: no-store`. Switch on
`error` and the status, never on the text. The codes are `PARTNER_CONSENT_ERRORS`
in `@boardsesh/auth-protocol/partner-oauth`, beside `PARTNER_OAUTH_ISSUER`.

| Status | `error` | Means | Page does |
| --- | --- | --- | --- |
| `401` | `login_required` | No www session, or one whose sign-in cannot approve an app | Send the climber to sign in, then back |
| `403` | `invalid_request` | Origin is not exactly `https://www.boardsesh.com` | Nothing a climber can fix |
| `403` | `app_suspended` | The app is suspended or deleted. Checked first; the link is not spent | Say the app cannot be connected now |
| `400` | `link_spent` | The link was already answered, expired, belongs to another climber or sign-in, or the climber disconnected the app since | Ask the climber to start again from the app |

An approval the caps refuse is not an error response: it answers `200` with
`{ "redirect": true, "url": "<app redirect with error=temporarily_unavailable>" }`,
like a denial.

**The www pages** (`packages/web/app/oauth/`, logic in
`packages/web/app/lib/partner-oauth/`). Both show an "isn't available" card while
the web's own `PARTNER_OAUTH_MODE` is `off`, and an error card for a query that
is not a signed one (no single `sig`, no `ba_param` list, no `client_id` or `exp`).
They read the session cookie only to choose what to say; every decision stays with
the backend, so the pages need no database or backend call to render.

- `/oauth/sign-in` shows the password form and the Google, Apple and Facebook
  buttons, with copy for three cases: signed out; signed in but too old to approve
  an app (the switch-on day case, worded as "sign in again, your account is fine");
  and signed in within the last 3 minutes yet still refused, which is the 60 s after
  a password change. A finished sign-in comes back to the page with
  `boardsesh_signed_in=1`, and only then does the page send the browser to
  authorize, rebuilt from the signed parameters without the signing fields. Without
  that marker it never forwards on its own, so a session the backend keeps refusing
  shows the form instead of bouncing between hosts.
- A failed social sign-in that started there comes back there with `?error=`,
  because the iPhone app claims `/auth/login`. `sign-in-failure-return.ts` decides
  once, on the response that starts the provider round trip (`POST
  /api/auth/signin/<provider>`, redirect or JSON `url`) or ends it
  (`/api/auth/callback/<provider>`), by that flow's own callback URL: a callback-url
  cookie the same response sets; else, at a start, the `callbackUrl` the request
  posted (a start refused before NextAuth runs sets no cookie); else, at a
  callback, the `<callback-url>.<scope>` cookie a `backend-staging` flow retires,
  or, only when no scoped cookie exists, the base cookie the legacy start wrote. The later hops (`/api/auth/error`,
  `/api/auth/signin`) are never rewritten, because by then the base cookie may be a
  stale one, such as the partner page kept from "Not you? Sign out". Only the
  partner page's path is ever written, never an origin.
- `/oauth/consent` calls both consent routes from the browser, with
  `credentials: 'include'`, so the browser supplies the exact `Origin` and each
  climber keeps their own rate-limit bucket. It posts only the signed parameters
  (the `ba_param` list), as Better Auth's own client does.
- Refusals map to plain states by `error` and status, as in the table above:
  `login_required` is "sign in again" (back through `/oauth/sign-in` with the same
  request), `link_spent` and Better Auth's own `invalid_signature` (a changed or
  out-of-date link) are "expired", `app_suspended` is "this app can't connect", the
  cap's `temporarily_unavailable` on the app's redirect is explained before the
  climber goes back, and `429` or `5xx` offers a retry. The cross-site
  `invalid_request` can't happen from the page itself and reads as a plain failure.
- Both pages are chrome-less, `noindex`, and send `X-Frame-Options: DENY`,
  `frame-ancestors 'none'`, `Referrer-Policy: no-referrer` and `no-store`. PostHog
  and the ad pixels never load there (`isPartnerOAuthAnalyticsUrl`), and Sentry
  drops the query of any `/oauth/sign-in` or `/oauth/consent` URL and any
  `oauth_query` field (`@boardsesh/text-redaction`).

### Browser access

CORS on the token/revoke endpoints and `/v1/*` is credential-free and separate
from trusted first-party browser origins. Only the HTTPS origins of registered,
live apps are eligible. The provider integration must prove the complete
policy; if its built-in CORS differs, resolve that through supported integration
before launch rather than assuming a configuration switch exists.

- An unauthenticated `OPTIONS` may allow any eligible registered origin.
  Allow `GET`, `POST`, `DELETE`, and `Authorization`, `Content-Type`,
  `Idempotency-Key`; include `Vary: Origin`, never credentials.
- For successful data/token responses, the origin must belong to the
  authenticated app itself. Another app's registered origin is insufficient.
- Authentication failures must also be readable by eligible origins. An
  expired/deleted opaque token cannot identify an app, so a generic `401`
  with no account/token details may use the global registered-origin set.
  Apply the same error policy before auth for rate limits and failures. Never
  expose a success response or personal data through that error-only rule.
- Expose `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining`,
  `RateLimit-Reset`, `WWW-Authenticate` and `Sunset` through
  `Access-Control-Expose-Headers`. Test a real browser after the access-token
  row has physically expired and been removed: it must see `401`, refresh,
  and retry rather than receive a CORS network error.
- The registered-origin cache is invalidated on app edits/deletion; generic
  error responses cannot become a token-existence oracle. Credentialed
  login/consent requests use only the exact first-party origin allowlist.

### Storage and ownership

Better Auth owns its identity/session schema and the provider's generated
client, consent, access-token and refresh-token schema. Generate the Drizzle
mapping for the pinned version, review its indexes and relations, and commit
migrations through the repo's migration workflow. Do not recreate an
`oidc-provider` generic model store or assume its `Grant`, `Session`,
`findClient` or `revokeByGrantId` APIs exist.

Application records add only Boardsesh policy:

| Record | Purpose |
| --- | --- |
| App policy keyed by provider client ID | Developer ownership, display/terms fields, registration caps, rate tier and suspension state; the provider remains authoritative for client authentication, redirects and token issuance |
| `oauth_connections` | One current connection per (client, user), a durable connection ID/generation, consented scopes, revocation state/reason and last-used metadata; workouts reference this lifecycle |
| `oauth_subjects` | Stable random per-app public user ID, preserved across reconnects; not `users.id` |
| Versioned key material | Only what the selected provider configuration or application encryption needs; rotation and recovery tested before rollout |

All user references preserve Boardsesh's identity mapping. The connection
record is not a second password/session authority. Its relationship to every
provider credential must be demonstrated in the spike: reconnect creates a
new generation, and old credentials never become valid merely because a
client/user pair has an active connection again. Use supported hooks and
transaction boundaries, not undocumented provider-model assumptions.

Whole-connection revocation first makes the application connection unusable
atomically with unfinished-workout state changes and its lifecycle event.
Provider consent/token cleanup must also prevent old refresh credentials from
issuing new usable tokens, including after reconnect. A fail-closed generation
check may protect reads during cleanup, but it is not a substitute for proving
token issuance and cleanup races. Account deletion and password-reset paths
invoke the same authority-owned operation. Cleanup jobs use pg-boss.

### Bearer auth for `/v1/*`

The bearer check verifies activity, resource audience, client, user, scopes and
the current connection generation, then checks suspension and revocation without
a positive-result cache. The sole partner API resource identifier is
`https://api.boardsesh.com/v1` (no trailing slash); it is distinct from the
issuer. Register that resource and link every self-service client to it through
supported provider APIs. Clients send it as `resource` at authorization, code
exchange and refresh. A missing or different resource at the authorization and
the code exchange must never produce a usable API token: the pinned provider
issues a token with no audience when neither step names it, so `/v1/*` answers it
`401 invalid_token`, and naming it at either step is enough. A refresh inherits
the grant's audience. One that leaves `resource` out gets tokens for the same
audience (RFC 8707 section 2.2), which is standard and never wider; one that names
any other resource is refused with `invalid_target`. Registration links alone are
not assumed to supply a request default.

How it is built (`auth/partner/bearer.ts`): the presented token is hashed with the
provider's own `hashToken`, then one read on the primary, with no lock, joins the
access token to its `oauth_grants` row, the connection and the client. It refuses
everything the provider's introspection refuses (unknown, expired, revoked, a
disabled client, an ended session) and, on top, a token without this audience, a
sender-constrained (DPoP) token, a revoked connection, a grant from an older
generation, and a token whose grant row is gone. The route tests run each refusal
against stock introspection as well, so the provider's verdict is the floor this
check is held to, and the checks only Boardsesh adds are named. It works the same
for public and confidential clients, because it never authenticates as one. It
returns `{ clientId, userId, connectionId, connectionGeneration, scopes }`; `/v1/me`
mints or reads the `usr_` subject itself. A write (`DELETE /v1/connection`) checks
the token again under the connection lock. Each route checks its required scope.
Invalid tokens yield `401` and `WWW-Authenticate: Bearer error="invalid_token"`
(a request with no token gets the bare `Bearer` challenge); missing scopes yield
`403`.

### Revocation

| Trigger | Required effect |
| --- | --- |
| Connected apps Disconnect, or `DELETE /v1/connection` | End the whole connection, invalidate all its credential families and remembered consent, revoke unfinished workouts; a reconnect requires fresh consent and a new generation |
| Revoke an opaque access token | That access token stops working; its refresh token and other token families are not disconnected |
| Revoke a refresh token | That refresh token and access tokens associated with it stop working; independent families and the connection's remembered consent are not automatically removed |
| Refresh-token reuse | Reject replay and invalidate the affected token family through proven provider behavior; do not promise whole-account or every-device revocation implicitly |
| Authorization-code reuse | Reject replay; ensure simultaneous redemption cannot create two usable successors; test the pinned provider's exact resulting token-family behavior |
| Password reset, security credential change or explicit account-wide revocation | Invalidate the relevant first-party and legacy credentials plus all partner connections, using the migration's shared security policy |
| Account deletion | Connections and all credentials become unusable immediately; cascade/cleanup covers provider records and application policy |
| App suspended or deleted | No token issuance or API access; the Connected apps UI explains the state |

Disconnect returns `204` once complete. It is idempotent as a state change,
but a retry can return `401` because the token was revoked or expired. Only
`204` confirms disconnect; `401` does not prove a lost earlier request reached
the server. Clients refresh once through their shared refresh lock and retry
DELETE. If refresh returns `invalid_grant`, the local pair is unusable, but
other families may remain; direct the climber to Connected apps to confirm or
complete disconnect. Transport failures, `429` and `5xx` are retryable, not
proof of disconnection. The caller never supplies an arbitrary user or client
ID. Pending protocol/cleanup work must not be hidden behind a success response
if a credential could still regain access.

`DELETE /v1/connection` today: one transaction takes the climber's `users` row
`FOR SHARE`, then the connection `FOR UPDATE`, the order every partner writer
uses, and checks the token again under those locks. It then raises the generation,
sets `revoked_at` and deletes every access and refresh token, remembered consent,
refresh ancestor, pending consent screen, grant and pending code of that
connection. Ancestry goes with the tokens because the family guard refuses a
fenced grant without closing its family, so a leftover ancestor would make every
replay of it take the climber's row lock. A connection that ended between the
token check and the lock answers `204`; a token that stopped being valid in that
gap (revoked, or from before a reconnect) answers `401` and ends nothing, so an old
token can never end a connection the climber has made again. A lock that does not
come within 2 s answers `503` with `Retry-After: 2`.

One row is the exception to that lock order. A consent answer locks its consent
link before the connection, the other way round, so Disconnect deletes consent
links with `FOR UPDATE SKIP LOCKED` instead of waiting, which would deadlock. A link
skipped that way is one being answered at that moment. Its answer is waiting on
the connection lock, and once Disconnect commits it reads the raised generation,
which no longer matches the generation the link was opened against, so it approves
nothing. The link stays until it expires, and it can never match again, because a
generation only rises, a reconnect keeps it, and the link is deleted with the
climber or the app.

### Connected apps

A climber sees and ends their own connections in Settings › Connected apps, in the
app (the "Apps with access" section, last on the `integrations` page) and on the
website (`/settings`), so a connection can be ended from any browser (#6981 F16).
Both show one compact row per app (name and last use). A row opens the app's detail:
the app opens a pushed settings page (`/settings/connected-app?id=…`, registered flat
in the settings stack like Board look's leaves), the website a dialog. The detail
lists what the app can see, when it connected and was last used, and Disconnect,
which asks first. First-party GraphQL operations serve both, from
`graphql/resolvers/connected-apps/connected-apps.ts` over `auth/partner/connected-apps.ts`:

| Operation | What it does |
| --- | --- |
| `myConnectedApps` | Every live connection of the signed-in climber (`connected_at` set, not revoked), most recently connected first: the app's name, the scopes from its remembered consent, `connectedAt`, `lastUsedAt`, and `suspended` (`oauth_client.disabled` or a policy suspension). `publisherName` is in the shape and null until apps carry one. `partnerAppsEnabled` is false while the mode is `off` |
| `disconnectApp(connectionId)` | Ends the connection through `endPartnerConnection`, the same path as `DELETE /v1/connection`, with reason `climber_disconnect`. `true` once ended, also when it already was |
| `partnerAppsEnabled` | The same flag on its own, signed in or not, for screens that only need to know whether to mention connected apps. The app caches it for an hour, so the editor never asks per open |

Both work in **every** mode, `off` and `hold` included: a climber can always end a
connection, including one made before the mode was turned off. Neither loads Better
Auth, and both run on the GraphQL pool, not the partner pool.

Disconnect keeps the partner lock order: the climber's `users` row `FOR SHARE`, then
the connection `FOR UPDATE`, then the provider rows, with consent links deleted
through `SKIP LOCKED` as described above. The id is matched to the signed-in climber
before any lock and again under it, so another climber's id answers `NOT_FOUND`
exactly like an unknown one and ends nothing. A connection approved for a reconnect
but not redeemed yet is not listed, but Disconnect ends it too. A lock that does not
come within 2 s answers `SERVICE_UNAVAILABLE` with `retryAfterSeconds: 2`.
Disconnect is limited to 30 a minute per climber.

**Last used.** `oauth_connections.last_used_at` is written after a `/v1` token
passes the bearer check and the rate limits, at most once an hour per connection.
The bearer read already carries the stored value, so a fresh one costs nothing. A
stale one runs one `UPDATE` that names its row through `FOR NO KEY UPDATE SKIP
LOCKED`, re-checks the hour, the generation and `revoked_at` in SQL, and never
touches `users`: it never waits for a row, racing requests write once, and a row a
Disconnect, refresh or consent answer holds is simply stamped on a later call. SKIP
LOCKED does not cover the table lock the UPDATE takes, so the stamp sets a 50 ms
`lock_timeout`: while a migration holds `oauth_connections`, a request gives up the
stamp after 50 ms instead of the partner 2 s. A failure to stamp is logged and never
fails the request. An approved reconnect clears `last_used_at` with `connected_at`,
so the new connection starts at "Not used yet". Connected apps shows a stamp under an
hour old as "Used in the last hour".

**What the climber sees.** The words and the show-or-hide rule live in
`@boardsesh/connected-apps`, shared by both platforms. The section is hidden while
signed out, before the first answer, after a failed first load, and when there is
nothing connected while partner apps are off; with partner apps on and nothing
connected it says so. The detail page opened by a cold link whose first load failed
says so and offers a retry. Under `logbook:read` the detail carries the same three
lines as the consent screen, matching what the logbook serializer sends (see [Data
boundaries](#data-boundaries-and-legalmd)): ticks kept to "Only me" (decision 21);
other setters' unlisted climbs and drafts the climber logged, which arrive in full
(#7387, owner decision 2026-11-10); and climbs on someone else's Private or Link only
Spraywall, which arrive without their names.

Setters hear the same from the other side only once partner apps are on
(`partnerAppsEnabled`; with the mode `off` nothing changes): the "Save as draft"
switch says drafts stay unlisted and that apps connected by climbers who log one can
still see it, on a board and on a public Spraywall. A Private or Link only
Spraywall's draft line and its visibility hints say nothing about apps, because apps
get those climbs without their names.

### Retention sweep

The provider deletes a row only when someone presents it, so expired partner
rows would stay forever. The backend's `partner-oauth-sweep` pg-boss job
(`packages/backend/src/services/partner-oauth-sweep.ts`, body in
`auth/partner/retention.ts`) removes them hourly at :34 UTC, whatever
`PARTNER_OAUTH_MODE` says: rows written while the mode was on still have to go
after it is switched off. The queue is `exclusive`, so one run is queued or
running across all replicas. Each row waits an hour past its expiry first, which
covers clock skew between servers and a request that read the row just before it
expired.

| Step | What goes | Why it is safe |
| --- | --- | --- |
| Sessions | An expired `oauth_session` and every access token bound to it | Deleting the session alone would let `ON DELETE SET NULL` unbind those tokens, and an unbound token reads active until it expires. A session goes only when no token is bound to it any more; one a refresh token is bound to (offline grants detach at issuance, so none should be) is left alone |
| Access tokens | Any access token past its expiry | Nothing accepts it and nothing points at it |
| Rotated refresh tokens | A refresh token already rotated, once its `oauth_refresh_ancestors` row records the rotation and no access token issued with it is still live | The family guard reads the ancestor when the refresh row is gone, so replaying the token still closes its family |
| Ended families | A grant whose connection fenced it off (revoked, or a newer generation), or whose code, refresh tokens and access tokens are all spent or expired, together with every token, ancestor and code carrying its code id; the grant goes last | Only a live code or a live refresh token can issue anything, so such a family cannot come back. Ancestry goes only when no unrotated refresh token of the family is left, so a refresh caught mid-rotation keeps it |
| Codes | An authorization code past its expiry, a deleted account's included | The row holds the climber's id, their session id and the authorization query, and no grant reaches a deleted account's code |
| Consent screens | An `oauth_consent_interactions` row past its expiry | A missing screen must be refused like a spent one, which the consent bridge does anyway because Disconnect and the password trigger delete them |

Ancestry of a live family is never deleted, however old: expiry alone is never
permission to forget it. A family that refreshes hourly therefore keeps one
ancestor row per rotation for as long as it lives, about 8,800 a year, while its
refresh and access tables stay at a few rows.

How it stays out of a climber's way:

- It takes no lock on `users` or `oauth_connections`. Each delete names its rows
  through a `FOR UPDATE SKIP LOCKED` read in the same statement, so a row a refresh,
  Disconnect, the password trigger or an account deletion holds is skipped until
  the next run. A delete never reaches a row it has not locked: a refresh token goes
  only when no access token points at it, and a session only when no token is bound
  to it. It never waits for a row, so it can never be part of a deadlock.
- Each batch is one transaction of at most six statements, with `lock_timeout`
  100 ms and `statement_timeout` 250 ms. A live flow that wants a row a batch holds
  waits for that batch only: at most 1.5 s, under the issuers' 2 s and the
  trigger's 5 s, and a few milliseconds as measured. A lock timeout (a migration
  holding a table) or a statement timeout ends that step for this run and logs a
  warning naming it.
- A run takes at most 200 rows per table per batch, 250 batches per step (50,000
  rows) and 30 s.

What it costs, measured on the local Postgres 15 test container after a restart,
with 1,000 live connections, each 90 days into hourly rotation (2.16 million
ancestor rows, 490 MB of partner tables):

| Run | Time | Transactions | Slowest transaction |
| --- | --- | --- | --- |
| Empty tables | 8 ms | 6, read-only | 2 ms |
| Nothing due | 37 ms | 6 | 9 ms |
| A heavy hour: 1,000 rotations, 10 families ended with 2,160 ancestors each, 200 each of expired sessions, abandoned codes, deleted accounts' codes and consent screens | 1.4 s, 25,020 rows | 128 | 39 ms |

The partner tables stay small because the sweep keeps them small. If it has been
off for weeks they will not be: with 90 days of history left everywhere (2.16
million rows in each token table) a run still deletes 50,000 expired access tokens
in 1.2 to 4.5 s, but the rotated-refresh and family steps time out on reads over
the whole token tables and report busy until the access tokens are gone, about 44
hourly runs. Nothing waits on them meanwhile; rows only stay longer.

Anything else that deletes an `oauth_session` row must delete the access tokens
bound to it in the same transaction, for the same `SET NULL` reason. Anything that
deletes a grant must delete its family's ancestry with it, or a replay of an old
token takes the climber's row lock on every attempt.

**Turn the job off:** `DELETE FROM pgboss.schedule WHERE name = 'partner-oauth-sweep';`.
Every boot schedules it again, so to keep it off across restarts revert the
registration in `packages/backend/src/index.ts`. Nothing a request reads depends
on it; rows only wait longer.

### Test suite required before launch

The OAuth launch gate is separate from the first-party migration gate.
Tests run against the pinned provider, real Postgres and two backend instances,
not mocks of library internals.

Protocol coverage includes PKCE S256 for every client, exact redirects and
allowed native loopback behavior, unknown-client errors, code expiry and
single use, client-specific authentication methods, discovery/issuer
consistency, opaque resource-bound tokens (a missing resource at authorization and
code exchange, a wrong one at every grant step, and a refresh keeping the grant's audience),
scope ceilings, remembered-consent widening with newly
issued tokens and unchanged old-token scopes, and refresh issuance
only with `offline_access`. Prove refresh on day 30 and after day 90 of
continuous rotation, after ordinary browser sign-out, and after session expiry.
The 1-hour access, 90-day refresh and 60-second code targets are acceptance
requirements, not promises inferred from defaults.

Concurrency coverage uses barriers to race code redemption, refresh rotation,
disconnect, password reset and reconnect across instances. Assert one usable
successor for one-time credentials, no token after security invalidation, and
no resurrection of an old connection generation. A consumed-row update must
fail on repeated consumption; merely returning zero affected rows is not a
successful single-use guard. The launch suite races code redemption, refresh
rotation and a refresh against Disconnect across two instances behind a barrier,
and a refresh against a password reset. A reconnect is raced by the old
generation's refresh token, which Disconnect deleted, so it is refused before
any lock and needs no barrier. Repeated consumption, and rollback of a failed
mint, are proven at the authority in `auth/partner/__tests__/partner-oauth-flow.test.ts`.

Adversarial coverage includes consent CSRF, forged continuations, clickjacking
(`frame-ancestors 'none'`), unsafe callback URLs, stale migrated sessions,
client A's credential presented as client B, and third-party tokens on
first-party/GraphQL/native/watch endpoints. Test immediate secret rotation,
app suspension/deletion, account deletion, connection cleanup failure, and
correct CORS/headers for expired-token and rate-limit errors. Ordinary
first-party sign-out must not silently revoke an offline connection; explicit
security revocation must. The launch suite covers each of these against the
real server except three. The www consent page's own `frame-ancestors`: the
API host's error page is checked there, and the consent page is tested with the
page itself (`packages/web/app/oauth`, #6981 F14). Registering an unsafe
callback URL: the suite only sends authorize to a redirect URI the app never
registered, and the registration rules (fragments, `http://` off loopback,
`boardsesh` hosts and schemes) are tested in
`auth/partner/__tests__/partner-registration-rules.test.ts`. CORS on `429`: the
route suites (`partner-auth-routes.test.ts`, `partner-v1-api.test.ts`) check it,
since reaching a limit for real takes hundreds of requests.

Independent adversarial agent reviews, by agents that did not write the code and
working from the OAuth threat list, run before the first connection and again
before milestone 2 opens registration. Failure of any launch gate blocks that
deliverable; it does not authorize a fallback implementation.

**The launch suite** (`packages/backend/src/__tests__/partner-launch-suite.test.ts`,
#6981 F17) runs this list on the assembled stack: the real `startServer`, real
Postgres and Redis, the www session cookie the installed NextAuth writes, and
oauth4webapi, an OAuth client nobody here wrote, as the partner app. It walks
registration, consent through the session bridge, the code exchange with PKCE,
`/v1/me`, refresh rotation and reuse, Disconnect and reconnect, every row of the
revocation table above, the retention sweep, suspend, secret rotation, app
deletion and `revoke-user`, and each mode with the web's own mode in step and
out of it. A second copy of the backend, loaded fresh in the same process with
its own authority and pools, is the second instance. Time moves by rewriting
rows, never by waiting, and races wait on what `pg_stat_activity` reports. It
needs `REDIS_URL`, like the other partner route suites, and runs in about 30
seconds in the `backend` project.

It cannot prove: browser CORS in real Chromium and WebKit, the www consent and
sign-in pages, consent on iOS Safari and Android Chrome, Cloudflare and Railway in
front of the API host, and Sentry and PostHog redaction. The logbook routes and
Connected apps have their own suites (L4, F16). The end-to-end journey below covers the www pages and the credentialed consent CORS in
Chromium.

#### End-to-end journey

`packages/web/partner-oauth-e2e/` (#6981 F18) drives one app's whole life in
Chromium, on the real www pages and the real backend:

1. A developer signs in on www and registers a public native app with a loopback
   redirect, through the console's own GraphQL operation (`CREATE_OAUTH_CLIENT`)
   and with a publisher name.
2. The app (oauth4webapi) discovers the issuer, which must advertise `iss` on
   authorization responses (RFC 9207), and sends the climber's browser to
   authorize. The climber signs in on `/oauth/sign-in`, then sees the consent
   screen with the app name, "Made by", the scope lines and the unreviewed-app
   line, and presses Allow.
3. The app checks `state` and `iss`, and exchanges the code with PKCE and
   `resource=https://api.boardsesh.com/v1`.
4. It reads `/v1/me`, bootstraps the logbook (one seeded tick from 400 days
   earlier), then finds a tick the climber logs through GraphQL afterwards on
   `/v1/logbook/changes` and `/v1/logbook/ticks/{id}`.
5. It refreshes, and the rotated pair works.
6. The climber opens Connected apps on www `/settings`, opens the app (its scope
   lines show), presses Disconnect and confirms, which sends the `disconnectApp`
   mutation with their own session. The app's next call gets `401 invalid_token`
   and its refresh `invalid_grant`.

Run it with `vp run db:up` once, then `vp run test:e2e:partner-oauth`. A warm run
takes about 15 seconds; the first one waits for `next dev` to compile the pages
(budget 5 minutes). It writes two accounts with `partner-e2e-` ids and
`@example.invalid` emails to the dev database and deletes them at the end
(`PARTNER_OAUTH_E2E_KEEP_DATA=1` keeps them). Server logs land in
`packages/web/test-results/partner-oauth/`.

How it fits together. The global setup starts `packages/backend/src/index.ts` and
`next dev`, both with `PARTNER_OAUTH_MODE=allowlist` and one shared
`NEXTAUTH_SECRET`, and gives www `NEXTAUTH_URL=https://www.boardsesh.com`, so
NextAuth writes the production cookie: `__Secure-next-auth.session-token` on
`.boardsesh.com`. The consent page calls `https://api.boardsesh.com` and needs the
exact origin `https://www.boardsesh.com`, so the browser has to be on the
production host names. `edge.ts` makes that true on one machine: Chromium's proxy
tunnels only `www`, `api` and `ws.boardsesh.com` on port 443 into a TLS server with
a throwaway certificate, which forwards to the two local servers and sets
`X-Forwarded-For` the way the real ingress does. Every other host is refused. So
are www's `/monitoring` and the backend's `/api/posthog`: the pages believe they
are on production, and those two paths would forward the browser's Sentry and
PostHog traffic to the real projects.

Nothing else the servers run with can reach a service either
(`server-environment.ts`). They inherit only what a shell needs to run `vp`,
Node and Next (`PATH`, `HOME`, locale, temp and `VP_*`), never the rest of the
caller's environment. The environment files each server reads by itself (Next's
`.env*` in `packages/web`, the backend's `.env`, `.boardsesh/dev-db.env` and
`.env.development.local`) are folded in the way the server would: a
credential-looking name a file would supply (`*_KEY`, `*_SECRET`, `SMTP_*`,
`POSTHOG_*` and the like) is set to an empty string, which beats the file, and
setup refuses to start, naming only the variables, if any value left names a
host that is not this machine or a private network. `NEXTAUTH_URL` and
`NEXT_PUBLIC_APP_URL` are the two exceptions: they are links and cookie names,
never fetched by a server, and `NEXTAUTH_URL_INTERNAL` keeps NextAuth's own
calls local.

Each server runs under `watchdog.mjs` as the leader of its own process group.
Teardown always signals the whole group, and the watchdog ends the group within
a second of the Playwright runner disappearing, even by `SIGKILL`, so a killed
run never leaves `next dev` or the backend behind. Setup chooses the two account
ids before it seeds, so a failure at any point after that still deletes them,
and each seed first deletes this suite's accounts left over an hour ago by a run
that was killed outright.

The climber's browser declines the analytics prompt a signed-in account without
an analytics choice sees once, as a climber would; the developer's and the
climber's pages otherwise run untouched.

What it does not prove:

- Refusals. It walks the path that succeeds; a wrong verifier, a wrong or
  missing audience, a replayed code or refresh token, a stale session and the
  other negative cases are covered only by the launch suite.
- The app's own `DELETE /v1/connection`; the launch suite covers it.
- A production build, Cloudflare and Railway, Safari and Android browsers, social
  sign-in, the developer console's screens, and a confidential client (the launch
  suite covers secrets).
- It is not in CI yet. It needs the dev database image, as the dispatch-only E2E
  shards do.

---

## Self-service registration

A developer console at `https://www.boardsesh.com/developers/apps`
(`robots: noindex`), backed by internal GraphQL mutations in
`packages/backend` (`createOAuthClient`, `updateOAuthClient`,
`rotateOAuthClientSecret`, `deleteOAuthClient`, `myOAuthClients`).

Form fields: name, publisher name, homepage URL, privacy policy URL, the
developer terms box (registration only), client
authentication type, web/native application topology and redirect URIs. Registration binds
the client to the published `https://api.boardsesh.com/v1` resource; developers
cannot expand its resource permissions. The secret (confidential clients) is shown once. No icon upload in the
first version: the consent page shows a lettered avatar, so there is no image
moderation to run.

Rules enforced without a human:

| Rule | Value | Why |
| --- | --- | --- |
| Developer account | Signed in, email verified, and listed in `PARTNER_OAUTH_DEVELOPER_ALLOWLIST` until stage D | Accountability without paperwork |
| Apps per developer | 10 | Bounds a single bad actor |
| Redirect URIs per app | 10 | |
| Redirect URI forms | `https://…` (any host); `http://127.0.0.1:{any port}/…` and `http://[::1]…` (loopback, RFC 8252 §7.3, port ignored when matching); private-use schemes with a dot, `com.example.app:/…` (RFC 8252 §7.1). Rejected: `http://` elsewhere, `javascript:`, `data:`, `file:`, fragments, wildcards, any URI on a `boardsesh.com` host, and the schemes `boardsesh` and `com.boardsesh*` (our own app's) | Loopback lets scripts and local AI-built tools integrate with no hosting |
| Matching | Exact string, except the loopback port | |
| Names | App and publisher names alike. Case-insensitive denylist: Boardsesh, Aurora, Moon Climbing, every board brand in `BOARD_TYPE_LABELS` (Kilter, Tension, MoonBoard, Decoy, Touchstone, Grasshopper, So iLL, Woods), and lookalikes | Consent phishing |
| Connections per app | 25 live and 20 new in any 24 hours while registration is allowlisted (decision 22, the `oauth_app_policy` defaults). The owner raises one app's caps in its policy row; there is no request form in the console yet. The default for stage D is still open (200 new a day was the proposal) | Bounds the damage of a phishing app |
| Scopes | Any app may request any published scope. The consent page lists them | No approval tier |

The consent screen shows: the app name, "Made by {publisher name}" when the app
has one (never the developer's account name),
the redirect host, the app's homepage and privacy links, one line per scope,
and "Boardsesh hasn't reviewed this app. Only connect apps you trust." That
line is on every app; a verified-domain badge (the developer proves control of
the homepage domain with a `/.well-known/` file) is a later, automated
addition, not an approval queue.

Admin tools: suspend an app (with a reason the developer sees), list an app's
connection count and error rate. The first version is a backend script under
`packages/backend/src/scripts/`, like the other ops tools.

### What the backend does today (F12)

**Operations.** `myOAuthClients`, `createOAuthClient`, `updateOAuthClient`,
`rotateOAuthClientSecret` and `deleteOAuthClient` in `@boardsesh/shared-schema`,
served by `graphql/resolvers/oauth-clients/partner-registration.ts` on the
ordinary GraphQL pool. Each checks, in this order: the mode (`off` answers
`NOT_FOUND`, `hold` answers `SERVICE_UNAVAILABLE`, before anything else); a
signed-in Boardsesh account (first-party credentials only: a partner token is
opaque and never authenticates GraphQL); the developer's own rate limit;
`PARTNER_OAUTH_DEVELOPER_ALLOWLIST`, comma-separated user ids, empty meaning
nobody; then the per-address limit. Creating an app also needs `emailVerified`.

**`open` still means the allowlist.** `emailVerified` was stamped without proof
while verification was off (BA-02 D3), so the fast path keeps open registration
closed until BA-02 ships or registration sends its own email proof. Until one of
those lands, `open` registers the same allowlisted developers as `allowlist`.

**Rate limits.** Writes: 10 a minute per developer and 30 per address. Reads:
60 and 120. The developer's bucket is charged once the account is known, so only
that account can spend it. The address bucket is charged only for an allowlisted
developer, so throwaway accounts behind the same address cannot fill it and lock
a listed developer out. It is keyed by `ConnectionContext.trustedClientIp`
(`getTrustedClientIp`, the key the partner OAuth routes use): `cf-connecting-ip`
counts only from a verified Cloudflare edge, otherwise the hop the private ingress
appended, and an IPv6 client is its /64. GraphQL's older `clientIp` believes that
header from anyone.

**What registration fixes.** It uses the provider's managed registration
(`adminCreateOAuthClient`) and writes every field but the developer's own:
`skip_consent: false`, `require_pkce: true`, `grant_types` authorization code
and refresh, `response_types: code`, the published scopes, and exactly the API
resource. `token_endpoint_auth_method` is `none`, `client_secret_basic` or
`client_secret_post`; `private_key_jwt` is refused, because its `jwks_uri` would
be fetched inside the token transaction. After the provider writes the row, the
same transaction reads it back and rolls back if any of those differ. Edits
write only name, homepage, privacy policy and redirect URIs, never through the
provider's update, which can also reach consent and PKCE. Each developer's
writes take an advisory lock, so the 10-app cap holds under a race. Every new
app gets an `oauth_app_policy` row with decision 22's launch caps: 25 active
connections and 20 new a day. Consent enforces them (F13).

**Secrets.** Generated by the provider (32 letters), returned once by create or
rotate and never readable again, and stored the way the authority stores every
client secret: encrypted with `PARTNER_OAUTH_SECRETS` (`storeClientSecret:
'encrypted'`). Rotation replaces it in one write, so the old secret stops at
commit.

**Changing a suspended app.** Refused, delete included: the record stays for ops
and still counts toward the developer's 10.

**Deleting an app** (`lockAppForDeletion` in `auth/partner/locks.ts`) takes
every lock its cascade will need first, in the partner lock order rather than
Postgres's cascade order: `users` FOR SHARE for every climber with a connection
or an open consent screen for the app (in id order), then those consent screens
FOR UPDATE, then the connections FOR UPDATE, then the pending codes, then the app
row, whose cascade takes tokens, consent, grants, subjects and policy. A consent
answer locks its screen before the connection, so the screens come before the
connections here too; Disconnect and the password trigger lock the connection and
skip or wait for nothing this holds. A screen opened after the first pass and
already held by a consent answer is the one wait that could still close a cycle,
so the second pass over the screens is NOWAIT: the delete answers `busy` and the
developer retries, instead of Postgres aborting the climber's answer with a 503.
The `users` FOR SHARE pass is what makes a password reset (whose trigger locks
the climber's row first) wait for the delete instead of deadlocking with it.
Deleting a developer's account cascades into their apps the same way, so
`deleteAccount` calls `lockOwnedAppsForDeletion` (every app the account owns, in
client id order) after it locks the account's own row and before the users
delete, and `retryAccountDeletion` retries the NOWAIT refusal (55P03) as well as
40P01. The launch suite races an app delete against a consent answer, a refresh
and a Disconnect; with the old order the consent answer was the deadlock victim.
For account deletion no deadlock has been reproduced without the lock step (the
racing requests finish before the cascade), so there the step is a defensive
guard that keeps both deletions in one order; its launch-suite test proves the
requests queue behind the deletion, nothing more.

**The console** (F15) is `/developers/apps` on www, behind the server flag
`developer-console` (`packages/web/app/flags.ts`, fails closed; a signed-out
visitor is sent to sign in first). It lists, registers, edits, rotates and deletes
through the operations above. `OAuthClient.activeConnections` is the number of
climbers connected now, counted the way the caps count (`connected_at` set,
`revoked_at` empty); the delete confirmation states it. A new or rotated secret
is shown once in a dialog that closes only from its own button. It lives in
component state only: never in the React Query cache, a URL or a log.
Registering needs the developer terms box ticked; the form links to
`/developers/terms` (same flag) and sends `acceptedTermsVersion`, the shared
`PARTNER_DEVELOPER_TERMS_VERSION` from `@boardsesh/auth-protocol/partner-oauth`.
The backend takes its own copy of the version
(`PartnerAuthorityConfiguration.developerTermsVersion`): always the shared
constant in production, so publishing terms is a reviewed code change and never
an environment flip. Outside production (the backend's own test, the one its
Sentry gate uses, since Railway leaves `NODE_ENV` unset) a
`PARTNER_DEVELOPER_TERMS_VERSION` variable may name another version, which is how
the tests and the end-to-end journey register apps while the shipped terms are a
draft. While that version ends in `-draft` it refuses every registration with
`BAD_USER_INPUT`, reason `TERMS_UNPUBLISHED`, "Developer terms are not published
yet", in every mode that reaches registration. Otherwise it refuses any other
accepted value with `BAD_USER_INPUT`, so a console left open across a terms change
asks the developer to reload, and writes the version and the time to
`oauth_app_policy.terms_version` and `terms_accepted_at`. An edit does not ask
again, and apps registered before this have both columns empty. The route
sends `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `no-referrer` and
`no-store`, and loads no ad pixel. PostHog on www is the lite SDK with no
autocapture or replay, so it never sees the page's text.

**What the consent screen can show.** The app name is `oauth_client.name`, the
homepage `oauth_client.uri` and the privacy policy `oauth_client.policy`
(`name`, `homepageUrl`, `privacyPolicyUrl` in GraphQL). This plan has no
per-app terms URL; `oauth_client.tos` exists and stays empty.

"Made by" is `oauth_app_policy.publisher_name` (`publisherName` in GraphQL and in
the consent details), migration 0302. `createOAuthClient` requires it, under the
app name's rules (3 to 50 characters after trimming, a letter or number, no
control characters, nothing that imitates a denied name), and `updateOAuthClient`
can change it but never clear it. The column is nullable only for apps registered
before it existed; for those the screen shows no "Made by" line. It never falls
back to the developer's `users.name`: that can be their Google full name, and
anyone signed in can open a consent screen for any `client_id`. Migration 0302
adds the column with the 3-second lock guard and deploys alone, because ADD
COLUMN takes ACCESS EXCLUSIVE on `oauth_app_policy`, and every account deletion
cascades into that table.

**Exact redirect URI rule** (`partnerRedirectUriProblem` in `auth/partner/registration-rules.ts`):

| Form | Web app | Native app |
| --- | --- | --- |
| `https://` on any host but `boardsesh.com` and its subdomains, never a loopback host | Yes | Yes |
| `http://127.0.0.1` or `http://[::1]`, any port or none; the port is ignored when matching | No | Yes |
| A private-use scheme with a dot and no `boardsesh` in it, as `scheme:/path` or `scheme://host/path` | No | Yes |

Everything else is refused: `http://localhost`, other `http://` hosts, any
fragment (even an empty `#`), any `*`, a user name or password, whitespace or
control characters, more than 2048 characters, more than 10 URIs or the same URI
twice. A URI must be written exactly as a URL parser writes it back
(`https://app.example.com/`, not `https://App.Example.com`), so the stored string
is what the exact comparison sees. Homepage and privacy policy URLs must be
`https://` and not on `boardsesh.com`. Names are refused if, after folding case,
accents, spacing, punctuation and lookalike characters (`0` for `o`, `1` or `i` for
`l`, Cyrillic letters, `ı`, `ʙ` and other Latin small capitals), they contain
Boardsesh, Aurora, Moon Climbing or a board brand. A name that mixes Latin letters
with Greek, Cyrillic, Armenian or Cherokee ones is refused outright, because the
fold only knows the lookalikes it lists and drops every other letter outside a-z
(`Κilter` with a Greek Κ would otherwise reach the denylist as `lter`). A name
written entirely in one of those scripts is allowed. Publisher names follow the
same rules.

**Admin commands** (`packages/backend/src/scripts/partner-app-admin.ts`). Each
acts on exactly one id given on the command line and writes nothing without
`--apply`; a dry run's transaction is read-only.

```
vp exec tsx packages/backend/src/scripts/partner-app-admin.ts suspend --client-id <id> --reason "<shown to the developer>" [--apply]
vp exec tsx packages/backend/src/scripts/partner-app-admin.ts unsuspend --client-id <id> [--apply]
vp exec tsx packages/backend/src/scripts/partner-app-admin.ts revoke-user --user-id <id> [--apply]
vp exec tsx packages/backend/src/scripts/partner-app-admin.ts set-publisher --client-id <id> --publisher "<shown to climbers>" [--apply]
```

`suspend` sets `oauth_client.disabled`, which the provider checks on every
authorize, token and revoke call, and records `suspended_at` and the reason on
the policy row. Tokens are kept, so `unsuspend` brings the app back. Other
backend instances drop its browser origins within the 60-second origin cache.
`revoke-user` calls `public.partner_revoke_user()`, the function the password
trigger calls, and reports the rows before and after. `set-publisher` sets the
"Made by" name under registration's rules, for an app registered before the column
existed or one whose publisher must be corrected; it works on a suspended app and
refuses an app with no policy row rather than creating one, since an app without
one can gain no connections.

`partner_revoke_user` is `SECURITY INVOKER`. It locks the climber's `users` row
`FOR NO KEY UPDATE`, which needs UPDATE on `users`, and needs SELECT, UPDATE and
DELETE on the `oauth_` tables. Run the script with a `DATABASE_URL` for the
`boardsesh_runtime` login, the backend service's own: the migration runner's ACL
reconcile already grants it DML on every table and EXECUTE on every routine, so
no production change is needed. The script opens every transaction as READ
COMMITTED itself, because the function refuses any other isolation, whatever the
login's default. A test runs it as a role with exactly those grants, and shows it
fails with `42501` once UPDATE on `users` is taken away.

---

## The public API

Host `https://api.boardsesh.com`, every path starting `/v1`. JSON, UTF-8,
camelCase. Timestamps
are RFC 3339 in UTC. Ids are strings. The contract lives in a new pure-TS
package, `@boardsesh/public-api` (`packages/shared/public-api/`): zod schemas
for every request and response, an OpenAPI 3.1 registry, and a committed
`openapi.json` that CI regenerates and diffs, so a contract change shows up in
review as a JSON diff. The backend validates requests with those schemas and
contract tests validate responses against them. The web docs render the same
file. Regenerate it with `vp run generate:public-api-openapi`; the `check:public-api-openapi`
step in the CI `guards` job fails a PR whose committed copy is stale.

Milestone 1 routes:

| Route | Scope | Returns |
| --- | --- | --- |
| `GET /v1/me` | any | `{ id }`, plus `displayName`, `avatarUrl` with `profile:read` |
| `DELETE /v1/connection` | any | Disconnect this token's app/climber connection; `204`, or `401` if its credentials are already invalid |
| `GET /v1/logbook/changes?cursor=&limit=` | `logbook:read` | The change feed below |
| `GET /v1/logbook/ticks/{id}` | `logbook:read` | One tick, or `404` if it was deleted or never existed |

`avatarUrl` is only ever an https URL on our media host (an uploaded avatar, stored
as a `/static/avatars/…` path, is resolved to it) or on a sign-in provider's image
host: Google's `lh<n>.googleusercontent.com`, Facebook's
`platform-lookaside.fbsbx.com` and `*.fbcdn.net`. Sign in with Apple shares no
picture. A profile can hold any URL the climber typed, and an app that fetches
avatars on its server must never be pointed at an internal host or a cloud metadata
service, so everything else, including credentials or a port in the URL, is `null`.

Milestone 3 adds `/v1/workouts` (see partner-api.md).

### The tick

One shape everywhere a tick appears (logbook, workout results, later webhooks):

```json
{
  "id": "0d6c4a2e-8f1b-4b7e-9c3a-5e2f1d0a9b77",
  "climbedAt": "2026-10-20T18:42:11Z",
  "status": "send",
  "attempts": 3,
  "angle": 40,
  "mirrored": false,
  "stars": 4,
  "grade": { "v": 4, "font": "6B+", "label": "6b+/V4" },
  "benchmark": false,
  "comment": "Finally stuck the cross-through",
  "climb": {
    "id": "3f9c2a1e5b7d4c8e9a0b1c2d3e4f5a6b",
    "name": "Slopey Business",
    "board": { "type": "kilter", "layout": "Kilter Board Original" },
    "grade": { "v": 4, "font": "6B+", "label": "6b+/V4" },
    "boardseshGrade": null
  },
  "createdAt": "2026-10-20T18:42:15Z",
  "updatedAt": "2026-10-20T18:42:15Z"
}
```

Mapping from `boardsesh_ticks` (semantics in [ascents-and-attempts.md](./ascents-and-attempts.md)):

| Field | Source | Notes |
| --- | --- | --- |
| `id` | `uuid` | Stable, never reused. Not the bigserial `id` |
| `status` | `status` | `flash`, `send`, `attempt`. New values may be added; the public docs tell apps to treat an unknown one as `attempt` |
| `attempts` | `attempt_count` | |
| `stars` | `quality` | 1–5 or `null` |
| `grade` | `difficulty` via the board's grade table | The climber's own grade; `null` when they gave none |
| `comment` | `comment` | The climber's note. The column defaults to `''`; an empty string is served as `null` |
| `climb.id` | `COALESCE(board_climb_aliases.canonical_uuid, climb_uuid)`, joined on `(board_type, alias_uuid)` | Canonical at read time. A catalog merge writes a change row for every affected tick (trigger 4 below), so apps see the new id |
| `climb.grade` | `board_climb_stats.display_difficulty` at the tick's angle | Community grade at read time. It drifts without a tick change; documented |
| `climb.boardseshGrade` | Not read yet | Always `null`: the Boardsesh grade is kept on the difficulty-id scale and no V-scale conversion is documented (see "The routes, as built (L4)") |
| `climb.board.type` | `board_type` | `kilter`, `tension`, `moonboard`, `spray`, … Clients must tolerate new values |

Deliberately left out: `origin` (which sync wrote the row), Aurora and Kilter
bookkeeping, `board_id`, `session_id` (an invite link, see risks), setter
names (other people's personal data, not needed to read a logbook), hold
positions.

### Errors

API errors are one shape:

```json
{ "error": "invalid_cursor", "message": "cursor is not a value this API issued", "requestId": "req_7Hc…" }
```

`field` is added for validation errors. OAuth endpoints use the RFC 6749 §5.2
shape instead (`error`, `error_description`). A suspended or deleted app gets
`invalid_client` at the token endpoint and `401 invalid_token` from the API; an
app over its daily connection cap gets `error=temporarily_unavailable` back
from `/api/auth/oauth2/authorize`. The full table is in
partner-api.md. Every response carries `Boardsesh-Request-Id`, which is what
a developer quotes when something is wrong and what our logs index on.

### Versioning

The path carries the major version. Additive changes ship on `v1` without
notice: new fields, new routes, new scopes, new enum values. Clients ignore
fields they do not know and tolerate enum values they do not know. Removing or
renaming anything is `v2`, with `v1` kept for at least six months and a
`Sunset` header on its responses for the whole period. A public changelog
page lists every contract change; CI fails a PR that changes `openapi.json`
without a changelog entry.

The changelog is `packages/shared/public-api/src/changelog.json`, newest entry
first, each with the date, what changed, and the SHA-256 of the committed
`openapi.json` it describes (`PUBLIC_API_CHANGELOG`, which the changelog page will
render). The `public-api-changelog` step in the CI `guards` job
(`vp run check:public-api-changelog`, `scripts/check-public-api-changelog.ts`)
fails when the newest entry does not name the committed document's hash, on
every run, so a document change needs a new entry. On a PR it also fails when an
entry already on the base branch changed or went missing, so an old entry cannot
be re-pointed at the new document instead. Two neighbouring entries may not name
the same document, since an entry records a change; a document may come back
further down, so reverting a change is a new entry naming the older hash. The
package's own test checks the hash against the generated document locally.

---

## Incremental sync

### The feed

```
GET /v1/logbook/changes?cursor=<opaque>&limit=100
```

```json
{
  "changes": [
    { "type": "tick", "tick": { "id": "0d6c…", "...": "..." } },
    { "type": "tick.deleted", "id": "9a1f…" }
  ],
  "cursor": "c3.eyJnIjoi…",
  "hasMore": true
}
```

- No `cursor` starts a complete snapshot bootstrap, followed by incremental
  catch-up. It does not replay the retained change log as a substitute for
  existing history. The same response shape and loop cover both phases.
- `limit` 1–200, default 100.
- Keep calling with the returned `cursor` while `hasMore` is true. During
  incremental sync, commit each page and its cursor together even when empty.
  During bootstrap, stage a replacement and publish it with the final cursor
  only after catch-up finishes; never persist a partial bootstrap as an
  ordinary incremental checkpoint.
- Snapshot entries carry the state captured when the snapshot was created;
  incremental entries carry the tick's state **at the time of the read**. A `tick` is
  an upsert by `id`; `tick.deleted` means the tick no longer exists for this
  app (deleted, or hidden as a duplicate) and removes it.

### Complete bootstrap and transition

The server materializes a temporary snapshot of every visible tick for this
climber, including ticks that predate the change-log migration or have not
changed within retention. The build is paged, not one transaction:

1. `startLogbookSnapshot` captures the current feed generation and horizon `H`
   in one short transaction and commits the snapshot row, with its starting
   change position `(H, 0)`, before any tick is copied.
2. `advanceLogbookSnapshotBuild` copies 200 ticks at a time, each page in its
   own short transaction (a 5 s statement timeout, no snapshot held between
   pages), using the same ownership/twin/privacy rules and serializer as the
   feed. It stops after a time budget, so a request never holds a transaction
   across the build, and any later call resumes it from the position stored on
   the row. The app's polling drives it: while the build is unfinished the
   route answers an empty page and `hasMore: true`, the same as an empty
   incremental page.
3. The snapshot publishes only when the last page commits and the row turns
   `ready`. Until then nothing is served, and a failure publishes no partial
   snapshot.

Starting a snapshot for a connection joins the build or finished snapshot it
already has, as long as the feed can still continue from it (same generation,
catch-up not pruned), so a crash retry or a second worker reuses the copy. `start`
reports whether it created or joined, and only a real creation counts against
the creation rate limit. Anything else about the connection's old row is retired
only once the new one is certain, so a capacity refusal leaves it in place.

This is a server-side copy, not an open database transaction held across HTTP
requests. Pages are read at different points in time; the hand-off below is why
that is still exact. `services/logbook-snapshot.ts` is the implementation and
the costs are under [What it costs](#what-it-costs). The route runs it on a small
dedicated connection pool, two per backend process (one build, one for starts
and page reads), so a cold chunk cannot hold a connection first-party queries or
token refreshes need ([db-connectivity.md](./db-connectivity.md#dedicated-pools)).

Bounds, none of them silent:

- A snapshot over 250,000 ticks stops with `too_large` rather than truncating
  the logbook, and `start` keeps answering `too_large` for an hour so a restart
  cannot rebuild it.
- At most 2 chunks copy at once across the cluster, enforced per chunk with
  advisory-lock slots. A call that finds no free slot answers "still building".
- A chunk's join plan is forced to nested loops, because the planner's merge
  anti-join on the twin rule cost in proportion to the chunk's position, and
  chunks walk `(updated_at, id)`, which an existing index serves without reading
  a group of equal timestamps whole.
- The statement timeout stays at 5 s, with `idle_in_transaction_session_timeout`
  at 10 s so a frozen client cannot keep a slot. A worst-case fully cold chunk
  needs about 17 s at 30 ms a page, so it times out three times and succeeds on
  the fourth: the pages already read stay in shared buffers.
- A timeout is logged with the snapshot id only, and the build sits out 5 s so it
  cannot hold a slot back to back. Twenty timeouts in a row with no chunk copied
  end the build as `stalled`, and `start` keeps answering `stalled` for an hour.
  That shape cannot finish: Aurora twins by the tens of thousands at one instant,
  where the anti-join is quadratic in hidden rows. A slow disk resets the count
  every time it manages a chunk.
- Every snapshot's ticks together are capped at 25 million until expired ones
  are reclaimed. `start` refuses at the cap and a running build waits at it.
- A `start` that cannot get its locks in time answers `busy`, not an error.

Snapshot cursors identify that snapshot and its next page. Snapshots are bound
to the authenticated app/climber connection, checked on every page. The database
clock enforces two limits whether or not the reclaim job has run: a build has 3
hours, and a finished snapshot is readable for one hour. Expired rows are reclaimed by the
`reclaim-logbook-snapshots` worker family (every 15 minutes, at most 200 batches
a run, each batch up to 100 snapshots and 500 chunks, safe to retry or run
twice). Rows cascade from `users`, so a deleted account's snapshot goes with it.
Responses use `Cache-Control: no-store`. Rate-limit new snapshot creation
separately from incremental reads; one sync worker per connection avoids
accidental duplicate full downloads.
Authorization and privacy always use current policy at page delivery: check the
connection again, and reapply the serializer's current public-metadata redaction
in that page's read transaction. A wall made private after snapshot creation
must not leak its formerly public names from stored snapshot payloads. Preserve
the snapshot's tick values/identity and recompute or redact its public climb
metadata; fail closed if current authorization cannot be checked.

The final snapshot page returns the ordinary change cursor `(H, 0)` and
`hasMore: true`, even if it contained no ticks. The client must then drain
changes until `hasMore: false` before publishing the replacement copy.

**Why a paged snapshot plus the feed is exact.** `H` is taken first, and its
transaction commits before any page is copied.

1. Every copied page reads a snapshot taken after `H` was read, so it sees every
   transaction below `H`: `H` is `pg_snapshot_xmin`, so nothing below it can
   still be in flight when the first page runs.
2. A write that commits later has a transaction ID at or above `H`, and the feed
   serves every change row at or above `H`, in any commit order (`Why it cannot
   skip a change`). The trigger writes that row in the writer's own transaction,
   so a page cannot have seen a write the feed will miss.
3. Either a change is below `H`, in which case every page sees it, or it is at
   or above `H`, in which case the feed replays it. There is no third case, so
   no page has to see a consistent moment and no snapshot stays open across the
   build. Twin visibility and alias changes go through the same two paths, since
   the same triggers log them.

Pages are ordered by `(updated_at, id)`. The proof above does not depend on the
order. A tick edited during the build may be copied twice (the later copy is the
newer state) or not at all (the feed replays it), and a tick deleted mid-build
may be copied before
the deletion arrives as `tick.deleted`. Upserts and removals make all of that
harmless: at least once, in the order the guarantees below describe. Some
already visible writes at or above `H` are replayed too.

Validate the saved change position against the pruning watermark in the same
snapshot as every incremental page. If history necessary for catch-up was
pruned during the download, or the temporary snapshot expired, return `410`
and restart bootstrap; never promote an incomplete copy. A client stages the
whole replacement and atomically swaps it into its local store together with
the final cursor. A crash leaves its old copy intact and a durable full-sync
requirement, so retry starts a fresh snapshot. The public example specifies
these storage operations and does not keep reconciliation markers only in
memory.

### The routes, as built (L4)

Code: `handlers/public-api/logbook.ts` (the routes), `logbook-cursor.ts` (the
cursor), `services/logbook-tick-serializer.ts` (the tick) and
`auth/partner/logbook-access.ts` (pools, admission, the page check). Tests:
`partner-logbook-api.test.ts` through HTTP, `partner-logbook-units.test.ts` for
the pure parts.

**Checks, in order.** The token check, limits and admission of every `/v1` route
come first (Availability above), so nothing below runs or is charged before a
token has passed. Then: no `logbook:read` is `403 insufficient_scope` with
`WWW-Authenticate: Bearer error="insufficient_scope", scope="logbook:read"`; a bad
`limit` (or an empty `cursor`) is `400 invalid_request` with `field`; a cursor this
API did not issue is `400 invalid_cursor`; `c3.expired`, a cursor sealed under a
retired secret, and a cursor of another app's connection or from before a
reconnect are `410 cursor_expired`. A climber's own ticks are the only ones read:
every read is keyed by the token's connection, never by anything the app sends,
and no response or cursor carries `users.id`.

**The cursor** is `c3.<secret version>.<sealed>`: AES-256-GCM over its kind, the
connection id and generation it is bound to, the position (`(txid, seq)` and the
feed generation for a change cursor, snapshot id and offset for a snapshot
cursor) and an issue time kept for diagnosis. The key is derived from the
`PARTNER_OAUTH_SECRETS` entry of that version, so an app cannot read or build a
cursor, and rotating the secret keeps old cursors working while the old version
is still listed. The version is at most nine digits, and the authority refuses
to start with a larger one (`PARTNER_SECRET_MAX_VERSION`), so an epoch-seconds
version cannot quietly turn every cursor into `400 invalid_cursor`.

**A change cursor** reads one feed page on the partner pool, inside the `/v1`
admission permit the token check holds, bounded at 5 s per statement and 2 s per
lock wait.

**No cursor, or a snapshot cursor,** gives that permit back first and runs on the
snapshot pool (Database load below), so a build never holds one of the two `/v1`
connections:

1. No cursor starts or joins the connection's snapshot. Only a real creation is
   counted against the creation limit (2 a minute per connection,
   `api-snapshot-create`): with the limit spent, a request that would join still
   joins, and only one that would create answers `429`. At the storage cap the
   answer is `503` with `Retry-After: 900`, the reclaim job's interval; a start
   that cannot get its locks is `503` with `Retry-After: 2`.
2. While the snapshot builds, the request drives it for up to a second, if this
   process's one build permit is free (it never waits for one), and answers an
   empty page with the snapshot cursor and `hasMore: true`. If the build finished
   in that second, the first page is served at once instead.
3. A build that ended `too_large` or `stalled` is over: nothing resumes it, and
   both its cursor and a restart answer `503` with `Retry-After` set to the
   seconds until its one-hour verdict lapses.
4. A gone, expired or other-generation snapshot is `410`.

A statement timeout or lock timeout (57014, 55P03) on either path is an empty
page at the same cursor with `hasMore: true`, so the app simply asks again. A
single tick has no empty page to give, so there it is `503` with `Retry-After`.

**At delivery**, inside each page's read transaction, the connection row is read
again (same id, climber, app and generation, not revoked), so a Disconnect or a
password reset that committed after the token check ends that page with `401`;
then the climbs' public metadata is read in the same snapshot as the ticks. A
snapshot stores ticks, not names, so a spray wall made private after the
snapshot was built never serves its old names.

**The tick** follows the table in "The tick" above, with these details:

- A spray climb's name and wall name show to the wall's owner's apps and for a
  public wall: the by-layout rule with no viewer, so a gym membership, follow or
  grant the climber holds is not passed on to apps. A spray tick whose climb row
  is gone withholds both.
- A connected app sees every climb the climber has logged, including drafts and
  unlisted climbs set by others, in full: id, name, layout and grades, the same
  as any published climb (owner decision, 2026-11-10). The climber's logbook is
  their data. Whether a climb is a draft, unlisted, or set by a private account
  changes nothing here; only the spray-wall rule above withholds anything.
  Explaining this to the climber at consent is a separate follow-up.
- `grade` and `climb.grade` use the board's own grade table: `v` from its V grade,
  `font` upper-cased, `label` its `boulder_name` (MoonBoard's 6A is V2). A
  difficulty off the table is `null`.
- `climb.boardseshGrade` is always `null`. The model keeps the Boardsesh grade on
  the shared difficulty-id scale (10 is 4a/V0), and clients surface it as
  `universal_grade ?? local_grade` rounded to a grade id and labelled by the
  board's table, never for a `setter_only` row ([boardsesh-grade.md](./boardsesh-grade.md),
  "Which grade a client surfaces"). Nothing documents a decimal V-scale form, so
  none is invented. Publishing it needs that decision first, for example a grade
  object built the way clients build theirs.
- Timestamps are the stored UTC values to the millisecond. A star rating outside
  1 to 5 is `null`.

`GET /v1/logbook/ticks/{id}` answers `404 not_found` for a deleted tick, a
hidden twin, another climber's tick and anything that is not a tick id alike.

### The change log

One table, `logbook_changes`, written only by triggers:

| Column | Type | Notes |
| --- | --- | --- |
| `seq` | `bigserial` primary key | Order within a transaction |
| `txid` | `xid8`, default `pg_current_xact_id()` | The writing transaction. 64-bit, never wraps |
| `user_id` | `text`, no FK | Whose logbook. No FK, like `sync_deletions`: deleting an account cascades into `boardsesh_ticks`, whose delete trigger writes rows for that same user, and those must not depend on cascade ordering. The rows age out in 90 days; nobody can read them, because the connections died with the user |
| `tick_uuid` | `text` | Which tick. No FK: the tick may be gone |
| `created_at` | `timestamp`, default `now()` | For pruning only |

Indexes: `(user_id, txid, seq)` for reads, and a BRIN on `created_at` that was
meant for the prune job. The job walks the primary key instead (see "Retention,
cursor validity and moving the database"), so nothing reads the BRIN index now;
it costs a few pages and can be dropped in a later migration.

Writers, all triggers (`AFTER … FOR EACH ROW` unless noted) added with a
`drizzle-kit generate --custom` migration, the way `0144_offline_sync_backend.sql` added the
existing tick triggers (guarded so a re-applied test schema does not roll back,
see the backend test-DDL notes):

1. On `boardsesh_ticks` insert and delete: one row for the tick.
2. On `boardsesh_ticks` update: one row, only when a column that either the
   serializer or the twin rule reads is `IS DISTINCT FROM` its old value. The
   serializer reads `user_id`, `board_type`, `climb_uuid`, `angle`,
   `is_mirror`, `status`, `attempt_count`, `quality`, `difficulty`,
   `is_benchmark`, `comment`, `climbed_at`, `created_at`, `updated_at`. The
   twin rule in `aurora-twin-dedup.ts` also reads `origin`, `aurora_id`,
   `aurora_type`, `aurora_synced_at` (its `isLocallyEdited` test) and
   `kilter_id` (it never hides a row when both carry one), so those count
   too: the pull's `toClear` path, a JSON re-import restamping
   `aurora_synced_at` and Kilter push-back stamping `kilter_id` all change
   what an app should see without touching a serialized field. Changing only
   `aurora_sync_error`, `kilter_type`, `kilter_synced_at`,
   `kilter_sync_error` or `board_id` writes nothing, which keeps no-op Kilter
   PowerSync redeliveries out of the feed. `session_id`, `climb_revision` and
   `kilter_detached_at` have no comparison of their own but still write a row,
   because `trg_boardsesh_ticks_set_updated_at` advances `updated_at` for them
   and `updated_at` is public and feeds the twin rule. A tick joining an
   inferred session therefore writes a second row. A `user_id` change writes a
   row for both climbers.
3. Twins: when the OLD or the NEW row is an Aurora-pull row with a real
   `aurora_id`, the trigger also writes a row for every other Aurora-pull row
   of that climber under the OLD natural key and under the NEW one (same
   board, climb, angle and `climbed_at`). An update that moves `climbed_at`,
   `angle` or `climb_uuid` can change visibility at both keys. Those are
   exactly the rows whose visibility under `notAuroraTwinDuplicate` the write
   can flip.
4. On `board_climb_aliases`: on insert when `alias_uuid <> canonical_uuid`,
   on update when `canonical_uuid` changed, and on delete (the canonical
   climb's deletion cascades alias rows and `climb.id` reverts to
   `climb_uuid`), a row for every tick with that `(board_type, climb_uuid =
   alias_uuid)`. The guard matters: Kilter's catalog sync
   (`packages/kilter-sync/src/sync/catalog-sync.ts`) re-upserts a self-alias
   for climbs and refreshes `last_seen_at` once a day, which an unguarded
   trigger would turn into a daily row for every tick on those climbs. Real
   merges are rare; the cost is one row per tick on the merged climb.
5. On `boardsesh_ticks` truncate: a `FOR EACH STATEMENT` trigger that raises.
   `TRUNCATE` fires no row triggers, so it would silently bypass the log. No
   production path truncates ticks today; tests that need to can disable the
   trigger explicitly.

As built:

- The tick and alias trigger functions are `SECURITY DEFINER` with a pinned
  `search_path`. The production deploy commits a migration's DDL before
  `reconcileMigrationRuntimeAcl` grants `boardsesh_runtime` on the new table, so
  a trigger running as the writer would fail every tick saved in that gap.
- Nothing in the tick trigger can fail for a valid row: its two columns are NOT
  NULL on `boardsesh_ticks`, the log has no foreign key and no unique key beyond
  the generated `seq`, and permissions are the owner's. It uses no `EXCEPTION`
  block on purpose: one per row is one subtransaction per row, which during a
  bulk import overflows the per-backend subtransaction cache and slows every
  snapshot in the cluster.
- The alias trigger is deferred to commit, so a tick committed while a catalog
  merge is in flight is picked up by that merge's fan-out instead of being
  served with the old `climb.id` forever. The window that remains is the gap
  between the deferred fan-out's snapshot and the commit, which is microseconds.
- `logbook_change_watermark` holds the one row that carries the feed generation
  and the retention watermark. The read path is
  `packages/backend/src/services/logbook-feed.ts`.

A trigger, not application code, because ticks are written by GraphQL
mutations, offline-sync pushes, the Aurora and Kilter sync daemons, JSON and
MoonBoard imports, admin scripts and migrations. A trigger covers every one of
them, including the ones written next year.

### Reading it

In one read-only `REPEATABLE READ` transaction, so the horizon and the rows
come from the same snapshot:

```sql
SELECT pg_snapshot_xmin(pg_current_snapshot()) AS horizon;   -- H

SELECT txid, seq, tick_uuid
  FROM logbook_changes
 WHERE user_id = $user
   AND (txid, seq) > ($cursor_txid, $cursor_seq)
   AND txid < $H
 ORDER BY txid, seq
 LIMIT $limit;
```

Then: collapse repeated `tick_uuid`s in the page to their last position; load
the current rows for those uuids through the same twin filter and tick
serializer the rest of the API uses; emit `tick` for a visible row and
`tick.deleted` for a missing or hidden one, in order of last position.

Next cursor: the last `(txid, seq)` read when the page was full
(`hasMore: true`); `(H, 0)` when it was not, meaning "everything below the
horizon for this climber has been read". The `c3.` cursor is an authenticated
opaque encoding of its kind (snapshot or changes), persistent feed generation,
connection ID/generation binding and position. Its issue time is diagnostic, not its expiry
rule. Neither `c1.` nor `c2.` from earlier drafts shipped. Validate generation,
binding, watermark and rows in the same read snapshot.

### Why it cannot skip a change

1. A transaction gets its `txid` before its first write and keeps it until it
   commits or aborts. Every change row carries the `txid` of the transaction
   that wrote it, and becomes visible exactly when that transaction commits.
2. `pg_snapshot_xmin` of a snapshot is the oldest `txid` still running when
   the snapshot was taken (or the next unassigned one if none are). Every
   transaction below it has finished; every transaction that can still commit
   has a `txid` at or above it.
3. So the set of committed rows with `txid < H` can never grow after the
   snapshot is taken. A read that returns those rows in `(txid, seq)` order,
   and a cursor that only advances through rows below `H` (or to `(H, 0)` once
   all of them for this climber have been read), cannot pass a row that later
   becomes visible.
4. Order does not have to match commit order. Two transactions can touch the
   same tick and commit in the opposite order to their `txid`s. Each change
   row only says "this tick changed"; the payload is the tick as it is at
   read time. After the cursor passes the last change to a tick, the app holds
   that tick's current state.

The milestone 1 tests prove the argument rather than trust it: interleave a
transaction that starts first and commits last with one that starts later and
commits first, read between and after, and assert both changes arrive; plus a
randomized test of concurrent writers (inserts, edits, deletes, twin pairs,
alias merges) and a polling reader, asserting after every run that the
reader's copy equals the database's public view.

### Guarantees

Written into the public docs in these words:

- **Complete.** Every committed change to a tick's public fields, every
  deletion, and every change that hides or reveals a tick appears in the feed.
  After a complete bootstrap, an app that reads until `hasMore` is false holds the current state of every
  change that had settled (see below) when the last page was read, including
  deletions.
- **Account deletion.** A deleted climber's connections die with the account,
  so the app's next call answers `401 invalid_token` and the refresh
  `invalid_grant`. That is the signal; no `tick.deleted` entries are sent.
- **At least once.** A tick can arrive more than once. Snapshot tick values
  describe the captured state with current privacy redaction; incremental
  entries describe current state at read time. Apply upserts/removals, never
  increments.
- **Incremental ordering is by transaction, not by clock.** Entries follow
  transaction-ID order, which need not match start or commit order. Each
  incremental entry carries current state, so the final state does not depend
  on commit ordering.
- **Visible once settled.** A change becomes readable when its transaction
  has committed and every write transaction that started before it has
  finished. Normally that is well under a second. A long write elsewhere in
  the database (a bulk logbook import) delays the feed until it finishes; it
  delays, it never drops.
- **Not changes:** values computed when you read: `climb.name`,
  `climb.grade`, `climb.boardseshGrade`, and whether a spray wall's names are
  shown. If you store them, refresh them when you show them.
- **Expiry.** A cursor stays valid until the change log has been pruned past
  it. Entries older than 90 days are pruned, and an empty page moves the
  cursor forward. Regular incremental sync normally avoids expiry; clients
  must still handle `410` after maintenance, snapshot expiry or feed reset.

### Retention, cursor validity and moving the database

- The daily `prune-logbook-changes` job (`services/logbook-prune.ts`; schedule,
  grants and cost in [background-workers.md](./background-workers.md)) deletes
  rows older than 90 days in batches of at most 500. **Every row a batch
  deletes sits at or below the watermark that the same transaction commits:**
  the batch raises `logbook_change_watermark.pruned_through` to the last
  position it deleted, and never lowers it. A feed page reads the watermark and
  the rows from one REPEATABLE READ snapshot, so it sees the rows with the old
  watermark, or the new watermark without the rows, never the gap between.
  There is never a committed deletion above the watermark. The 410 boundary is
  exact: the watermark is itself a deleted row's position, so a cursor below it
  answers `410 cursor_expired`. The watermark is global and the feed is per
  climber, so the deleted row may be another climber's: a 410 means this
  climber's changes may be gone, not that they are. A cursor at
  or above it is valid however old it is, because nothing after it was
  deleted. Validity is measured against what was pruned, not against when the
  cursor was issued.
- A batch deletes a row only when its transaction is below the transaction
  horizon (`txid < pg_snapshot_xmin`) in the deleting transaction. The feed
  never serves past the horizon, so a watermark above it would expire every
  cursor, including the one a reader was just handed. A long write transaction
  therefore holds pruning back exactly as it holds the feed back.
- "Older than 90 days" is by `created_at`, the writing transaction's start.
  The job walks the primary key (`seq`, insertion order) from the oldest row
  and stops at the first younger row; it does not use the BRIN index on
  `created_at`, which decays once deleted head pages are reused (measured in
  background-workers.md). Insertion order and feed order (`txid`, `seq`)
  disagree slightly, because a transaction's `txid` comes at its first write and
  its rows' `seq` at each insert. So a younger row can end up below the new
  watermark. It is kept, cannot be read (every cursor below the watermark
  answers 410), and goes once it is 90 days old without moving the watermark
  back. The cost of judging age by a transaction's start: a row whose
  transaction started over 90 days ago but wrote later can go, expiring cursors
  issued between that start and that write. So a cursor can answer 410 up to
  one write transaction's length short of 90 days. A rule that stops at the
  first younger row in feed order has the same cost. Batches need no
  lock on the watermark row before they start: each claims its rows `FOR
  UPDATE SKIP LOCKED` and raises the watermark only through what it deleted,
  so two runs at once delete each row once and leave the watermark at the
  highest position either deleted (tested).
- The test cursor `c3.expired` always answers `410`, so an app can test its
  recovery path.
- Store a random persistent feed-generation ID alongside the watermark and
  put it in every cursor and temporary snapshot. A mismatched generation
  always answers `410`, even if its transaction numbers happen to lie inside
  the current cluster's range. Transaction bounds detect malformed positions;
  they do not identify a database cluster.
- `xid8` values belong to one cluster. Only a proven lossless physical
  failover may preserve the feed generation
  ([postgres-dr-architecture.md](./postgres-dr-architecture.md)). A point-in-time
  restore, snapshot rewind, or lagging-replica promotion may lose changes
  already served to clients even while preserving/reusing transaction numbers
  and the backed-up generation. Rotate the generation and reset the feed on
  **any recovery that may discard acknowledged feed history**; uncertainty is
  sufficient to require reset. A logical move with `pg_dump`/`pg_restore`
  (the portability rule, and
  [neon-migration.md](./neon-migration.md)) starts a new cluster with smaller
  `txid`s, so the restored change rows cannot be interpreted as new-cluster
  changes. With the API and writers fenced during the move, rotate the
  persistent generation, clear the change log and temporary snapshots, and
  initialize the watermark before reopening traffic. Every old cursor now
  receives `410`, even months later after the new cluster's IDs catch up.
  Bootstrap reads all current ticks independently of the emptied log. An
  incompatible feed rebuild, PITR, snapshot rewind or potentially lossy
  physical promotion follows the same fenced generation-reset procedure.
  Test a client holding a cursor from before the rewind and assert `410`,
  including once transaction IDs overlap again.
- The horizon is cluster-wide. A session left idle inside a write transaction
  holds every feed back. The backend server and the web server end such a
  session after 60 s: their pools send `idle_in_transaction_session_timeout` as
  a startup parameter, so no `ALTER ROLE` is needed (see
  [db-connectivity.md](./db-connectivity.md), "Idle transactions end after 60 s
  on request pools", for which pools are covered and why 60 s). Workers, the
  sync daemons and scripts are not covered, so still alert when the oldest
  running write transaction is more than 5 minutes old
  ([Observability](#observability)).
- Reads run on the primary in milestone 1. Moving them to a hot standby means
  first proving the same horizon argument holds against a standby snapshot.

### What it costs

One narrow row per public tick change, plus the twin and alias fan-out
(bounded by the twins of one ascent and the ticks of one merged climb). The
feed query is an index range scan on `(user_id, txid, seq)` plus one batched
tick lookup per page. Ninety days of rows for every write is a small fraction
of `boardsesh_ticks` itself.

Measured on PostgreSQL 18.6 against a synthetic table of 3M ticks with all 15
production indexes and 1M rows already in the log, on a heavily loaded machine
(load average about 60, so treat the wall-clock numbers as upper bounds):

| Write | Trigger time per row (EXPLAIN `Trigger` line) |
| --- | --- |
| Native tick insert | p50 113 µs, p95 590 µs |
| Aurora-pull insert (adds the twin lookup) | p50 151 µs, p95 561 µs |
| Public-column update | p50 153 µs, p95 688 µs |
| Bookkeeping-only update (Kilter redelivery) | No function call; the `WHEN` clause rejects it |

The trigger's first call in a new connection cost 2.3 ms for plan compilation
and is not repeated. Backend CPU per row rose about 20 µs on a native insert
(313 µs to 332 µs on the same run), within the noise of a shared machine. A 5,000-tick
catalog merge wrote its fan-out in 32 ms at commit.

A change row takes about 275 bytes including its indexes with 36-character ids
(heap 134, `(user_id, txid, seq)` 117, primary key 24). A native tick that later
joins an inferred session writes two rows, so 90 days at 11,000 ticks a day is
270 to 545 MB, against 574 MB for a 658,000-tick `boardsesh_ticks` with its
indexes. Each write adds about 0.2 to 1.0 KB of WAL on top of the 15 to 21 KB a
tick write already produces, at most about 22 MB a day.

Account deletion removes the climber's rows in its own transaction, after the
cascade into `boardsesh_ticks` has written them.

The bootstrap snapshot, measured the same way (PostgreSQL 18.6 in a 4 GB
container with 1 GB of shared buffers, the 15 production indexes), through the
real service code with `auto_explain` on every chunk statement. The worst case:
99,500 ticks, all Aurora-pull and scattered across a 1.5M-tick heap, with 300,000
rows in `board_climb_aliases` so every tick has an alias to fetch:

| Step | Cost |
| --- | --- |
| Start (`H` and the row) | 9.5 ms, one transaction |
| Build | 498 chunks, one short transaction each, every one a Nested Loop Anti Join. p50 9 ms, p95 12 ms on local disk. Total about 5 s |
| Buffers per chunk | About 1,800 warm, at any position. Before the join plan was forced, a middle chunk of an all-Aurora logbook touched 50,350 |
| Cold pages, every chunk evicted first | Worst 562, typical 545, 270,477 for the build. With an empty alias table the worst is 219. Before the fix one chunk read 26,766 |
| Cold pages, evicted once before the build | About 36,300 for the build: 551 for the first chunk, then falling as the build warms its own pages |
| Ticks sharing one instant | 10,000 JSON imports: 180 ms a chunk. 5,000 and 10,000 Aurora rows: 1 to 2 s in all. Ordered by `climbed_at`, 5,000 never finished |
| Storage | 9.6 MB including TOAST, 96 bytes a tick; a 250,000-tick snapshot at the cap is about 24 MB |
| WAL | 9.8 MB for the build, 98 bytes a tick |
| Download | 501 pages, p50 2.8 ms, 1.5 s total |
| Reclaim | 11 ms for the whole snapshot, 290 kB of WAL |

The cost that matters on the 4 GB primary is the page reads. Using the 30 ms
figure for one cold page (#5994, measured during a Railway storage incident, so
probably high), the worst chunk is 16.9 s, so a fully cold chunk times out three
times and succeeds on the fourth call. Twenty timeouts in a row is 100 s of reads,
about 3,300 cold pages against a worst chunk of 562, so a legitimately cold build
does not reach the limit unless the disk is slower than 180 ms a page, and then a
build should stop anyway. A 100,000-tick build from a cold start is about 18
minutes, or 2 h 15 min if every chunk were read fully cold. The 250,000-tick cap
is about 45 minutes from a cold start and fits the 3-hour deadline; if every one
of its chunks were read fully cold it would need 5.6 h, and that build expires and
is retried. Two slots mean at most two connections are ever busy with this. These
are local-disk measurements, so the 30 ms lines are inference, not production
numbers.

The phone's own sync (`syncTicks`, `syncDeletions`) is untouched. It could
move onto the same log later and lose its own long-transaction hole; that is
a separate decision for the offline-sync owners.

---

## Data boundaries and LEGAL.md

Three kinds of data, three answers:

| Kind | Examples | Through the API |
| --- | --- | --- |
| The climber's own activity | Ticks, their grades, stars, comments, workout results | Yes, with their consent, scoped |
| Metadata needed to read it | Climb id, name, community grade, board type and layout | Yes, only attached to a tick the climber logged, including a draft or unlisted climb someone else set |
| Catalogs and community data | Hold positions, full climb lists, setter lists, stats, other climbers' ticks, beta videos | No. Catalogs are already public as nightly snapshots; the API is not a second, authenticated way to scrape them |

What LEGAL.md implies:

- **Ticks are the climber's data and the climber directs where it goes.** No
  manufacturer licence covers a climber's own logbook. Ticks imported from an
  Aurora or Kilter account are included: they are the climber's record of
  their own climbing, the same data the existing user-data export
  ([user-data-exports.md](./user-data-exports.md)) already hands them.
- **Climb names and grades are factual data** under LEGAL.md's own position,
  and for catalog boards already public through `/api/v1` and the snapshots.
  Attaching them to a tick adds no exposure.
- **A logged climb is part of the logbook, whoever set it.** A tick on a draft
  or an unlisted climb someone else set carries that climb's id, name, layout
  and grade like any other: the climber logged it, and the logbook is theirs to
  share with the apps they connect.
- **Spray walls are the exception.** Their climbs are `is_listed = false` and
  kept out of the snapshots ([spray-walls.md](./spray-walls.md)), and a wall
  can be private or link-only. A tick on a spray wall the climber owns carries
  the climb name and wall name as usual. A tick on someone else's wall that is
  not public carries `climb.name: null` and `climb.board.layout: "Spray wall"`:
  the owner shared the wall with the climber, not with the climber's apps. The
  tick itself (date, status, attempts, angle, grade) is still the climber's.
- **The "Hosted Service & API Access" section of LEGAL.md.** It said a
  "publicly distributed app … that uses Boardsesh accounts, data or servers as
  its service needs our written permission, and we do not currently grant it".
  Read literally, that covers DivePeaks. The intent (the Boardz decision,
  October 2026) is about apps that run *on* Boardsesh: forks and alternative
  clients. Proposed wording, waiting for the owner: name those (accounts,
  climbing, board control or sessions on Boardsesh's servers) and say that
  connecting a climber's account through the OAuth API, within the published
  scopes and under the developer terms, is an integration that needs no further
  permission. The www `/legal` page carries the same paragraph in every locale
  (`legal.hostedService.p3`). The scope list enforces that line technically:
  nothing on it lets an app control a board, run a session or browse the
  catalog. **Neither LEGAL.md nor `/legal` changes until the owner approves the
  text**; the proposal for both is in the description of #7411.
- **Developer terms** at www `/developers/terms`, behind the same
  `developer-console` flag as the console, English in every locale. They cover:
  use data only for what the climber connected the app for; no sale, rental,
  advertising or data brokering; the climb details a tick carries, including
  someone else's draft or unlisted climb, are for the climber's own logbook and
  are never re-published or collected into a list; delete on disconnect or
  request; a privacy policy; secrets kept safe and leaks reported within 72
  hours; rate limits and scopes respected; no catalog copying; compatibility
  wording, not endorsement ("Works with Boardsesh"), and board brands only to
  name boards; and Boardsesh may suspend or delete an app that breaks them.
  Registration requires the current version (below), and **refuses every app
  while that version is a draft**: the shipped `PARTNER_DEVELOPER_TERMS_VERSION`
  ends in `-draft` until the owner approves the text, the page shows "Draft, not
  in force", and the console's register form answers "Developer terms are not
  published yet".
- **Privacy policy**: an "Apps you connect" section on www `/privacy`, shown
  only while the web's `PARTNER_OAUTH_MODE` is not `off`, in every locale. It
  says what an app can receive (display name and photo; every tick, "Only me"
  ones included; each tick's climb with name, grade, board and layout, also when
  someone else set it and it is a draft or unlisted; but on someone else's
  non-public Spraywall neither the climb's name nor the Spraywall's), that the
  app's own policy governs the data afterwards, how to disconnect, that any
  password change (a reset, or setting one for the first time) disconnects
  every app, and that disconnecting or deleting the account does not delete
  copies an app already holds. **Draft until the owner approves it**; it shows
  only once partner apps are on, which itself waits for that approval (gate 9).
- **Trademarks**: the docs say "Kilter", "Tension", "MoonBoard" only to name
  board types, never to suggest the API is an official channel for them.

---

## Operations

### Limits

| Limit | Default | Key |
| --- | --- | --- |
| `/api/auth/oauth2/authorize` | 60 requests/min per client IP | `oauth-authorize:<ip>`; protects the authorization flow before any identity is established. A Cloudflare Worker counts per `CF-Worker` zone, with every zone together held to 10 times each per-address limit (see "Routes and the mode switch") |
| Token endpoint, refresh | 10 requests/min per connection | `oauth-refresh:<clientId>:<connectionId>` once validated, plus an IP bound before validation; prove supported middleware/body handling in D2 |
| Token endpoint, code exchange and revoke | 60 requests/min per (app, client IP) | `oauth-client:<clientId>:<ip>`, IP from `getPublicClientIp` |
| Token endpoint, whole app | 6,000 requests/min | `oauth-client:<clientId>` |
| API, per connection | 120 requests/min per (app, climber) | `<clientId>:<userId>` under `api-connection`, charged once the token has passed |
| API, per app | 6,000 requests/min across all its climbers | `<clientId>` under `api-app`, charged once the token has passed |
| API, failed token lookups | 600/min per client IP | `<ip>` under `api-invalid-token-ip`; charged, and refused with 429, only after a lookup fails, never before one |
| API, in flight | 8 places in the shared `/v1` lane and 8 in overflow per address, per instance | IPv4 address, IPv6 /48 or Worker zone, counted in the admission gate; the 9th waits in the overflow lane. All Worker zones together: 12 shared, 8 overflow. A full queue takes a place from the address holding the most |
| Page size | 200 | |
| Snapshot creation | 2 per minute per connection, one active build | Only a real creation counts: a retry joins the snapshot that already exists. Incomplete snapshots never become a partial full download |
| Connections per app | 25 live and 20 new in any 24 hours (`oauth_app_policy`) | Postgres count, not Redis, so it cannot fail open. Charged at the first code exchange |
| Request body | 64 KB | |

`429` carries `Retry-After` (seconds) and `RateLimit-Limit`,
`RateLimit-Remaining`, `RateLimit-Reset` on every response so a well-written
client never sees a 429. Limits use `checkRateLimitRedis`, which falls back to
per-instance memory when Redis is down: still a limit, just a looser one.
Higher per-app limits are stored on the application-owned app policy. The owner
raises them there; there is no request form in the console.

The token limits are keyed per connection and per IP, not only per app,
because a public app's `client_id` is public: anyone could otherwise drain one
app's bucket and lock its climbers out. With hourly access tokens, 6,000
token requests a minute covers 360,000 active connections.

Polling guidance in the docs: sync when the climber opens your app, and in
the background no more than every 15 minutes per climber. 10,000 connected
climbers polled every 15 minutes is about 11 requests/second (670/min),
almost all of them empty pages on an index-only scan. The per-app API ceiling
of 6,000/min fits 90,000 climbers at that rate; an app past that asks for a
higher tier, which by then is a conversation worth having.

### Database load

Every logbook read is scoped by `user_id` on an index that leads with it; there is
no query in the API whose cost grows with the size of the catalog or the
number of climbers. Bootstrap also makes a temporary complete snapshot: 10,000
ticks is 50 pages and 50 short build transactions. The bounds and the cost of a
100,000-tick account are in [What it costs](#what-it-costs). Snapshot work runs on
its own pool of two connections per process and feed pages on the partner pool;
the arithmetic is in [db-connectivity.md](./db-connectivity.md#dedicated-pools-1).
Per-page climb lookups are batched: one read for the climbs and two for their
grades at the page's angles, never one per tick. Measure p95 per route
before milestone 2 opens registration, against the read replica numbers in
[postgres-query-costs.md](./postgres-query-costs.md).

### Observability

- Every `/v1` and `/api/auth/oauth2` log line carries `clientId` and `requestId`. The
  self-asserted `x-boardsesh-client` header is ignored here; the token says
  who is calling.
- A per-minute per-app summary, the same shape as `Client Usage Summary` in
  `services/client-usage.ts`: request count, 4xx/5xx/429 counts, p95.
  PostHog event `Public API Usage Summary`, no climber ids (backend PostHog
  events carry no personal data; [analytics-consent.md](./analytics-consent.md)).
- Alert on an app whose error or 429 ratio is far above the others, and on
  the new-connection cap being hit (possible phishing).
- Alert when the oldest running write transaction is more than 5 minutes old
  (`pg_stat_activity` where `backend_xid` is set): it holds the change-log
  horizon back for every app ([Incremental sync](#incremental-sync)). Track the
  horizon's lag behind the newest change row as a metric.

### The edge

- `AUTOMATION_DEFAULT_DENY_EXEMPT_PATH_PREFIXES` in `crawler-policy.ts`
  exempts `/v1/` and the backend's `/api/auth/oauth2/` (authorize is a GET a
  CLI may open); issuer metadata sits under the existing `/.well-known/`. The
  Cloudflare rule reads the same constants. Its host list is `www` and `ws`, so
  it needs `api.boardsesh.com` only if that host ever joins the default-deny.
- Milestone 0 exempts `/developers/`, `/auth/login` and `/oauth/` on `www`,
  and milestone 2 adds `/llms.txt`. Coding agents fetch docs with `curl`,
  `python-requests` and the like, and drive browsers whose UA says
  `HeadlessChrome`; the default-deny blocks both on GET today
  (`AUTOMATION_SIGNATURE_TOKENS`). `claude-user` and `chatgpt-user` are already
  allowed. The default-deny exists for crawl cost; a login page and a consent
  page are not where that cost is.
- AASA claims every path it does not exclude for the iOS app, so on an iPhone
  with Boardsesh installed a link there would open the app on Home.
  `/oauth/*` and `/developers/*` are in `WEB_ONLY_PATH_PREFIXES`. `/developers/*`
  needs its slash and misses the milestone 2 overview page, so the bare
  `/developers` is in `WEB_ONLY_EXACT_PATHS`, and in the default-deny's exact
  exemptions too. `/auth/error` is also in `WEB_ONLY_EXACT_PATHS`, because
  NextAuth sends a failed social sign-in there and the app has no such screen.
  `/auth/login` stays claimed for the verify-email redirect.

---

## Running partner OAuth

The owner's runbook. Every step here that changes production is the owner's:
agents can prepare commands and read production, not change it. Partner OAuth
stays `off` until step 1 of stage A.

### Before the first switch-on

| # | Step | How to check |
| --- | --- | --- |
| 1 | Every fast-path PR merged and deployed (F1 to F18, L1 to L4). A migration that locks an `oauth_` table deploys alone: a deploy holds its locks until the whole migration run commits, and password resets wait behind them | `vp run db:verify-journal` against production reports no missing migration |
| 2 | `api.boardsesh.com` answers through Cloudflare | `curl -sS -o /dev/null -w '%{http_code}' https://api.boardsesh.com/health` prints `200` |
| 3 | AASA has excluded `/oauth` and `/developers` for at least 7 days, so installed iPhones have refreshed it | `curl -sS https://www.boardsesh.com/.well-known/apple-app-site-association` lists `NOT /oauth/*` and `NOT /developers/*` |
| 4 | The connection budget is decided and deployed ([below](#the-connection-budget)) | |
| 5 | The backend and web deploys send `idle_in_transaction_session_timeout` (code since #7415, nothing to set), and the oldest-write-transaction alert exists ([below](#idle-transactions)) | The query in [Idle transactions](#idle-transactions) |
| 6 | Backend variables: `PARTNER_OAUTH_SECRETS` (`1:` and at least 32 random characters; to rotate, put the new key first, `2:…,1:…`: the first encrypts and the others only decrypt) and `PARTNER_OAUTH_DEVELOPER_ALLOWLIST` (comma-separated user ids) | Railway backend service variables |
| 7 | The PostHog flag `developer-console` exists, targeted at the allowlisted developers | |
| 8 | An independent agent security review of the assembled stack, findings fixed and re-reviewed | |
| 9 | The owner has approved the `LEGAL.md` sentence (then landed with `/legal`), the developer terms and the privacy paragraph, and changed the `PARTNER_DEVELOPER_TERMS_VERSION` constant to the approval date, which opens registration once deployed | The terms page no longer says "Draft, not in force"; the console registers an app |

### Turning it on and off

Set `PARTNER_OAUTH_MODE` on the **web and the backend** services every time it
changes:

- **Turning on** (`off` to `allowlist`): the web first, then the backend.
- **Turning off** (to `off`): the backend first, then the web.

While the web reads `off` it neither guards OAuth account links nor marks new
sign-ins `link_guarded`, and consent requires that mark. So a mismatch fails
closed: the www sign-in and consent pages show "isn't available" to every climber,
and a sign-in made in that window cannot approve an app later either; that
climber has to sign in once more after the web is on.
`infra/railway/config.ts` refuses a web value other than `off`, `hold`,
`allowlist` or `open`, but it cannot compare the web's value with the backend's.

| To stop | Do | What apps see |
| --- | --- | --- |
| Everything, for a while | Backend `hold`. The web can stay as it is: it reads `hold` as on and keeps guarding links | `503` with `Retry-After: 60` on every OAuth and `/v1` route and every console operation. Apps retry; nobody is disconnected. `DELETE /v1/connection` answers `503` too; Connected apps (#7406) keeps Disconnect working in every mode |
| Everything, until further notice | Backend `off`, then web `off` | `404` everywhere, and Better Auth is not loaded. Refresh tokens are kept, so turning it back on brings connections back |
| One app | `suspend` ([admin commands](#admin-commands)) | `invalid_client` from the token endpoint, `401` from the API. `unsuspend` brings it back with its tokens |
| One climber's connections | `revoke-user` | Every connection of that climber ends, as after a password reset |
| Password resets failing because of the revocation trigger | Mode `off` on both, then `ALTER TABLE user_credentials DISABLE TRIGGER trg_user_credentials_partner_revoke_insert;` and the same for `trg_user_credentials_partner_revoke_update` | Nothing: partner OAuth is off. Before turning it back on, enable both triggers and run `revoke-user` for every climber who reset or set a password meanwhile, or their old connections come back |

### The switch-on day

Every climber's www cookie is missing `link_guarded`, and most are missing
`auth_time`: NextAuth re-issues a cookie on every use but writes those claims only
at sign-in. So once the web leaves `off`, every climber is asked to sign in once
before they can approve an app, or link a Google, Apple or Facebook account into
their session. Signing in once clears both. This is expected, not a bug.

Two smaller cases look the same to a climber. A sign-in within 60 seconds of a
password write does not count yet, so after a reset, or for an account created
inside the consent flow, the sign-in page can come back for up to a minute. And
a sign-in older than 30 days never counts.

### Stages

| Stage | Mode | Who connects | Caps per app | Starts when | Lasts |
| --- | --- | --- | --- | --- | --- |
| A | `allowlist` | The owner's test app, test accounts only | 25 live, 20 new in 24 hours | Everything in "Before the first switch-on" is done | 3 days |
| B | `allowlist` | Sequence and DivePeaks developers, their own accounts only | 25 live, 20 new in 24 hours | Stage A clean | 7 days |
| C | `allowlist` | Real climbers | 25 live, 20 new in 24 hours | Stage B clean | Until stage D |
| D | `open` | Any developer with a verified email | The stage D default, still open (200 new a day was the proposal) | BA-02 ships or registration proves the email itself; milestone 2 docs; a second independent agent review; emailing climbers when an app connects (decision 8) | |

Until stage D's email proof exists, `open` registers only the allowlisted
developers ([What the backend does today](#what-the-backend-does-today-f12)).

**Stage A.**

1. Web `allowlist`, then backend `allowlist`, with the owner's test account in
   `PARTNER_OAUTH_DEVELOPER_ALLOWLIST`.
2. Check the client address the backend sees. Production flag requests that
   resolve to real countries, not `XX`, mean Railway's ingress peer is in a
   private range. If they resolve to `XX`, every client shares one rate-limit
   bucket and one client can lock out every partner: stop and fix that first.
3. Register a test app in the console. Connect it from iOS Safari and Android
   Chrome, signed in and signed out, with an Apple, a Google and a password
   account (gate 5).
4. Rehearse `hold` and `off` in the order above, and check that `/graphql` and
   native sign-in keep working in both (gate 8).
5. Take a log sample from the backend, Sentry and PostHog: no codes, tokens or
   secrets (gate 7). Record the bearer check's p95 and the database load (gate 6).
6. Set up alerts on per-app error and `429` ratios, cap hits and lock timeouts
   (gate 7).

**Stage B.** It relies on the Cloudflare Worker egress limits (#7403) and the
`/v1` concurrency routing (#7404), both in the fast-path stack: every
Worker-hosted partner reaches us from one `CF-Connecting-IP`, and without them
they would share one bucket. Many separate /48s can still fill the shared `/v1`
lane; that needs a Cloudflare rule, which is the owner's. Then add
the two developers' ids to `PARTNER_OAUTH_DEVELOPER_ALLOWLIST` and to the
`developer-console` flag, send them [partner-api.md](./partner-api.md), ask them
to connect only their own accounts, and turn every question into a doc fix.

**Stage C.** The caps stay at 25 live and 20 new a day. Emailing climbers when
an app connects (decision 8) is deferred on the strength of those caps, so
raising an app's caps is a stage D step, or an owner decision that brings
decision 8 forward with it. When that time comes, in the app's policy row (the
numbers here are an example):

```sql
UPDATE oauth_app_policy
SET max_active_connections = 500, max_new_connections_per_day = 100
WHERE client_id = '<the app''s client id>';
```

Caps count from the first code exchange, not the approval. A public app can
still be filled by someone with many accounts, since anyone can run its flow to
their own loopback redirect: `revoke-user` the accounts.

### The connection budget

With partner OAuth on, the partner pool (3 per replica) and the logbook snapshot
pool (2 per replica) add 10 connections at steady state and 20 while an old
backend fleet drains. At code defaults a drain then needs about 107
connections, against 97 application slots, and an admission connection refused
with `53300` is not retried. Pick one before leaving `off`
([db-connectivity.md](./db-connectivity.md#dedicated-pools-1) has the arithmetic):

| Option | Drain | Cost |
| --- | --- | --- |
| Cap the web at 4 and the sync daemons at 3: `DB_POOL_MAX=4` on `boardsesh-web`, `DB_POOL_MAX=3` in the sync host's `sync.env` | 95 | Two variables, no code. The daemons are disabled in production today, so until the routine cutover is rolled back their cap is headroom the table already counts |
| Raise `max_connections` | 107, under the new limit | A Postgres restart |
| `LOGBOOK_SNAPSHOT_POOL_MAX` to 1, with the web cap | 97 | No headroom at all; a cold snapshot build makes that replica's page reads wait |
| `PARTNER_POOL_MAX` to 2 | 4 fewer than without it | Authorize, `/v1` and token requests share two connections |

Both pool sizes are code constants, so the last two options are a deploy, not a
variable. The recommendation is the first option, or raising `max_connections`.

### Idle transactions

The logbook feed serves only changes below the oldest write transaction still
open, so one session left idle inside a transaction holds every app's feed back
until it ends. The backend server and the web server end such a session in code:
their pools send `idle_in_transaction_session_timeout` as a startup parameter,
60 s on the shared pools and 10 s on the partner and snapshot pools
([db-connectivity.md](./db-connectivity.md), "Idle transactions end after 60 s on
request pools", has which pools, why 60 s, and what a cut request sees). There is
no `ALTER ROLE` to run for `boardsesh_runtime`.

1. After the first deploy that carries it, see what sits idle in a transaction,
   a few times over a day:

   ```sql
   SELECT usename, application_name, count(*), max(now() - state_change) AS longest
   FROM pg_stat_activity
   WHERE state = 'idle in transaction'
   GROUP BY usename, application_name;
   ```

   A backend or web session never stays past a minute. Anything longer comes
   from a worker, a sync daemon or a script, which are not covered.
2. Make sure no login carries a role-level value. The worker logins must never
   inherit one: the board-snapshot export holds one REPEATABLE READ transaction
   for a whole export, and a role-level value would cut it. And `0` on the
   backend or web sends no parameter, so it would not override one either:

   ```sql
   SELECT rolname, rolconfig
   FROM pg_roles
   WHERE rolconfig::text LIKE '%idle_in_transaction%';
   ```

   No rows is the expected answer. For each row, as the database admin (the
   migration role cannot alter application roles):

   ```sql
   ALTER ROLE <rolname> RESET idle_in_transaction_session_timeout;
   ```

   A setting made for one database only shows up in `pg_db_role_setting`,
   not `pg_roles.rolconfig`. Check it too:
   `SELECT setrole::regrole, setdatabase, setconfig FROM pg_db_role_setting WHERE setconfig::text LIKE '%idle_in_transaction%';`.
   Clear each row it returns:

   - a row naming a role: `ALTER ROLE <role> IN DATABASE railway RESET idle_in_transaction_session_timeout;`
   - a database-wide row (`setrole` shows `-`, that is `setrole = 0`), which every
     login inherits: `ALTER DATABASE railway RESET idle_in_transaction_session_timeout;`
3. Alert when the oldest running write transaction is over 5 minutes old
   ([Observability](#observability)).

To change the value, set `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` on `boardsesh-backend`
or `boardsesh-web`: whole milliseconds from 1000 to 2147483647. Any other value
stops the service at boot. `0` turns off the 60 s default only. The partner
and snapshot pools keep their 10 s, and a role-level value from step 2 would
apply again.

### Admin commands

`packages/backend/src/scripts/partner-app-admin.ts`, run with a `DATABASE_URL` for
the `boardsesh_runtime` login. Each command acts on one id, prints the rows before
and after, and writes nothing without `--apply`.

```
vp exec tsx packages/backend/src/scripts/partner-app-admin.ts suspend --client-id <id> --reason "<shown to the developer>"
vp exec tsx packages/backend/src/scripts/partner-app-admin.ts unsuspend --client-id <id>
vp exec tsx packages/backend/src/scripts/partner-app-admin.ts revoke-user --user-id <id>
vp exec tsx packages/backend/src/scripts/partner-app-admin.ts set-publisher --client-id <id> --publisher "<shown to climbers>"
```

Add `--apply` once the dry run shows the right rows. `suspend` keeps the app's
tokens, and other backend instances stop answering its browser origins within 60
seconds. `revoke-user` runs `partner_revoke_user()`, the function the password
trigger calls, in READ COMMITTED. Details are in
[What the backend does today](#what-the-backend-does-today-f12).

### Where each launch gate is tested

| Gate | What | Where |
| --- | --- | --- |
| 1 | Every credential path ends connections | `auth/partner/__tests__/partner-revocation.test.ts` (one test per row of the revocation table); the launch suite's "the revocation table" and "races" |
| 2 | The pinned provider, two instances, real Postgres and Redis, end to end | `__tests__/partner-launch-suite.test.ts` (the backend); `vp run test:e2e:partner-oauth` ([End-to-end journey](#end-to-end-journey): www and the backend in Chromium) |
| 3 | Independent security review | Agents that did not write the code, before stage A and again before stage D. Not a test |
| 4 | AASA live for 7 days; `api.boardsesh.com/health` through Cloudflare | `app/lib/__tests__/apple-app-site-association.test.ts` for the file; the 7 days and the `curl` are manual |
| 5 | Consent in iOS Safari and Android Chrome, signed in and out, Apple, Google and password accounts | Manual, stage A step 3 |
| 6 | Idle timeout set; bearer p95 and database load recorded | The owner, before the first switch-on; measured in stage A |
| 7 | Alerts exist; no codes, tokens or secrets in logs | The launch suite's "the logs" for backend logs; alerts and the Sentry and PostHog sample are manual |
| 8 | `hold` and `off` rehearsed; `/graphql` and native sign-in unaffected | The launch suite's "mode off", "mode hold" and "switching modes"; the rehearsal is stage A step 4 |
| 9 | `LEGAL.md` sentence, developer terms and privacy paragraph approved | The owner |
| 10 | Published scopes match shipped routes | The launch suite's "discovery" and "codes"; `check:public-api-openapi` in CI |

---

## Webhooks (later)

Milestone 4, and only once an app asks. Shape, so nothing earlier has to
change for it:

- Per-app settings: one HTTPS URL, a list of events, a signing secret shown
  once, a test-delivery button. Stored on a new `oauth_client_webhooks` table,
  secret encrypted with a versioned key.
- Thin bodies. `logbook.changed` says "this climber's logbook changed, run
  your sync". It is produced by a job that walks `logbook_changes` below the
  horizon, so it never fires for a change the feed cannot serve yet; `workout.completed` names a workout id; `connection.revoked`
  says a climber disconnected (the one event sent after the connection is gone; it
  carries only the per-app user id). Because that id survives reconnect, a
  delayed revocation is advisory: the recipient verifies its current credentials
  before removing current state, as specified in the public webhook guide.
  No tick data in any body. The app then reads
  with its token, which is how revocation is enforced and why a leaked
  webhook URL or secret exposes nothing.
  ```json
  { "id": "evt_…", "type": "logbook.changed", "occurredAt": "…", "user": "usr_…" }
  ```
- Coalesced: at most one `logbook.changed` per (app, climber) per minute,
  using a pg-boss `singletonKey`.
- Signature, retry table and `410` handling as specified in partner-api.md
  section 5 (`Boardsesh-Signature: t=…,v1=…`, HMAC-SHA256 over `t.rawBody`,
  about 17 hours of backoff). These carry over from the Sequence plan
  unchanged.
- One pg-boss job per delivery, data = a `webhook_deliveries` ledger row id
  (`id`, `client_id`, `connection_id`, `connection_generation`, `event`,
  `body jsonb`, `status`, `attempts`,
  `last_status_code`, `last_error`, `delivered_at`). The handler re-checks the
  connection generation before sending, so a climber who disconnected between the event and a
  retry gets nothing sent, except `connection.revoked`, which skips that check
  by design. `2xx` completes; `410` completes, switches the
  app's webhook off and cancels its pending jobs; `408`, `429`, `5xx`, timeout
  and connection errors throw so pg-boss retries; any other `4xx` completes
  as failed (the app will reject the same bytes again). Job options:
  `singletonKey` = ledger id, `retryLimit: 9`, `retryDelay: 120`,
  `retryBackoff: true`, `retryDelayMax: 32000`, `expireInSeconds: 30`. The
  explicit `retryDelayMax` matters: `DEFAULT_JOB_OPTIONS` in `job-queue.ts`
  caps every backoff at 120 seconds, which would turn 17 hours of retries into
  about 18 minutes. The transient-error list is
  shared with `web-revalidate.ts` and the Strava export job.
- **SSRF.** The URL is typed in by anyone. The sender resolves DNS itself,
  refuses private, loopback, link-local, CGNAT and cloud metadata ranges,
  connects to the address it checked, follows no redirects, and only speaks
  HTTPS. Delivery runs on the Railway backend, never on the homelab workers
  ([homelab-deploys.md](./homelab-deploys.md)), where a bypass would reach
  the home network.
- Ordering is not guaranteed. Every event means "go read", including
  `connection.revoked`: a delayed old event cannot authorize deleting a new
  connection's tokens/data. The recipient probes current auth, refreshes once,
  and coordinates any deletion with reconnect/token replacement. Test delivery
  of an old revocation after reconnect and after a concurrent token replacement.
- An app whose deliveries fail for three days is switched off and emailed;
  the console has a re-enable button.

---

## Developer experience

Built in milestone 2, all from the same `openapi.json`:

| Piece | Where | Notes |
| --- | --- | --- |
| Overview and quickstart | `www.boardsesh.com/developers` | Indexable. Register → authorize → token → first sync, in one page with `curl` |
| Guides | `/developers/auth`, `/developers/sync`, `/developers/errors`, `/developers/changelog` | The sync guide carries the full loop, cursor storage, the guarantees and the 410 recovery |
| API reference | `/developers/reference` | Swagger UI, which `/docs` already ships |
| Machine-readable contract | `https://api.boardsesh.com/v1/openapi.json` | Also downloadable from the reference page |
| `llms.txt` | `www.boardsesh.com/llms.txt` | Index of the guides as plain markdown (`/developers/*.md`), plus the OpenAPI URL. Written for a coding agent that has never seen Boardsesh |
| Example | One file, `examples/logbook-sync.ts`, in the docs and the repo | A loopback-redirect CLI: authorize, store tokens, sync to a JSON file, handle 401/410/429. No SDK: the OpenAPI document plus any generator is the SDK |
| Offline mock | Documented: `npx @stoplight/prism-cli mock https://api.boardsesh.com/v1/openapi.json` | Works because every schema carries an example. No sandbox environment to run |
| Test data | Your own account | A developer logs a few ticks in the app. The acceptance test uses a prepared account |

Not built: SDKs, a separate sandbox deployment, a developer forum, an agent
"skill" beyond `llms.txt`. Add one when a real integration shows the docs are
not enough.

---

## Roadmap

The partner platform ships first, on the fast path (decided 2026-11-09). It
needs neither the email-uniqueness work (BA-02) nor any step of the
identity-authority migration (BA-04):

- Better Auth runs only as the OAuth server. It reads a climber by id from
  `users`, never writes that table, and has email and social sign-in off, so
  email case and uniqueness never reach it.
- Consent identity is the www NextAuth cookie, checked on every request
  (decision 19), with no new browser cookie.
- Revocation lives in the database. A trigger on `user_credentials` calls
  `partner_revoke_user()` on every password write, and foreign-key cascades
  cover account deletion, so no first-party writer has to remember to call it.
- Open registration (stage D) stays closed until BA-02 ships or registration
  sends its own email proof, because `emailVerified` was stamped without proof
  while verification was off.

The first-party migration keeps its own flags and gates; neither gate is waived
by the other succeeding. Two of its steps touch partner code later: BA-05's
first cohort swaps the consent session reader to `readFirstPartySession`,
accepting both cookie formats before any cohort moves, and moves
`/oauth/sign-in` to the new login; BA-10, when it retires `user_credentials`,
moves the revocation trigger to Better Auth's credential row in one migration.
The migration roadmap lives in [better-auth-migration.md](./better-auth-migration.md).

Each partner milestone is useful on its own. PRs inside a milestone are
small enough to review in one sitting, and every PR touching the
authorization server gets a Fable review.

### Milestone 0: prerequisites (no feature visible)

| PR | Acceptance |
| --- | --- |
| Better Auth/provider compatibility proof (D2) | Record results for the pinned version and all five gates. A failed gate blocks its deliverable and requires an explicit design revision; no automatic provider fallback |
| AASA: add `/oauth` and `/developers` to `WEB_ONLY_PATH_PREFIXES` | `/.well-known/apple-app-site-association` lists `NOT /oauth/*` and `NOT /developers/*`. Ships at least a week before milestone 1's consent page so installed phones refresh the file |
| Constrain `callbackUrl` on `/auth/login` with `safe-callback-url.ts` | A test proves `?callbackUrl=https://evil.example` lands on `/` |
| `api.boardsesh.com` CNAME in `infra/cloudflare`, custom domain on the backend service | `curl https://api.boardsesh.com/health` answers |
| Default-deny exemptions: `/v1/`, backend `/api/auth/oauth2/` and issuer metadata; `www` `/oauth/`, `/developers/`, `/auth/login` | Unit test in `crawler-policy`; a `HeadlessChrome` GET of consent and discovery is not refused |
| `idle_in_transaction_session_timeout` on the request pools | Sent as a startup parameter by the backend and web servers' pools (60 s; partner pool 10 s) and documented in `docs/db-connectivity.md` |

### Milestone 1: connect and sync (the MVP)

The first vertical slice: a developer registers an app, a climber connects
it, the app syncs the logbook, the climber disconnects it.

| # | PR | Depends on |
| --- | --- | --- |
| 1.1 | `@boardsesh/public-api`: zod schemas, OpenAPI registry, committed `openapi.json`, CI diff check | — |
| 1.2 | Complete snapshot bootstrap, `logbook_changes`, feed generation, watermark, triggers, atomic pruning and concurrency/recovery tests | — |
| 1.3 | Generated provider Drizzle schema, app/connection policy, opaque introspection, `/v1` router and rate limits | D2 OAuth gate on the pinned version, with Better Auth reading `users` read-only (fast path F6, F7, F9, F10). No identity-migration step |
| 1.4 | Supported Better Auth consent/continuation UI, connection-generation enforcement, security-revocation integration | 1.3; the `user_credentials` revocation trigger live, with one test per credential path (F8), and the www session bridge (F13). Not the migration's security gate |
| 1.5 | `GET /v1/me`, `GET /v1/logbook/changes`, `GET /v1/logbook/ticks/{id}` | 1.1, 1.2, 1.3 |
| 1.6 | Developer console (create, list, edit redirect URIs, rotate secret, delete) behind the web server flag `developer-console` | 1.3 |
| 1.7 | Connected apps on mobile/web and `DELETE /v1/connection`; atomic disconnect, consent removal and reconnect tests | 1.3, 1.4 |
| 1.8 | The authorization-server test suite ([Authorization server](#test-suite-required-before-launch)) | 1.3, 1.4 |
| 1.9 | LEGAL.md sentence (wording in "Data boundaries"), before the beta apps go live | Marco's approval |

Acceptance for the milestone:

1. A backend end-to-end test (Vitest, real Postgres) registers an app, runs
   authorize → token → `changes` across three pages, creates, edits and
   deletes ticks and sees each in the feed, refreshes, replays an old refresh
   token and sees its family invalidated, and gets `401` after Disconnect.
2. The interleaved-transaction test and the randomized concurrent-writer test
   pass: the reader's copy equals the database's public view after every run,
   including twin pairs and alias merges. Bootstrap includes pre-launch and
   unchanged 90-day-old ticks; writes during pagination are caught up. Readers
   interleaved with prune commits either see all rows or receive `410`.
3. The authorization-server suite (1.8) passes.
4. Contract tests validate every response against `openapi.json`.
5. `410 cursor_expired` is returned for a cursor below the pruning watermark,
   for another feed generation, expired snapshots and `c3.expired`; a change
   cursor issued 200 days ago that is still above the watermark works. Test
   a logical restore after new transaction IDs pass the old IDs, and crashes
   during bootstrap and before the client's atomic replacement/cursor commit.
6. Party-session ticks of other climbers never appear (test with two
   climbers in one session).
7. Manual: connect with an Apple-only account, a Google-only account and an
   email/password account, from both iOS and Android browsers.
8. The DivePeaks and Sequence developers, given the flag, connect their own
   accounts using only partner-api.md. Their questions become doc fixes.

### Milestone 2: open self-service

| PR | Acceptance |
| --- | --- |
| Developer docs on `www`, `llms.txt`, example client, Prism recipe | The agent acceptance test below passes |
| Unreviewed-app line, name denylist, daily connection cap, suspend script | Tests for each rule |
| Developer terms, privacy-policy paragraph | Marco approves the wording |
| `/docs` GraphQL tab labelled internal | |
| Usage summary event and alerts | Visible for the beta apps |
| Remove the `developer-console` flag | Anyone with a verified account can register |

### Milestone 3: workouts

The Sequence handoff, built on milestone 1 instead of beside it. Design in
[partner-workouts-internal.md](./partner-workouts-internal.md); contract in
partner-api.md. Results are read with `GET /v1/workouts/{id}`. Acceptance as
listed there.

### Milestone 4: webhooks

Only once an app asks for push. `logbook.changed`, `workout.completed`,
`connection.revoked`, with the SSRF rules above. Acceptance: a delivery to a
`127.0.0.1` or `169.254.169.254` URL is refused at registration and at send
time; a revoked generation gets only `connection.revoked` after revocation.
Deliver that event after reconnect and race it with token replacement: the
client preserves the new credential set and data. Transport failures never
cause deletion.

### Later, each on demand

Verified-domain badge; `logbook:write`; sessions as a resource (needs a
non-invite session id); dynamic client registration and an MCP server for
agent clients (revisit D2 at that point); app-to-app consent when Boardsesh is
installed.

### Why this order

The suggested order (MVP, then self-service, then extras) holds with one
change: the registration page moves into milestone 1. It is one form and a
table the milestone needs anyway, and the alternative (seeding Sequence's and
DivePeaks' clients by hand) is the privileged path D7 rules out. Milestone 2 is
then "open the door and make it findable", not "build the door". Workouts move
behind the logbook because the logbook is the smaller change that tests the
whole OAuth core, and because it already gives Sequence most of what its
users want.

---

## Acceptance test: an agent integrates alone

Run before milestone 2 closes, and again whenever the docs change shape.

**Setup.** A Boardsesh account with an email and password, at least 250 ticks
on two board types, one of them with a comment. A fresh coding agent with a
shell, Node, a browser tool and internet access. Its prompt is only: "Build a
command-line tool that connects a Boardsesh account and keeps a local JSON
copy of its logbook in sync. Start at https://www.boardsesh.com/llms.txt. The
account is `<email>` / `<password>`." No repo access, no maintainer contact.
A harness plays the climber, using the account's ordinary app or web session.

| Step | Agent does | Harness does | Pass when |
| --- | --- | --- | --- |
| 1. Register | Creates an app in the console with a loopback redirect | | `client_id` exists, owned by the account |
| 2. Authorize | Implements PKCE + `state`, requests `logbook:read offline_access`, completes consent | | Connection exists with the requested scopes |
| 3. Connect | Exchanges the code, stores both tokens | | `GET /v1/me` succeeds |
| 4. Retrieve | Full sync | | Local file has exactly the account's ticks, all pages, no duplicates |
| 5. Incremental | Syncs again | Logs 2 ticks, edits 1 | Exactly those 3 changes applied; stored cursor advanced |
| 6a. Deletion | Syncs again | Deletes 1 tick | It is gone locally |
| 6b. Token expiry | Next call | Expires/removes the current opaque access token while keeping its refresh token | Agent sees `401`, refreshes, stores the rotated refresh token, call succeeds; repeat in a browser client |
| 6c. Expired cursor | Next sync | Replaces the stored cursor with `c3.expired`, then interrupts one bootstrap after a page | Agent restarts safely, preserves every live tick including old unchanged history, and removes stale ticks only at atomic completion |
| 7. Disconnect | Calls `DELETE /v1/connection`; then the harness reconnects and disconnects from Connected apps | Taps Disconnect | Old access/refresh credentials stay invalid after reconnect; agent reports "reconnect needed" instead of looping |

Pass overall: all steps pass, the agent asked nobody anything, and it never
read Boardsesh source. Run it with at least two different agent products.
Every place the agent guessed, retried blindly or read the docs twice is a doc
bug: fix it and rerun.

---

## Open questions

- **LEGAL.md wording** (above): Marco to approve before the first outside app
  goes live in milestone 1.
- **"Only me" ticks in `logbook:read`.** This design includes them and says so
  on the consent screen. The alternative is Strava's split (`read` vs
  `read_all`), which first needs privacy changes to reach the feed.
- **The compatibility proof** (D2). Better Auth is selected, but implementation
  is gated on the pinned-version results. Failed criteria require a reviewed
  design revision, not an automatic switch to another provider.
- **Moving the phone's sync onto the change log**, which would close its
  long-transaction hole too. Not needed for the public API.
- **Imported `climbedAt`.** Aurora's naive timestamps are stored as UTC
  (`apply-user-logbook.test.ts`), which may be the climber's local time.
  Document as-is, or fix at import?
- **`source` on a tick** (`boardsesh` vs `imported`): left out; an app
  that also imports from Kilter directly could use it to de-duplicate. Add
  when one asks.
- **Connection caps after stage D**: every app starts at 25 live and 20 new
  connections a day (the `oauth_app_policy` defaults). What the default becomes
  when registration opens, for an app that launches with a big audience, is
  open; 200 new a day was the proposal. It is a column; the question is the
  default.
- **How a developer asks for higher caps.** There is no request form in the
  console; today the owner raises an app's caps in its policy row. Who handles
  such requests once registration opens, and how fast, is open.

## Related docs

- [partner-api.md](./partner-api.md), the developer-facing contract
- [partner-workouts-internal.md](./partner-workouts-internal.md), workouts internals
- [integration-consumers.md](./integration-consumers.md), Sequence and DivePeaks
- [integrations.md](./integrations.md), the other direction: Boardsesh as an OAuth client of Strava
- [offline-sync-plan.md](./offline-sync-plan.md) and [sync-table-manifest.md](./sync-table-manifest.md), the cursor and tombstone machinery the feed reuses
- [ascents-and-attempts.md](./ascents-and-attempts.md), what a tick means
- [mobile-auth-flow.md](./mobile-auth-flow.md), first-party tokens
- [better-auth-migration.md](./better-auth-migration.md), first-party identity,
  session and native/watch compatibility migration
- [background-workers.md](./background-workers.md), pg-boss roles
