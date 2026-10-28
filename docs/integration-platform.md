# Integration platform: how third-party apps connect to Boardsesh

This is the canonical design for every third-party integration. A climbing
app, a training planner, a coach's spreadsheet script or somebody's weekend AI
project all connect the same way: register an app, send the climber through
OAuth, read what the climber allowed, keep it in sync. No app gets a private
endpoint, a hand-made client row or a scope nobody else can ask for.

Status: design, nothing built. Written 2026-10-27, after the Sequence workout
spec (#5530) and the DivePeaks logbook request. The target is that the cost of
one more ordinary integration is zero engineering time on our side.

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
10. [Webhooks (later)](#webhooks-later)
11. [Developer experience](#developer-experience)
12. [Roadmap](#roadmap)
13. [Acceptance test: an agent integrates alone](#acceptance-test-an-agent-integrates-alone)
14. [Open questions](#open-questions)

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
does not leak an internal key.

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
  `callbackUrl` must be constrained first. Both are still open today
  (`WEB_ONLY_PATH_PREFIXES = ['/gym', '/poster']`; `auth-page-content.tsx`
  pushes `callbackUrl` raw at three call sites).
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
  `api.boardsesh.com` (D9). The edge's default-deny exemption is keyed on
  `/v1/partner/` today (`AUTOMATION_DEFAULT_DENY_EXEMPT_PATH_PREFIXES` in
  `packages/web/app/lib/crawler-policy.ts`) and must follow the path.
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
| `POST /api/auth/oauth2/token` on `api` | Better Auth OAuth provider | Authorization-code and refresh grants only; each client uses its registered authentication method |
| `POST /api/auth/oauth2/revoke` on `api` | Better Auth OAuth provider | RFC 7009 token revocation, distinct from disconnect |
| `GET /.well-known/oauth-authorization-server/api/auth` on `api` | Better Auth handler, explicitly forwarded outside its base mount | Canonical RFC 8414 metadata for the pathful issuer; the provider's `/api/auth/.well-known/oauth-authorization-server` alias may also be served, with identical metadata |
| `DELETE /v1/connection` on `api` | Boardsesh public API | Any valid user-delegated API access token can disconnect only its own app/climber connection; no extra scope |

The authorization response carries the issuer in `iss` (RFC 9207). The app
does not claim `api.boardsesh.com`; `/oauth` on `www` is excluded from iOS
association before consent launches. First-party auth paths and their old
native/watch aliases are owned by the migration doc, not this API contract.

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

`authenticateApiBearer` uses the provider's supported opaque-token
introspection/verification integration. It verifies activity, resource
audience, client, user, scopes and the current connection generation, then
checks suspension and revocation without a positive-result cache. The sole
partner API resource identifier is `https://api.boardsesh.com/v1` (no trailing
slash); it is distinct from the issuer. Register that resource and link every
self-service client to it through supported provider APIs. Clients send it as
`resource` at authorization, code exchange and refresh. A missing or different
resource must never produce a usable API token: test request rejection or,
if the provider issues an unbound token, `401 invalid_token` at `/v1/*`.
Registration links alone are not assumed to supply a request default. The
resource server must be authorized to inspect tokens minted for public and
confidential clients; the spike proves that setup rather than using a guessed
internal lookup. It returns `{ clientId, connectionId, connectionGeneration, userId, subject, scopes }`.
Each route checks its required scope. Invalid tokens yield `401` and
`WWW-Authenticate: Bearer error="invalid_token"`; missing scopes yield `403`.

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

### Test suite required before launch

The OAuth launch gate is separate from the first-party migration gate.
Tests run against the pinned provider, real Postgres and two backend instances,
not mocks of library internals.

Protocol coverage includes PKCE S256 for every client, exact redirects and
allowed native loopback behavior, unknown-client errors, code expiry and
single use, client-specific authentication methods, discovery/issuer
consistency, opaque resource-bound tokens (including missing/wrong resource at every grant step),
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
successful single-use guard.

Adversarial coverage includes consent CSRF, forged continuations, clickjacking
(`frame-ancestors 'none'`), unsafe callback URLs, stale migrated sessions,
client A's credential presented as client B, and third-party tokens on
first-party/GraphQL/native/watch endpoints. Test immediate secret rotation,
app suspension/deletion, account deletion, connection cleanup failure, and
correct CORS/headers for expired-token and rate-limit errors. Ordinary
first-party sign-out must not silently revoke an offline connection; explicit
security revocation must.

An external security review of configuration and glue is recommended before
milestone 2 opens registration. Failure of any launch gate blocks that
deliverable; it does not authorize a fallback implementation.

---

## Self-service registration

A developer console at `https://www.boardsesh.com/developers/apps`
(`robots: noindex`), backed by internal GraphQL mutations in
`packages/backend` (`createOAuthClient`, `updateOAuthClient`,
`rotateOAuthClientSecret`, `deleteOAuthClient`, `myOAuthClients`).

Form fields: name, homepage URL, privacy policy URL, client authentication
type, web/native application topology and redirect URIs. Registration binds
the client to the published `https://api.boardsesh.com/v1` resource; developers
cannot expand its resource permissions. The secret (confidential clients) is shown once. No icon upload in the
first version: the consent page shows a lettered avatar, so there is no image
moderation to run.

Rules enforced without a human:

| Rule | Value | Why |
| --- | --- | --- |
| Developer account | Signed in, email verified | Accountability without paperwork |
| Apps per developer | 10 | Bounds a single bad actor |
| Redirect URIs per app | 10 | |
| Redirect URI forms | `https://…` (any host); `http://127.0.0.1:{any port}/…` and `http://[::1]…` (loopback, RFC 8252 §7.3, port ignored when matching); private-use schemes with a dot, `com.example.app:/…` (RFC 8252 §7.1). Rejected: `http://` elsewhere, `javascript:`, `data:`, `file:`, fragments, wildcards, any URI on a `boardsesh.com` host, and the schemes `boardsesh` and `com.boardsesh*` (our own app's) | Loopback lets scripts and local AI-built tools integrate with no hosting |
| Matching | Exact string, except the loopback port | |
| Names | Case-insensitive denylist: Boardsesh, Aurora, every board brand in `BOARD_TYPE_LABELS` (Kilter, Tension, MoonBoard, Decoy, Touchstone, Grasshopper, So iLL, Woods), and lookalikes | Consent phishing |
| New connections per app per day | 200 by default; a developer can ask for more through the console form | Bounds the damage of a phishing app; ordinary apps never hit it |
| Scopes | Any app may request any published scope. The consent page lists them | No approval tier |

The consent screen shows: the app name, "Made by {developer's display name}",
the redirect host, the app's homepage and privacy links, one line per scope,
and "Boardsesh hasn't reviewed this app. Only connect apps you trust." That
line is on every app; a verified-domain badge (the developer proves control of
the homepage domain with a `/.well-known/` file) is a later, automated
addition, not an approval queue.

Admin tools: suspend an app (with a reason the developer sees), list an app's
connection count and error rate. The first version is a backend script under
`packages/backend/scripts/`, like the other ops tools.

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
file.

Milestone 1 routes:

| Route | Scope | Returns |
| --- | --- | --- |
| `GET /v1/me` | any | `{ id }`, plus `displayName`, `avatarUrl` with `profile:read` |
| `DELETE /v1/connection` | any | Disconnect this token's app/climber connection; `204`, or `401` if its credentials are already invalid |
| `GET /v1/logbook/changes?cursor=&limit=` | `logbook:read` | The change feed below |
| `GET /v1/logbook/ticks/{id}` | `logbook:read` | One tick, or `404` if it was deleted or never existed |

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
  "grade": { "v": 4, "font": "6B+", "label": "6B+/V4" },
  "benchmark": false,
  "comment": "Finally stuck the cross-through",
  "climb": {
    "id": "3f9c2a1e5b7d4c8e9a0b1c2d3e4f5a6b",
    "name": "Slopey Business",
    "board": { "type": "kilter", "layout": "Kilter Board Original" },
    "grade": { "v": 4, "font": "6B+", "label": "6B+/V4" },
    "boardseshGrade": 4.2
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
| `climb.boardseshGrade` | `board_climb_grades.universal_grade` | Optional decimal on the V scale, `null` when not anchored |
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
changed within retention. In one bounded `REPEATABLE READ` transaction it
captures the current feed generation and horizon `H`, applies the same
ownership/twin/privacy rules and serializer, and writes the immutable snapshot
tick values plus their starting change position `(H, 0)`. It publishes the snapshot
only after that transaction commits. A failure publishes no partial snapshot.
This is a server-side copy, not an open database transaction held across HTTP
requests. Measure and bound its cost before launch; return a retryable error
on resource exhaustion rather than silently truncating a large logbook.

Snapshot cursors identify that snapshot and its next page. Snapshots are bound
to the authenticated app/climber connection, checked on every page, expire
after one hour, and are reclaimed by a job. Responses use `Cache-Control:
no-store`. Rate-limit new snapshot creation separately from incremental reads;
one sync worker per connection avoids accidental duplicate full downloads.
Authorization and privacy always use current policy at page delivery: check the
connection again, and reapply the serializer's current public-metadata redaction
in that page's read transaction. A wall made private after snapshot creation
must not leak its formerly public names from stored snapshot payloads. Preserve
the snapshot's tick values/identity and recompute or redact its public climb
metadata; fail closed if current authorization cannot be checked.

The final snapshot page returns the ordinary change cursor `(H, 0)` and
`hasMore: true`, even if it contained no ticks. The client must then drain
changes until `hasMore: false` before publishing the replacement copy. All
transactions below `H` had completed in the snapshot; every write that could
commit later has a transaction ID at or above `H` and will be replayed. Some
already visible writes at or above `H` are replayed too; upserts/removals make
that harmless. Twin visibility and alias changes follow the same trigger rules.

Validate the saved change position against the pruning watermark in the same
snapshot as every incremental page. If history necessary for catch-up was
pruned during the download, or the temporary snapshot expired, return `410`
and restart bootstrap; never promote an incomplete copy. A client stages the
whole replacement and atomically swaps it into its local store together with
the final cursor. A crash leaves its old copy intact and a durable full-sync
requirement, so retry starts a fresh snapshot. The public example specifies
these storage operations and does not keep reconciliation markers only in
memory.

### The change log

One table, `logbook_changes`, written only by triggers:

| Column | Type | Notes |
| --- | --- | --- |
| `seq` | `bigserial` primary key | Order within a transaction |
| `txid` | `xid8`, default `pg_current_xact_id()` | The writing transaction. 64-bit, never wraps |
| `user_id` | `text`, no FK | Whose logbook. No FK, like `sync_deletions`: deleting an account cascades into `boardsesh_ticks`, whose delete trigger writes rows for that same user, and those must not depend on cascade ordering. The rows age out in 90 days; nobody can read them, because the connections died with the user |
| `tick_uuid` | `text` | Which tick. No FK: the tick may be gone |
| `created_at` | `timestamp`, default `now()` | For pruning only |

Indexes: `(user_id, txid, seq)` for reads, and a BRIN on `created_at` for the prune job.

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
   what an app should see without touching a serialized field. Only
   `aurora_sync_error`, `kilter_type`, `kilter_synced_at`,
   `kilter_sync_error`, `kilter_detached_at`, `board_id`, `session_id` and
   `climb_revision` are left out, which still keeps no-op Kilter PowerSync
   redeliveries out of the feed. A `user_id` change writes a row for both
   climbers.
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

- A daily pg-boss job chooses a settled retention boundary `(T, S)` below
  the current horizon such that **every row in the contiguous prefix through
  that boundary is older than 90 days**. A younger row stops the prefix even
  if later positions contain older rows; do not select the greatest expired
  row independently of preceding rows. It deletes that prefix in ordered batches. **Each committed batch advances
  `logbook_change_watermark.pruned_through` atomically through precisely the
  prefix it removed.** Serialize pruning jobs on the watermark row. There is
  never a committed deletion hidden behind the old watermark. Deleting
  by position rather than by `created_at` keeps the watermark exact: `now()`
  is a transaction's start time while its `txid` comes at its first write, so
  the two orders disagree slightly, and pruning by time would delete rows past
  positions still retained. A cursor below the watermark answers
  `410 cursor_expired`: a row after it may be gone. A cursor at or above it is
  valid however old it is, because nothing after it was deleted. Validity is
  measured against what was pruned, not against when the cursor was
  issued.
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
  holds every feed back. Set `idle_in_transaction_session_timeout` on the
  application roles, and alert when the oldest running write transaction is
  more than 5 minutes old ([Observability](#observability)).
- Reads run on the primary in milestone 1. Moving them to a hot standby means
  first proving the same horizon argument holds against a standby snapshot.

### What it costs

One narrow row per public tick change, plus the twin and alias fan-out
(bounded by the twins of one ascent and the ticks of one merged climb). The
feed query is an index range scan on `(user_id, txid, seq)` plus one batched
tick lookup per page. Ninety days of rows for every write is a small fraction
of `boardsesh_ticks` itself; measure it in the milestone 1 PR against
[postgres-query-costs.md](./postgres-query-costs.md).

The phone's own sync (`syncTicks`, `syncDeletions`) is untouched. It could
move onto the same log later and lose its own long-transaction hole; that is
a separate decision for the offline-sync owners.

---

## Data boundaries and LEGAL.md

Three kinds of data, three answers:

| Kind | Examples | Through the API |
| --- | --- | --- |
| The climber's own activity | Ticks, their grades, stars, comments, workout results | Yes, with their consent, scoped |
| Metadata needed to read it | Climb id, name, community grade, board type and layout | Yes, only attached to a tick the climber logged |
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
- **Spray walls are the exception.** Their climbs are `is_listed = false` and
  kept out of the snapshots ([spray-walls.md](./spray-walls.md)), and a wall
  can be private or link-only. A tick on a spray wall the climber owns carries
  the climb name and wall name as usual. A tick on someone else's wall that is
  not public carries `climb.name: null` and `climb.board.layout: "Spray wall"`:
  the owner shared the wall with the climber, not with the climber's apps. The
  tick itself (date, status, attempts, angle, grade) is still the climber's.
- **The "Hosted Service & API Access" section needs one clarifying sentence
  before the first outside app ships against milestone 1.** It says a "publicly distributed
  app … that uses Boardsesh accounts, data or servers as its service needs our
  written permission, and we do not currently grant it". Read literally, that
  covers DivePeaks. The intent (the Boardz decision, October 2026) is about
  apps that run *on* Boardsesh: forks and alternative clients. Proposed wording
  for Marco to approve:

  > Connecting a climber's Boardsesh account to your app with their
  > permission, through the OAuth API and the scopes in the developer docs, is
  > an integration and needs no permission from us. Building an app whose
  > accounts, climbing, board control or sessions run on Boardsesh's servers
  > is not an integration, and the paragraph above applies.

  The scope list enforces that line technically: nothing on it lets an app
  control a board, run a session or browse the catalog.
- **Developer terms** (short, linked from the console and LEGAL.md): use data
  only for what the climber connected the app for, delete it when the climber
  disconnects or asks, no resale, no re-publishing other climbers' data (there
  is none in the API anyway), respect rate limits, describe compatibility not
  endorsement ("Works with Boardsesh"), and we can suspend apps that break
  this. Draft in milestone 2, Marco signs off.
- **Privacy policy**: one paragraph on connected apps: what leaves, that the
  app's own policy governs it afterwards, how to disconnect, and that deleting
  a Boardsesh account does not delete copies an app already holds.
- **Trademarks**: the docs say "Kilter", "Tension", "MoonBoard" only to name
  board types, never to suggest the API is an official channel for them.

---

## Operations

### Limits

| Limit | Default | Key |
| --- | --- | --- |
| `/api/auth/oauth2/authorize` | 60 requests/min per client IP | `oauth-authorize:<ip>`; protects the authorization flow before any identity is established |
| Token endpoint, refresh | 10 requests/min per connection | `oauth-refresh:<clientId>:<connectionId>` once validated, plus an IP bound before validation; prove supported middleware/body handling in D2 |
| Token endpoint, code exchange and revoke | 60 requests/min per (app, client IP) | `oauth-client:<clientId>:<ip>`, IP from `getPublicClientIp` |
| Token endpoint, whole app | 6,000 requests/min | `oauth-client:<clientId>` |
| API, per connection | 120 requests/min per (app, climber) | `api:<clientId>:<userId>` |
| API, per app | 6,000 requests/min across all its climbers | `api:<clientId>` |
| Page size | 200 | |
| Snapshot creation | 2 per minute per connection, one active build | A retry restarts safely; incomplete snapshots never become a partial full download |
| New connections | 200/day per app | Postgres count, not Redis, so it cannot fail open |
| Request body | 64 KB | |

`429` carries `Retry-After` (seconds) and `RateLimit-Limit`,
`RateLimit-Remaining`, `RateLimit-Reset` on every response so a well-written
client never sees a 429. Limits use `checkRateLimitRedis`, which falls back to
per-instance memory when Redis is down: still a limit, just a looser one.
Higher per-app limits are stored on the application-owned app policy, raised
through the console request form; ordinary use never needs it.

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
ticks is 50 pages plus one server-side snapshot build. Bound snapshot storage,
concurrency and build time, and measure its transaction cost. Per-page climb
lookups are batched. Measure p95 per route
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
  exempts `/v1/partner/`. Change it to `/v1/` and permit the backend's
  `/api/auth/oauth2/` and issuer metadata routes (authorize is a GET a CLI may
  open). Mirror it in the Cloudflare rule with the correct hostname.
- Milestone 0 exempts `/developers/`, `/auth/login` and `/oauth/` on `www`,
  and milestone 2 adds `/llms.txt`. Coding agents fetch docs with `curl`,
  `python-requests` and the like, and drive browsers whose UA says
  `HeadlessChrome`; the default-deny blocks both on GET today
  (`AUTOMATION_SIGNATURE_TOKENS`). `claude-user` and `chatgpt-user` are already
  allowed. The default-deny exists for crawl cost; a login page and a consent
  page are not where that cost is.
- AASA claims every path but `/gym` and `/poster` for the iOS app, so on an
  iPhone with Boardsesh installed a link to `/developers/…` would open the app
  on Home. `/developers` joins `/oauth` in `WEB_ONLY_PATH_PREFIXES`.

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

The first-party identity migration and the partner platform have independent
rollout flags and acceptance gates. The migration may ship before the API;
the API needs the authority/compatibility slice it uses to be proven, but does
not require retiring support for old native apps or Garmin watches. Neither
gate is waived by the other succeeding. The migration roadmap lives in
[better-auth-migration.md](./better-auth-migration.md).

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
| `idle_in_transaction_session_timeout` on the application roles | Set and documented in `docs/db-connectivity.md` |

### Milestone 1: connect and sync (the MVP)

The first vertical slice: a developer registers an app, a climber connects
it, the app syncs the logbook, the climber disconnects it.

| # | PR | Depends on |
| --- | --- | --- |
| 1.1 | `@boardsesh/public-api`: zod schemas, OpenAPI registry, committed `openapi.json`, CI diff check | — |
| 1.2 | Complete snapshot bootstrap, `logbook_changes`, feed generation, watermark, triggers, atomic pruning and concurrency/recovery tests | — |
| 1.3 | Generated provider Drizzle schema, app/connection policy, opaque introspection, `/v1` router and rate limits | D2 OAuth gate; required identity/compatibility slice proven |
| 1.4 | Supported Better Auth consent/continuation UI, connection-generation enforcement, security-revocation integration | 1.3; migration security gate |
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
- **External security review** before milestone 2: who, and when.
- **Moving the phone's sync onto the change log**, which would close its
  long-transaction hole too. Not needed for the public API.
- **Imported `climbedAt`.** Aurora's naive timestamps are stored as UTC
  (`apply-user-logbook.test.ts`), which may be the climber's local time.
  Document as-is, or fix at import?
- **`source` on a tick** (`boardsesh` vs `imported`): left out; an app
  that also imports from Kilter directly could use it to de-duplicate. Add
  when one asks.
- **New-connection cap**: is 200/day right for an app that launches with a
  big audience? It is a column; the question is the default.
- **Who reads the console's "more limits" requests**, and how fast. The goal
  is that nobody has to, ordinarily.

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
