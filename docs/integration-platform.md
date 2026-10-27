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

The `partner-*` file names are historical (code comments cite them by name).
The documents themselves no longer use "partner": every integrator is an
**app**, the person who registers it is a **developer**, the Boardsesh user is
the **climber**, and a climber's approval of one app is a **connection**
(an `oauth_grants` row).

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

### D2. `oidc-provider` inside the backend, confirmed by a spike

Revised 2026-10-27 after review. The first draft chose to write a narrow
authorization server ourselves. Even narrow, that is authorization-code
exchange, PKCE, client authentication, refresh rotation, replay detection,
revocation and metadata: protocol code where every bug is a security bug, and
whose upkeep would be ours alone. A maintained implementation moves that
upkeep upstream. What stays ours either way: the consent UI, app
registration, the Connected apps screen, rate limits, abuse controls and the
resource API.

| Option | What it is | Fit with our stack | What we would still write | Who ships security fixes | New things to run |
| --- | --- | --- | --- | --- | --- |
| **`oidc-provider`** (panva) | Node library, OpenID Certified, MIT. Covers authorization code + PKCE, refresh rotation (`rotateRefreshToken`; with rotation on, a reused refresh token revokes the whole grant), revocation (RFC 7009), RFC 8414 and OIDC discovery, per-client CORS (`clientBasedCORS`), resource indicators with opaque access tokens, dynamic client registration if we ever want it | Mounts as a plain `(req, res)` handler (`provider.callback()`) on our `http` server under `/oauth/*`. Koa is an internal dependency. Login and consent are "interactions" whose URL can be absolute, so the screen can live on `www` | A storage adapter (two tables), the interaction pages and their confirm handler, account lookup, client lookup from our `oauth_clients`, token checks on `/v1/*` | Upstream; we take releases through the existing dependency bot | Nothing |
| Ory Hydra (self-hosted) | Go service, OpenID Certified, Apache 2.0. Headless: redirects to our login and consent URLs with a challenge, we accept it over its admin API | A second service with its own migrations in our Postgres and an admin port to lock down. Opaque tokens are checked by calling its introspection endpoint, so every API request makes a network hop or caches and delays revocation | Login/consent pages, admin API calls, client sync from our console | Upstream, but we deploy and upgrade the service | A service on Railway (and later on EC2, #6632) |
| Writing it ourselves (first draft) | Four handlers over Drizzle tables | Native | All of it, including the security-critical parts | Us | Nothing |
| `@node-oauth/oauth2-server` | Library running grant flows over a model we write | Fits | Storage, rotation and reuse policy, revocation endpoint, metadata, CORS | Shared | Nothing |
| Keycloak, Ory Network, Auth0, WorkOS, Clerk, Stytch | Full identity servers, hosted or self-run | Each wants to own climber identity or federate it from NextAuth and native auth; per-user pricing for the hosted ones; the portability rule in CLAUDE.md ("Database hosting") argues against a hosted dependency | Identity migration or federation | Vendor | A service or a vendor |
| better-auth OAuth provider plugin | Plugin | Only works when better-auth is the identity system. It is not | — | — | — |

**Decision: `oidc-provider`, mounted in `packages/backend` on
`api.boardsesh.com`.** It is the only option that removes the protocol code
without adding a service. Ory Hydra is the fallback if the spike fails;
writing our own is the last resort, and only with the full test suite below.

**The spike (milestone 0, two days, throwaway branch).** Go only if all of
these hold:

1. Mounted under `/oauth/*` on the backend's `http` server without touching
   other routes, and the backend still builds and starts.
2. `/oauth/authorize` → interaction page on `www` → the climber allows → the
   confirm request to `api.boardsesh.com` identifies the climber from the
   NextAuth session cookie (set on `.boardsesh.com` by `sessionCookieDomain()`,
   so the backend host receives it, and `validateToken` already decrypts it),
   with a CSRF token → code issued. Works in Safari on iOS and Chrome on
   Android, including when the climber has to sign in first.
3. A Drizzle adapter stores every model; `revokeByGrantId` makes the next API
   call fail; grants are listable per climber for Connected apps.
4. Policies hold: PKCE with `S256` required for every client, confidential
   ones included; `plain` refused; `rotateRefreshToken: true`; a reused refresh
   token or code revokes the grant; revoking an access token at `/oauth/revoke`
   does not revoke the grant; opaque access tokens for the
   `https://api.boardsesh.com` resource; `clientBasedCORS` driven by our
   per-app origins; one live grant per (app, climber) via `loadExistingGrant`.
5. `authenticateApiBearer` resolves an access token through the adapter in
   under 5 ms p95, with no cache.
6. RFC 8414 metadata is served and lists exactly what we support.

**Required before any outside app, whichever implementation wins:** the
protocol and adversarial suite in [Authorization server](#authorization-server).
A library removes code we would write; it does not remove the need to prove
our configuration and our glue are right.

Revisit if we need OpenID Connect sign-in ("Sign in with Boardsesh") or
dynamic client registration for MCP clients: `oidc-provider` has both, so
those become configuration, not new code.

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

### D4. Opaque tokens with grant-level revocation (kept)

Access tokens live 1 hour, refresh tokens 90 days and rotate on every use,
authorization codes 60 seconds and work once. Access tokens are opaque and
looked up in storage on every API call, so revoking a connection takes
effect on the next request; a signed JWT would outlive Disconnect. The
earlier `bsa_`/`bsr_`/`bsc_` prefixes are not part of the contract: token
values are generated by `oidc-provider`, and apps must treat them as opaque
strings. (A prefix would help secret scanners spot a leaked token. The spike
checks whether the library lets us add one; it is not a launch requirement.)

### D5. API tokens never pass `validateToken` (kept)

`packages/backend/src/middleware/auth.ts` `validateToken` is the first-party
identity for `/graphql`, sessions, everything, with a 60-second success
cache. An API token that satisfied it would be a full account session with a
different label. API tokens are checked by their own function on their own
router (`/v1/*`), with no cache.

### D6. A transactional change log first, webhooks later

Revised 2026-10-27 after review. The first draft reused the phone's sync
cursor: `(updated_at, id)` with a 30-second stability window. That cursor can
permanently miss a row whose transaction commits more than 30 seconds after it
started, and the draft papered over the gap with a monthly full resync. A
monthly resync is reconciliation, not a guarantee, and does nothing for an app
that stops syncing before it runs.

The public feed instead reads a change log written by a trigger in the same
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
every OAuth endpoint (`/oauth/authorize`, `/oauth/token`, `/oauth/revoke`,
the metadata) live on `api.boardsesh.com`, where `oidc-provider` runs. Only
the screens a climber looks at (sign-in, consent) live on `www`.

### D10. Consent runs on `www`, the decision is recorded on the backend

The consent screen is a Next page on `www` because that is where sign-in
lives. It renders what the backend tells it (`oauthInteraction(uid)`: the
app's name, links and the requested scopes) and posts Allow or Cancel to
`api.boardsesh.com/oauth/interaction/{uid}/confirm`. That handler reads the
climber from the NextAuth session cookie, checks the CSRF token, and calls
`oidc-provider`'s `interactionFinished`. App registration and the Connected
apps screen are internal GraphQL operations in `packages/backend`. None of
these are part of the public contract, and an API token can never call them
(D5).

---

## Assessment of the Sequence plan

The plan in `partner-api.md` / `partner-workouts-internal.md` (#5530, September
2026) was already written as "a general partner API" and most of its security
model holds. Measured against the platform goals:

### Already aligned

- Boardsesh as authorization server; PKCE S256 for every client, confidential
  ones included; exact redirect URI match; system browser only, no WebView.
- Opaque tokens checked against storage on every call; refresh rotation
  with reuse revoking the grant; codes revoke their grant on a second use.
  (The `bsa_`/`bsr_` prefixes are dropped, see D4.)
- `oauth_grants` as the unit the climber sees and revokes; no cache on
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
- Client ids like `seq_1a2b3c` in the examples suggested hand-assigned,
  named ids. Ids are random: `bsk_` + 22 base62 characters.
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
  it was never a copy; it now comes from `oidc-provider`, see D2), and
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
- **Consent from a stale web session.** NextAuth sessions are stateless JWTs
  with a 30-day default life and no server-side revocation. Someone holding a
  stolen cookie can still approve an app after the climber resets their
  password. NextAuth refreshes the JWT's `iat` on every rolling update, so
  `iat` cannot tell an old login from a new one. Milestone 1 stamps a fixed
  `authTime` claim once at sign-in (the same way `authSessionId` is stamped in
  `auth-options.ts`), stamps `users.credentials_changed_at` wherever
  credentials change (`api/auth/reset-password` and `api/internal/set-password`),
  and the consent operation refuses a session whose `authTime` is older.
- **Self-registered webhook URLs are an SSRF vector** (milestone 4): see
  [Webhooks](#webhooks-later).
- **A library at the centre of auth.** `oidc-provider` is maintained mainly
  by one person. Mitigations: pin the version, take releases through the
  dependency bot with the auth test suite as the gate, keep our glue thin
  (adapter, interaction handler, bearer check) so moving to Hydra stays
  possible, and keep tokens opaque so no app depends on their format.
- **Secret encryption has no key versioning.** `@boardsesh/crypto` derives
  one AES key from `AURORA_CREDENTIALS_SECRET` with a fixed salt. Fine for
  hashed client secrets (never encrypted); webhook secrets in milestone 4 need a
  versioned key so a rotation is possible.

---

## Authorization server

### Endpoints

| Endpoint | Served by | Notes |
| --- | --- | --- |
| `GET https://api.boardsesh.com/oauth/authorize` | `oidc-provider` | Validates the request, then redirects to the interaction page. Errors that make the redirect URI untrustworthy (unknown client, unregistered redirect) render an error page and never redirect |
| `GET https://www.boardsesh.com/oauth/consent/{uid}` | Next page, `packages/web/app/oauth/consent/` | Sends a signed-out climber through `/auth/login` and back, then shows the consent screen |
| `POST https://api.boardsesh.com/oauth/interaction/{uid}/confirm` | Our handler in `packages/backend/src/handlers/oauth/` | Climber from the NextAuth cookie, CSRF check, `authTime` check (see risks), then `interactionFinished` |
| `POST https://api.boardsesh.com/oauth/token` | `oidc-provider` | `authorization_code` and `refresh_token` grants. Client auth `none` (public apps), `client_secret_post`, `client_secret_basic` |
| `POST https://api.boardsesh.com/oauth/revoke` | `oidc-provider` | RFC 7009. Refresh token: revokes the grant. Access token: that token only |
| `GET https://api.boardsesh.com/.well-known/oauth-authorization-server` | `oidc-provider` | RFC 8414 metadata: `code_challenge_methods_supported: ["S256"]`, scopes, auth methods, `authorization_response_iss_parameter_supported: true` |

The authorization response carries `iss` (RFC 9207) so an app talking to
several providers can detect a mix-up. `/oauth/*` on `api` is outside the
iOS association file (the app claims `www` and the apex, not `api`); the
consent page's `/oauth` on `www` is excluded in milestone 0.

CORS: a browser-only app (no backend) is a public client using the
authorization code flow. `/oauth/token`, `/oauth/revoke` and `/v1/*` handle
CORS in two steps, because a preflight `OPTIONS` carries neither a token nor
a body and so cannot say which app is calling:

1. Preflight: allowed when the `Origin` is the origin of any live app's
   registered `https` redirect URI (a set cached for a minute and dropped on
   app changes). The answer allows `GET`, `POST`, `DELETE` and the
   `Authorization`, `Content-Type` and `Idempotency-Key` headers, never
   credentials, with `Vary: Origin`.
2. Actual request: `Access-Control-Allow-Origin` is echoed only when the
   `Origin` belongs to the calling app itself (`clientBasedCORS` on
   `/oauth/*`, the token's app on `/v1/*`). An origin registered by a different
   app passes the preflight and is then refused by the browser.

Every other origin gets no CORS headers. A form-encoded token request without
an `Authorization` header is a simple request and skips the preflight.
Refresh-token rotation with reuse detection is what OAuth 2.1 requires before
a browser app may hold a refresh token, and the configuration in D2 has it.

### Storage

All in `packages/db/src/schema/auth/`, user columns `text` referencing
`users.id` with cascade. `oidc-provider` builds one adapter instance per model
name, so the models we query ourselves get typed tables and the rest share
one generic table.

| Table | Holds | Notes |
| --- | --- | --- |
| `oauth_clients` | `id` (`bsk_…`), `owner_user_id`, `name`, `homepage_url`, `privacy_url`, `client_type` (`public`/`confidential`), `redirect_uris text[]`, `client_secret_hash`, `client_secret_prev_hash`, `client_secret_prev_expires_at`, `allowed_scopes text[]`, `daily_grant_cap`, `rate_limit_tier`, `suspended_at`, `suspended_reason`, `created_at`, `deleted_at` | Ours; the console writes it, the provider reads it through `findClient`. Secrets are hashed and compared in our client-auth hook. `suspended_at` fails every request closed |
| `oauth_grants` | `id`, `client_id`, `user_id`, `scopes text[]`, `payload jsonb`, `created_at`, `last_used_at`, `revoked_at`, `revoked_reason` | The provider's `Grant` model, typed, because Connected apps lists it and workouts reference it. One live grant per (app, climber) through `loadExistingGrant`: consenting again (a second device, more scopes) widens it, and earlier tokens keep working. `last_used_at` written at most hourly |
| `oauth_provider_models` | `id`, `kind`, `payload jsonb`, `grant_id`, `uid`, `expires_at`, `consumed_at` | Every other model: `AuthorizationCode`, `AccessToken`, `RefreshToken`, `Interaction`, `Session`. Indexed on `(kind, id)`, `grant_id` (for `revokeByGrantId`) and `uid` |
| `oauth_subjects` | `client_id`, `user_id`, `subject` | D8. Primary key `(client_id, user_id)`; survives reconnects |

Expired rows are cleaned by a pg-boss scheduled job (see
[background-workers.md](./background-workers.md)), not a `setInterval`.

### Bearer auth for `/v1/*`

`authenticateApiBearer(header)` in `packages/backend/src/middleware/api-auth.ts`
looks the token up through the provider (`AccessToken.find`), then checks the
grant is not revoked and the app is not suspended or deleted, and returns
`{ clientId, grantId, userId, subject, scopes }` or a 401. No cache. Each
route declares its scope; a mismatch is `403 insufficient_scope`. 401
responses carry `WWW-Authenticate: Bearer error="invalid_token"` (RFC 6750).

### Revocation

| Trigger | Effect |
| --- | --- |
| Climber taps Disconnect (mobile Settings → Connected apps, or web account settings) | `revokeByGrantId`, `oauth_grants.revoked_at` set, unfinished workouts → `revoked` |
| App calls `/oauth/revoke` with a refresh token | Grant revoked |
| App calls `/oauth/revoke` with an access token | That access token only (the acceptance test relies on this) |
| Refresh-token or code reuse | Grant revoked, `revoked_reason = 'reuse'` |
| Password reset or password set | Every grant for the climber revoked, `credentials_changed_at` stamped. Hooks in `api/auth/reset-password` and `api/internal/set-password`, which revoke nothing today |
| Account deletion | Cascades from `users`; tokens stop resolving |
| App deleted or suspended by its developer or an admin | All its grants fail closed; the climber's Connected apps list shows it as "no longer available" |

### Test suite required before launch

Milestone 1 does not let an outside app connect until these pass in CI
against the real configuration. They are written whichever implementation D2
ends with.

Protocol:

- PKCE: the RFC 7636 appendix B vector; a missing challenge, `plain`, or a
  wrong verifier fails, for public and confidential apps alike.
- Redirect URIs: exact match, the loopback port rule, the refused forms
  (fragments, wildcards, `http` off loopback, our own schemes and hosts);
  errors before validation never redirect.
- Codes: single use; a second use revokes everything issued from it; a code is
  bound to its app, redirect URI and verifier; expires after 60 seconds.
- Refresh: rotation on every use; the old token fails; a reused one revokes
  the grant; a rotated token survives a concurrent duplicate request only as
  the library allows, and the docs say what apps should do.
- Revocation semantics from the table above; expired access tokens; scopes
  not granted are refused; `iss` in the authorization response; error bodies
  per RFC 6749 §5.2.

Adversarial:

- Consent CSRF (a cross-site POST to the confirm handler), clickjacking
  (`frame-ancestors 'none'` on the consent page), a stale session (`authTime`
  before `credentials_changed_at`) refused.
- `callbackUrl` and redirect-URI open redirects.
- App A's tokens used with app B's `client_id`; an API token on `/graphql`
  and on the GraphQL operations behind consent and the console; a first-party
  token on `/v1/*`.
- Suspended app, deleted app, deleted climber, password reset: every token
  dies on the next request.
- CORS from another app's origin; token-endpoint limits under rotating IPs.

An outside security review of the configuration and glue before milestone 2
opens registration to everyone is recommended; the cost is a few days of
someone's time against an auth surface every app will use.

---

## Self-service registration

A developer console at `https://www.boardsesh.com/developers/apps`
(`robots: noindex`), backed by internal GraphQL mutations in
`packages/backend` (`createOAuthClient`, `updateOAuthClient`,
`rotateOAuthClientSecret`, `deleteOAuthClient`, `myOAuthClients`).

Form fields: name, homepage URL, privacy policy URL, client type, redirect
URIs. The secret (confidential clients) is shown once. No icon upload in the
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
| `status` | `status` | `flash`, `send`, `attempt`. Clients must tolerate new values |
| `attempts` | `attempt_count` | |
| `stars` | `quality` | 1–5 or `null` |
| `grade` | `difficulty` via the board's grade table | The climber's own grade; `null` when they gave none |
| `comment` | `comment` | The climber's note |
| `climb.id` | `COALESCE(board_climb_aliases.canonical_uuid, climb_uuid)` | Canonical at read time. A later catalog merge changes it without a tick change; documented |
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
from `/oauth/authorize`. The full table is in
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
  "cursor": "c2.eyJ4IjoiOTg3…",
  "hasMore": true
}
```

- No `cursor` starts from the beginning: a full sync is the same loop as an
  incremental one.
- `limit` 1–200, default 100.
- Keep calling with the returned `cursor` while `hasMore` is true, store the
  last `cursor`, and start from it next time. Store it even when `changes` is
  empty: an empty page still moves the cursor forward.
- Each entry carries the tick's state **at the time of the read**. A `tick` is
  an upsert by `id`; `tick.deleted` means the tick no longer exists for this
  app (deleted, or hidden as a duplicate) and removes it.

### The change log

One table, `logbook_changes`, written only by triggers:

| Column | Type | Notes |
| --- | --- | --- |
| `seq` | `bigserial` primary key | Order within a transaction |
| `txid` | `xid8`, default `pg_current_xact_id()` | The writing transaction. 64-bit, never wraps |
| `user_id` | `text`, FK `users` with cascade | Whose logbook |
| `tick_uuid` | `text` | Which tick. No FK: the tick may be gone |
| `created_at` | `timestamp`, default `now()` | For pruning only |

Index `(user_id, txid, seq)`.

Writers, all `AFTER … FOR EACH ROW` triggers added with a `drizzle-kit
generate --custom` migration, the way `0144_offline_sync_backend.sql` added the
existing tick triggers (guarded so a re-applied test schema does not roll back,
see the backend test-DDL notes):

1. On `boardsesh_ticks` insert and delete: one row for the tick.
2. On `boardsesh_ticks` update: one row, only when a column the public tick is
   built from changed (`user_id`, `board_type`, `climb_uuid`, `angle`,
   `is_mirror`, `status`, `attempt_count`, `quality`, `difficulty`,
   `is_benchmark`, `comment`, `climbed_at`, `origin`, `aurora_id`). A
   `user_id` change writes a row for both climbers. Updates that only touch
   sync bookkeeping (the `aurora_*` and `kilter_*` columns) write nothing, which
   also keeps Kilter's PowerSync redeliveries out of the feed.
3. Twins: when the row is an Aurora-pull row with a real `aurora_id`, the same
   trigger writes a row for every other Aurora-pull row of that climber with
   the same board, climb, angle and `climbed_at`. Those are exactly the rows
   whose visibility under `notAuroraTwinDuplicate` the write can flip.
4. On `board_climb_aliases` insert or update: a row for every tick on the
   alias climb, because its public `climb.id` (the canonical uuid) changed.
   Merges are rare; the cost is one row per tick on the merged climb.

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
horizon for this climber has been read". The cursor is `c2.` plus base64url
JSON of that pair and its issue time; `c1.` cursors from the draft never
shipped.

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
  An app that reads until `hasMore` is false holds the current state of every
  tick that changed before that read, including deletions.
- **At least once.** A tick can arrive more than once, always as its current
  state. Apply entries as upserts and removals; never as increments.
- **Ordered by transaction, not by clock.** Entries come in the order the
  writing transactions started. Since every entry carries current state, the
  end result does not depend on the order.
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
  cursor forward, so an app that syncs at least once every 90 days never sees
  `410`.

### Retention, cursor validity and moving the database

- A daily pg-boss job deletes `logbook_changes` rows older than 90 days and,
  in the same transaction, raises a one-row watermark,
  `logbook_change_watermark.pruned_through`, to the largest `(txid, seq)` it
  deleted. A cursor below the watermark answers `410 cursor_expired`: a row
  after it may be gone. A cursor at or above it is valid however old it is,
  because nothing after it was deleted. Validity is measured against what is
  still retained, not against when the cursor was issued.
- The test cursor `c2.expired` always answers `410`, so an app can test its
  recovery path.
- A cursor whose `txid` is above the current snapshot's `xmax` cannot come
  from this database cluster and answers `410` too.
- `xid8` values belong to one cluster. A physical replica promoted in a
  failover keeps them ([postgres-dr-architecture.md](./postgres-dr-architecture.md)).
  A logical move with `pg_dump`/`pg_restore` (the portability rule, and
  [neon-migration.md](./neon-migration.md)) starts a new cluster with smaller
  `txid`s, so the restored change rows would sit above the new horizon and the
  feed would stall. The move runbook gets two steps: `TRUNCATE
  logbook_changes`, then set the watermark to the new cluster's current
  position, so every stored cursor answers `410` and apps do one full resync.
  The `xmax` check above catches any cursor that slips through.
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
| Token endpoint, refresh | 10 requests/min per connection | `oauth-refresh:<clientId>:<grantId>` |
| Token endpoint, code exchange and revoke | 60 requests/min per (app, client IP) | `oauth-client:<clientId>:<ip>`, IP from `getPublicClientIp` |
| Token endpoint, whole app | 6,000 requests/min | `oauth-client:<clientId>` |
| API, per connection | 120 requests/min per (app, climber) | `api:<clientId>:<userId>` |
| API, per app | 6,000 requests/min across all its climbers | `api:<clientId>` |
| Page size | 200 | |
| New connections | 200/day per app | Postgres count, not Redis, so it cannot fail open |
| Request body | 64 KB | |

`429` carries `Retry-After` (seconds) and `RateLimit-Limit`,
`RateLimit-Remaining`, `RateLimit-Reset` on every response so a well-written
client never sees a 429. Limits use `checkRateLimitRedis`, which falls back to
per-instance memory when Redis is down: still a limit, just a looser one.
Higher per-app limits are a column (`oauth_clients.rate_limit_tier`), raised
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

Every API read is scoped by `user_id` on an index that leads with it; there is
no query in the API whose cost grows with the size of the catalog or the
number of climbers. The heavy case is a first sync of a big logbook: 10,000
ticks is 50 pages. Per-page climb lookups are batched. Measure p95 per route
before milestone 2 opens registration, against the read replica numbers in
[postgres-query-costs.md](./postgres-query-costs.md).

### Observability

- Every `/v1` and `/oauth` log line carries `clientId` and `requestId`. The
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
  exempts `/v1/partner/`. Change it to `/v1/` and add `/oauth/` (the token
  endpoint is POST, which the default-deny does not touch, but `/oauth/authorize`
  is a GET a CLI may open). Mirror it in the Cloudflare rule.
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
  says a climber disconnected (the one event sent after the grant is gone; it
  carries only the per-app user id). No tick data in any body. The app then reads
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
  (`id`, `client_id`, `event`, `body jsonb`, `status`, `attempts`,
  `last_status_code`, `last_error`, `delivered_at`). The handler re-checks the
  grant before sending, so a climber who disconnected between the event and a
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
- Ordering is not guaranteed and does not need to be: every event means "go
  read", and the read is ordered.
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

Each milestone is shippable and useful alone. PRs inside a milestone are
small enough to review in one sitting, and every PR touching the
authorization server gets a Fable review.

### Milestone 0: prerequisites (no feature visible)

| PR | Acceptance |
| --- | --- |
| `oidc-provider` spike (D2), throwaway branch, two days | The six go/no-go criteria in D2 are checked off in a short write-up appended to this doc. No-go → evaluate Ory Hydra against the same list before milestone 1 starts |
| AASA: add `/oauth` and `/developers` to `WEB_ONLY_PATH_PREFIXES` | `/.well-known/apple-app-site-association` lists `NOT /oauth/*` and `NOT /developers/*`. Ships at least a week before milestone 1's consent page so installed phones refresh the file |
| Constrain `callbackUrl` on `/auth/login` with `safe-callback-url.ts` | A test proves `?callbackUrl=https://evil.example` lands on `/` |
| `api.boardsesh.com` CNAME in `infra/cloudflare`, custom domain on the backend service | `curl https://api.boardsesh.com/health` answers |
| Default-deny exemptions: `/v1/partner/` → `/v1/`, plus `/oauth/`, `/developers/`, `/auth/login` | Unit test in `crawler-policy`; a `HeadlessChrome` GET of `/oauth/consent/…` is not refused |
| `idle_in_transaction_session_timeout` on the application roles | Set and documented in `docs/db-connectivity.md` |

### Milestone 1: connect and sync (the MVP)

The first vertical slice: a developer registers an app, a climber connects
it, the app syncs the logbook, the climber disconnects it.

| # | PR | Depends on |
| --- | --- | --- |
| 1.1 | `@boardsesh/public-api`: zod schemas, OpenAPI registry, committed `openapi.json`, CI diff check | — |
| 1.2 | `logbook_changes`, the watermark, the triggers, the prune job, and the concurrency and randomized tests from [Incremental sync](#incremental-sync) | — |
| 1.3 | OAuth storage tables + adapter; `oidc-provider` mounted with the D2 configuration; `authenticateApiBearer`; `/v1` router; rate limits | M0 spike |
| 1.4 | Consent page, interaction confirm handler, `authTime` and `credentials_changed_at`, revoke-all on password reset and set | 1.3, M0 |
| 1.5 | `GET /v1/me`, `GET /v1/logbook/changes`, `GET /v1/logbook/ticks/{id}` | 1.1, 1.2, 1.3 |
| 1.6 | Developer console (create, list, edit redirect URIs, rotate secret, delete) behind the web server flag `developer-console` | 1.3 |
| 1.7 | Connected apps: mobile section in `app/settings/integrations.tsx`, web account section, `connectedApps` / `revokeConnectedApp` | 1.3 |
| 1.8 | The authorization-server test suite ([Authorization server](#test-suite-required-before-launch)) | 1.3, 1.4 |
| 1.9 | LEGAL.md sentence (wording in "Data boundaries"), before the beta apps go live | Marco's approval |

Acceptance for the milestone:

1. A backend end-to-end test (Vitest, real Postgres) registers an app, runs
   authorize → token → `changes` across three pages, creates, edits and
   deletes ticks and sees each in the feed, refreshes, replays an old refresh
   token and sees the grant die, and gets `401` after Disconnect.
2. The interleaved-transaction test and the randomized concurrent-writer test
   pass: the reader's copy equals the database's public view after every run,
   including twin pairs and alias merges.
3. The authorization-server suite (1.8) passes.
4. Contract tests validate every response against `openapi.json`.
5. `410 cursor_expired` is returned for a cursor below the pruning watermark,
   for one from another cluster and for `c2.expired`; a cursor issued 200 days
   ago that is still above the watermark works.
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
time; a revoked connection gets `connection.revoked` and nothing after it.

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
| 2. Authorize | Implements PKCE + `state`, opens the browser, completes consent | | Grant exists with `logbook:read` |
| 3. Connect | Exchanges the code, stores both tokens | | `GET /v1/me` succeeds |
| 4. Retrieve | Full sync | | Local file has exactly the account's ticks, all pages, no duplicates |
| 5. Incremental | Syncs again | Logs 2 ticks, edits 1 | Exactly those 3 changes applied; stored cursor advanced |
| 6a. Deletion | Syncs again | Deletes 1 tick | It is gone locally |
| 6b. Token expiry | Next call | Revokes the agent's current access token only | Agent refreshes, stores the rotated refresh token, call succeeds |
| 6c. Expired cursor | Next sync | Replaces the stored cursor with the documented test cursor `c2.expired`, which always answers `410` | Agent does a full resync, keeps every tick that still exists, drops none it should keep |
| 7. Disconnect | Implements "disconnect" via `/oauth/revoke`; then the harness reconnects and disconnects from Connected apps | Taps Disconnect | Agent's next call gets `401`, refresh gets `invalid_grant`, agent reports "reconnect needed" instead of looping |

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
- **The spike's outcome** (D2). If `oidc-provider` fails a criterion, Hydra
  is next; the decision and the write-up land in this doc.
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
- [background-workers.md](./background-workers.md), pg-boss roles
