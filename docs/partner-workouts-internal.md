# Partner workouts: the design behind the partner API

[docs/partner-api.md](./partner-api.md) is the contract we hand to a training
app. This file is the other half: which tables hold it, which handlers serve
it, where the mobile app picks a workout up, and what has to wait for the
workouts epic. Read the partner doc first; nothing here changes what it
promises.

The first partner is Sequence (sequence-app.com). Their plan says "4x4 at V4,
three minutes rest", the climber taps Open in Boardsesh, climbs, and their
Sequence logbook fills itself in. We are building it as a general partner
API because the second training app costs almost nothing extra once the first
one exists, and because a Sequence-shaped special case would have to be
undone the day Crimpd or Lattice asks.

Status: design, nothing merged. The workout runner it leans on is
[epic #5399](https://github.com/boardsesh/boardsesh/issues/5399); the stage
model is [#5379](https://github.com/boardsesh/boardsesh/issues/5379) and 4x4
rounds are [#5380](https://github.com/boardsesh/boardsesh/issues/5380). This
integration ships before both and degrades honestly until they land (see
"What waits on the workouts epic").

---

## Why Boardsesh is the authorization server

Two shapes were on the table.

**Boardsesh as the OAuth client, Strava-shaped.** We already have this
machinery: `IntegrationProviderImpl`, the `integration_credentials` store, the
`integration_exports` claim rows, the Connected apps card. A Sequence provider
would be one more entry in `packages/backend/src/integrations/registry.ts`.
The catch is on the other side. For that shape Sequence has to run an OAuth
authorization server, a consent screen, and an ingest API for results, and
sign launch links with a key we verify. Sequence has none of that today; their
only integrations are an outbound Strava sync and read-only MCP tokens. We
would be asking a small company to build an identity provider so that we could
reuse a registry file.

**Boardsesh as the authorization server.** Sequence writes an OAuth client
(they have one for Strava already), one `POST`, and one webhook receiver. We
write the server side once and every later partner plugs into the same thing.
The user relationship stays with us: the climber sees "Sequence wants to
create workouts for you" on a boardsesh.com consent page and can cut it off
from More → Connected apps.

The second shape won. It is more code on our side, but it is the code that
makes this a platform feature instead of a one-off.

If scope ever has to be cut hard, the smallest thing that still works is a
partner keypair signing a launch link that carries the workout, plus our
signed webhook, with no user tokens at all. That drops the pull path and
per-user revocation, so it is recorded here as the floor, not the plan.

---

## The tables

All in `packages/db/src/schema/`, user columns are `text` referencing
`users.id` with cascade, matching every other user-scoped table. Migrations
go through `vp run build:db` then `vp exec drizzle-kit generate` per
[docs/db-migrations.md](./db-migrations.md).

| Table                       | Holds                                                                                                        | Why a table                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth_clients`             | `id`, `name`, `icon_url`, `redirect_uris text[]`, `client_secret_hash`, `webhook_url`, `webhook_secret_enc`, `webhook_secret_prev_enc`, `allowed_scopes`, `events text[]`, `enabled` | Seeded by migration or an admin script, never self-serve. `enabled = false` fails every request closed. Two webhook secrets so rotation does not break the partner mid-flight |
| `oauth_authorization_codes` | `code_hash`, `client_id`, `user_id`, `redirect_uri`, `scope`, `code_challenge`, `expires_at`, `consumed_at`      | Consent is on web, the token endpoint is on the backend; they share Postgres and nothing else. Redis would work but fails open when unconfigured, and this must not |
| `oauth_grants`              | `id`, `client_id`, `user_id`, `scopes`, `created_at`, `revoked_at`                                                | The thing the Connected apps screen lists and the thing Disconnect revokes. Tokens hang off it so revocation is one `UPDATE`                                        |
| `oauth_access_tokens`       | `token_hash`, `grant_id`, `expires_at`                                                                           | Opaque, hashed, one hour. A row lookup by hash is cheap and revocation is immediate; a signed JWT would live on after Disconnect                                    |
| `oauth_refresh_tokens`      | `token_hash`, `grant_id`, `expires_at`, `revoked_at`, `replaced_by`                                               | Same shape as `mobile_refresh_tokens`; `replaced_by` is what makes reuse detection possible                                                                          |
| `partner_workouts`          | `id`, `client_id`, `grant_id`, `user_id`, `external_ref`, `title`, `spec jsonb`, `plan_snapshot jsonb`, `status`, `session_id`, `opened_at`, `started_at`, `completed_at`, `expires_at`, `opened_by_mismatch`, `idempotency_key`, `idempotency_body_hash` | Unique on `(client_id, user_id, external_ref)` gives the 409. `plan_snapshot` is what the app actually queued at Start, so results can say planned vs done          |
| `partner_webhook_deliveries` | `id`, `workout_id`, `client_id`, `event`, `payload jsonb`, `job_id`, `status`, `attempts`, `last_status_code`, `last_error`, `delivered_at` | The ledger of what we sent a partner and how it went. Retry state lives in the pg-boss job; this row is what support reads and what `Boardsesh-Delivery-Id` points at |

Plus one column: `board_sessions.partner_workout_id`, nullable, FK to
`partner_workouts`, set by `createSession` when the app passes it.

### Why the workout is a row and not a URL

The obvious cheap version encodes the whole workout in the launch link. It
was rejected for three reasons that all bite at once: universal links have
practical length limits and a twelve-block plan with instructions blows
through them; a link is copyable, so a workout could be opened by a different
climber than the one it was made for; and there is nowhere to hang status,
results or the idempotency key. Fetch-by-id costs one extra request from
Sequence and buys all of that back.

---

## The OAuth server

### Consent lives on web

`/oauth/authorize` is a Next page under `packages/web/app/oauth/authorize/`.
It has to be: the NextAuth session cookie is the only thing that says who the
climber is in a browser, and the backend never sees that cookie. The page
reads the session with `getServerSession(authOptions)`, sends an unauthenticated
visitor through `/auth/login` and back, then renders the client's name and
icon, the requested scopes in the words from the partner doc, and Allow /
Cancel.

Three rules on that page, each closing a hole that exists somewhere in the
wild:

1. Every parameter is validated before anything renders. An unknown
   `client_id`, an unregistered `redirect_uri` (exact string match against
   `oauth_clients.redirect_uris`), a missing `state`, a missing or non-S256
   `code_challenge`: all of these render an error on boardsesh.com and never
   redirect. Redirecting the error to the supplied URI is how open redirectors
   are born.
2. The Allow form carries a CSRF token bound to the NextAuth session, and the
   parameters are re-validated from the POST body rather than trusted from
   hidden fields. A page that trusts its own hidden fields can be pre-filled
   by an attacker's page.
3. The response sets `Content-Security-Policy: frame-ancestors 'none'`. The
   site-wide middleware sends `SAMEORIGIN`, which still allows a boardsesh.com
   frame, and clickjacking a consent button is the one case where that
   matters.

On Allow, the page writes an `oauth_authorization_codes` row (code is random,
stored as SHA-256), and 302s to the redirect URI with `code` and the untouched
`state`.

Two things outside the page have to move first. The iOS association file at
`packages/web/app/.well-known/apple-app-site-association/route.ts` claims every
path except `/api/*`, `/_next/*`, `/monitoring` and `/.well-known/*`, which
means `https://boardsesh.com/oauth/authorize` opens the native app today and
lands on `+not-found`. Add `NOT /oauth/*`, and ship it in its own PR well
ahead of the rest: Apple's CDN only refetches the file on install or update,
so existing installs keep the old rule until then. And
`packages/web/app/auth/login/auth-page-content.tsx` pushes `callbackUrl` with
no origin check; constrain it to a same-origin relative path before
`/oauth/authorize` becomes a new caller of it.

### Codes and tokens on the backend

`POST /oauth/token` and `POST /oauth/revoke` are plain HTTP handlers in
`packages/backend/src/handlers/oauth-server.ts`, registered in `server.ts` next
to the `/auth/native/*` routes, and they copy that file's habits: a body cap,
form-encoded input, constant-time secret comparison, RFC 6749 error bodies,
`Cache-Control: no-store`, and no CORS headers at all (this is a
server-to-server or native-client endpoint; a browser has no business here).

The code exchange is one atomic statement, the same idiom
`packages/backend/src/handlers/native-auth.ts` uses for refresh rotation:

```sql
UPDATE oauth_authorization_codes
   SET consumed_at = now()
 WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
RETURNING client_id, user_id, redirect_uri, scope, code_challenge
```

No row back means the code is unknown, expired, or already used. For the
already-used case the handler also revokes the grant that code produced,
because a second presentation means either the partner has a retry bug or
someone else has the code, and both deserve the same answer. The verifier is
checked with `timingSafeEqual(base64url(sha256(verifier)), code_challenge)`,
and `client_id` and `redirect_uri` on the request must equal the ones on the
row. Confidential clients also present `client_secret`, compared against the
hash. PKCE is not waived for them.

Tokens are opaque: `bsa_` + 32 random bytes for access, `bsr_` + 32 for
refresh, both stored hashed. The prefix exists so a leaked token is
recognisable in a log or a secret scanner, and so nobody mistakes one for a
mobile JWT. Refresh rotates on every use. A refresh token whose `replaced_by`
is set is a reused one, and reuse revokes the grant.

### Partner tokens never touch `validateToken`

This is the rule the whole thing rests on.
`packages/backend/src/middleware/auth.ts` `validateToken` is the mobile and web
identity. It feeds `/graphql`, the session routes, the watch routes,
everything. If a partner access token ever satisfied it, a `workouts:write`
token would be a full user session with a different label.

So partner auth is its own function, `authenticatePartnerBearer(header)` in
`packages/backend/src/middleware/partner-auth.ts`, returning
`{ clientId, grantId, userId, scopes }` or `null`, and it is called by exactly
one router: `/v1/partner/*`. It does a hash lookup joined to `oauth_grants`
and `oauth_clients` and refuses if the grant is revoked, the token is
expired, or the client is disabled. It has no in-process cache. The 60-second
success cache in `validateToken` is fine for a mobile JWT and wrong here,
where Disconnect has to mean now.

Each route declares its scope and a `requireScope` helper turns a mismatch
into `403 insufficient_scope`.

### Rate limits

`checkAuthRateLimit` in `native-auth.ts` keys on `socket.remoteAddress`, which
behind Railway's proxy is the proxy. Everyone would share one bucket. Partner
limits use `checkRateLimitRedis`
(`packages/backend/src/utils/redis-rate-limiter.ts`) keyed
`oauth-client:<clientId>` on the token endpoint and
`partner:<clientId>:<userId>` on the API, with the numbers from the partner
doc. Code issuance on the consent page is limited per user as well, so a
stuck partner loop cannot fill the codes table.

### Revocation and the Connected apps screen

`packages/mobile/app/(tabs)/profile/integrations.tsx` already renders board
accounts and platform cards. A new "Apps with access" section lists
`oauth_grants` for the viewer via a `connectedApps` query (client name, icon,
scopes, connected date) with Disconnect. Disconnect calls
`revokeConnectedApp(grantId)`, which sets `revoked_at`, moves that grant's
unfinished `partner_workouts` to `revoked`, and leaves the deliveries table
alone: the delivery job checks the grant before sending, so nothing more is
needed.
Password reset in `packages/web/app/api/auth/reset-password/route.ts` gets a
call to the same revoke-all, which is the rule Sequence applies to its own
tokens and the one a climber would expect.

---

## The partner API

Handlers live in `packages/backend/src/handlers/partner-workouts.ts`,
validation in `packages/backend/src/validation/schemas/partner-workouts.ts`
(zod, the block schema is the one in the partner doc, unknown block fields
stripped rather than rejected). It is REST rather than GraphQL because the
audience is a partner's backend engineer with `curl`, and because it must not
share an auth context with `/graphql` (see above).

The status column is an enum and every transition is a conditional `UPDATE`
that names the states it may come from, so two racing requests cannot both
succeed:

| From      | To            | Who                                                          |
| --------- | ------------- | ------------------------------------------------------------ |
| `created` | `opened`      | The app, first successful `partnerWorkout(id)` fetch          |
| `opened`  | `started`     | `createSession` with `partnerWorkoutId`                       |
| `started` | `completed`   | `endSession`                                                  |
| `started` | `auto_closed` | The inactivity job                                            |
| `created`, `opened` | `cancelled` | Partner `DELETE`; from `started` it is a 409           |
| `created` | `expired`     | A daily scheduled job, `expires_at` passed                    |
| any       | `revoked`     | Disconnect, password reset                                    |

`Idempotency-Key` is stored on the row with a hash of the body; a replay
within 24 hours returns the stored response, a different body returns 422.
The unique index on `(client_id, user_id, external_ref)` produces the 409 and
returns the existing row so the partner can decide.

`support` per block is computed server-side from a static map, so the
response is stable regardless of which app build the climber has. That map
is the one place to flip `fourByFour` to `native` when #5380 ships.

---

## Launch on mobile

### The route

`packages/mobile/app/w/[workoutId].tsx`. It has to exist: `+native-intent.ts`
passes unknown paths through to file routing, and without a file the link
lands on `+not-found`.

The route does four things. It checks auth, and if the viewer is signed out it
stores the workout id in AsyncStorage and sends them to sign in, the way
`deep-link-provider.tsx` stashes a join link under
`boardsesh_pending_join_session_id` and replays it after `checkAuth`. (The
join screen's own `router.replace('/auth/login')` drops the link on the floor;
do not copy that one.) It fetches `partnerWorkout(id)` over GraphQL with the
viewer's normal JWT; the resolver checks `user_id` and answers 403 for anyone
else, and records `opened_by_mismatch` on the row so the partner can see it.
On success it puts the workout into a pending-workout store and navigates to
`/(tabs)/record`. On 403 it shows "This workout was sent to a different
Boardsesh account" with a sign-out button and nothing that identifies the
target account.

### The pending-workout store

`PreSessionView` keeps its generator selection in component state, which a
route cannot reach. So there is a small module store,
`packages/mobile/src/lib/pending-workout-store.ts`, the same
`useSyncExternalStore` singleton shape as `rest-timer-store.ts`: `set`,
`clear`, `usePendingWorkout()`. It is not persisted. If the app is killed
before Start, the climber taps the link again; the workout row on the server
is the durable copy.

### What the pre-session view does with it

`PreSessionView` renders a `PartnerWorkoutCard` above `BoardSummaryCard` when
the store has something: the source app's name and icon, the title, the
coach's notes, then one row per block with its label and, for freeform blocks,
the instructions. The board is whatever `useActiveBoard()` returns, or the
picker if there is none, unchanged from today. `preferredBoard` from the spec
is only used to pre-sort the picker.

Start does what it does now and one thing more. `createSessionWithConfig` in
`packages/mobile/src/providers/queue/use-session-commands.ts` gains
`partnerWorkoutId` on `StartSessionConfig`, passes it through
`CreateSessionInput`, and the resolver writes it to the session row and moves
the workout to `started`. Then the blocks are turned into a queue:

| Block type                                       | What runs it today                                                                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warmUp`, `volume`, `pyramid`, `ladder`, `gradeFocus` | The existing generator. Each maps onto a `GeneratorOptions` variant in `@boardsesh/playlist-generator`, `selectClimbsForPlan` fills it, `appendGeneratedSession` queues it |
| `onTheMinute`                                    | One `gradeFocus` block for the climbs plus `armRestTimer('onTheMinute', ...)` with `intervalSeconds` as the target                                       |
| `freeClimbing`, and any `freeform` block         | Nothing is queued. The block card stays visible in the in-session view with the instructions, and ticks land in the session as usual                    |
| `fourByFour`, `limitBouldering`                  | Freeform until #5380. The card shows rounds and rests as text                                                                                            |

Grades arrive as `{ scale, value }` and the generator wants a board difficulty
id, so the mapping happens on device against the board's grade table from
`@boardsesh/board-config`, once the board is known. A target the board cannot
express (V0 on a MoonBoard) clamps to the nearest grade and the card says so.

What was actually queued, per block, is written back as `plan_snapshot`
through a `recordPartnerWorkoutPlan` mutation at Start. That snapshot is how
results attribute ticks to blocks without the stage model: a tick is assigned
to the block whose queued climbs it belongs to, and a tick on a climb that was
never queued falls into the nearest freeform block by time order.

If a session is already running when the workout lands, the card offers
"End current session" or "Add to this session". Adding attaches the workout id
to the live session and appends the blocks behind the current queue.

### The web page behind the universal link

`packages/web/app/w/[workoutId]/page.tsx`, patterned on the `/join` page. It
is deliberately dumb: title, the source app's name, an "Open in Boardsesh"
button that fires the custom scheme, store links, and `robots: noindex`. It
never shows the blocks or notes, because the page is reachable by anyone with
the id and the workout may carry a coach's private notes.

Android is the honest gap. `packages/mobile/app.config.ts` only lists `/join`,
`/preview` and `/auth/reset-password` in its intent filters, so
`https://boardsesh.com/w/...` opens Chrome until a native build adds a
`pathPrefix: '/w'` entry. That is a release/next change. Meanwhile the scheme
works on every build, which is why the partner doc tells them to try
`appUrl` first and why the web page has a scheme button.

---

## The job queue

This integration is the third feature in the backend that needs "do this
later, retry it if it fails, and don't do it twice". The inactivity sweep and
the refresh-token cleanup are `setInterval`s in `server.ts` and
`room-manager.ts`; the Strava export has a claim row and no retry at all,
because nobody wanted to write a third sweep. Rather than a fourth, the
partner API lands after a queue does.

The queue is [pg-boss](https://github.com/timgit/pg-boss), running inside the
backend process against the same Postgres. Two reasons it beat BullMQ, which
would have sat on the Redis we already run:

1. **The job can commit with the state change.** pg-boss `send` accepts a
   `db` option, so the job insert rides the same transaction that ends the
   session and writes the ledger row. A Redis queue cannot join a Postgres
   transaction, which means keeping an outbox table and a relay to move rows
   into Redis, and the relay is the sweep we were trying to delete.
2. **Nothing new to make durable.** Today's Redis use tolerates loss: rate
   limits, nonces, the Streams bus with `MAXLEN ~10000`. A queue would be the
   first thing on it that does not, and would need `noeviction` and
   persistence checked on the Railway instance. Postgres already has both.

pg-boss polls with `SKIP LOCKED` rather than LISTEN/NOTIFY, so it keeps
working behind any connection pooler. It creates and migrates its own
`pgboss` schema on `start()`. That schema is outside `packages/db/drizzle`,
so `check:db-migrations` does not see it and `pg_dump` carries it like any
other schema; note it in `docs/db-migrations.md` when the PR lands. Before
the design leans on them, verify two things against the installed version:
that `send(..., { db })` really does run on a caller-supplied transaction,
and the exact shape of `retryBackoff` (the numbers in this doc assume
doubling from `retryDelay` with jitter).

Boundaries: the Redis Streams notification worker stays as it is; it is a
fan-out bus, not a delayed-job problem, and it works. The Railway scheduler
(`packages/scheduler`) keeps driving the web-side cron paths; backend-side
periodic work moves to pg-boss `schedule()` instead.

First tenants, in the queue PR itself so the queue arrives already proven:

| Job                       | Replaces                                                      | Shape                                      |
| ------------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| `session-inactivity`      | The 60 s `setInterval` in `room-manager.ts`                   | Scheduled every minute, `singletonKey` fixed |
| `refresh-token-cleanup`   | `startRefreshTokenCleanup` in `native-auth.ts`                | Scheduled daily                            |
| `integration-export`      | Fire-and-forget `autoSyncSessionToIntegrations`, no retry     | One job per `integration_exports` claim, retries with backoff |
| `partner-webhook`         | Nothing yet; this design                                      | See "Delivery and retries"                 |
| `partner-workout-expiry`  | Nothing yet                                                   | Scheduled daily, moves `created` past `expires_at` to `expired` |

Tests: the backend suite already boots Postgres, so pg-boss runs for real
under Vitest. A test helper starts it with a short poll interval, and tests
that end a session either drain the queue or assert on the ledger row rather
than the webhook, so no test depends on a timer.

---

## Results

### When and from what

`endSession` in `packages/backend/src/graphql/resolvers/sessions/mutations.ts`
already does the work of ending a session and then fire-and-forgets
`autoSyncSessionToIntegrations`. Partner results go in the same place but not
the same way: inside the transaction that marks the session ended, if
`partner_workout_id` is set, the resolver moves the workout to `completed`
writes the `partner_webhook_deliveries` ledger row with the full payload,
and enqueues the `partner-webhook` job on the same transaction (see "The job
queue"). Either all three commit or none do. The Strava path can lose an
export if the process dies between ending the session and starting the
upload; this one cannot, which matters more here because a partner is
waiting on the other end and has no share button to press again.

Abandoned sessions need no new machinery. `endStaleInactiveSessions` in
`packages/backend/src/services/room-manager/room-manager.ts` already ends a
session after 60 minutes without activity. That sweep becomes a scheduled
job on the queue, and its handler writes the same ledger row and job with
`completion: 'auto_closed'` while moving the workout to `auto_closed`.

The payload builder, `buildPartnerWorkoutResults(workoutId)` in
`packages/backend/src/services/partner-workout-results.ts`, reads ticks
filtered to the workout's `user_id`, the way the `sessionHealthExport`
resolver does. A party session has other climbers' ticks on it and none of
those may reach a partner. `generateSessionSummary` is viewer-scoped too, but
it is scoped to whoever is calling, which in the inactivity job is nobody; the builder
takes the user id explicitly.

Grade fields come from the tick's `difficulty` resolved through the board's
grade table (`boardLabel`, plus `v` and `font` split out of it) and
`boardseshDifficulty` where the climb has one. `restBeforeSeconds` is the gap
to the previous tick's `climbed_at`, `null` for the first.

### Delivery and retries

A delivery is one pg-boss job, `partner-webhook`, whose data is just the
ledger row id. The handler loads the row, re-checks that the grant is still
live (a climber who disconnected between End and a retry does not get their
results sent anyway), signs the stored payload, and `POST`s it with a
10-second `AbortController` timeout, the same shape as
`packages/backend/src/lib/web-revalidate.ts`.

What the handler does with the response decides whether the queue retries:

| Response                                       | Handler                                                   | Ledger        |
| ---------------------------------------------- | --------------------------------------------------------- | ------------- |
| `2xx`                                          | Completes the job                                         | `delivered`   |
| `410`                                          | Completes the job, marks the client's webhook URL gone, cancels the client's other pending jobs | `dead`        |
| `408`, `429`, `5xx`, timeout, connection error | Throws, so pg-boss schedules the next attempt             | `pending`, `attempts` bumped |
| any other `4xx`                                | Completes the job with a recorded failure                 | `dead`        |

The last row is the one worth stating: a partner that rejected the bytes
will reject them again, so throwing there would only burn the retry budget.

Job options: `singletonKey` is the ledger id, so an accidental double enqueue
collapses into one job; `retryLimit: 9`, `retryDelay: 120`, `retryBackoff:
true`, which is exponential from about two minutes and gives up after roughly
17 hours; `expireInSeconds: 30` so a hung handler is reclaimed. The partner
doc quotes the same numbers. After the last retry pg-boss fails the job and
the handler's `onFail` marks the ledger `dead`; the results stay readable on
`GET /workouts/{id}`.

The retry-eligible errors are the same list `web-revalidate.ts` treats as
transient; keep them in one helper so the Strava export job (below) agrees.

Signing: `Boardsesh-Signature: t=<unix seconds>,v1=<hex hmac-sha256(secret,
t + "." + rawBody)>`, with a second `v1` from `webhook_secret_prev_enc` while
a rotation is in progress. Secrets are encrypted with `@boardsesh/crypto`, as
`credentials.ts` does for Strava tokens, because a webhook secret has to be
recoverable to sign with; the client secret, by contrast, is only ever
compared, so it is hashed.

---

## Rolling it out

The mobile side sits behind a `partner-workouts` flag in
`FEATURE_FLAG_DEFINITIONS` (`packages/mobile/src/providers/feature-flags-provider.tsx`),
with `EXPO_PUBLIC_PARTNER_WORKOUTS=true` as the static-build override, the
same pair `strava-integration` uses. Off, the `/w/` route shows "not
available yet" and the Connected apps section hides. The backend does not
need a flag: an `oauth_clients` row with `enabled = false` is the switch, and
there are no rows until we create Sequence's.

PR order, each one small enough to review in a sitting:

| Step | PR                                                                                                           | Why this order                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 0    | AASA `NOT /oauth/*`                                                                                          | Has to propagate through Apple's CDN before anyone opens the consent page             |
| 0.5  | Constrain `callbackUrl` on `/auth/login` to a same-origin relative path                                      | The consent page is a new caller of it; closing the open redirect first is a prerequisite, not a follow-up |
| 1    | pg-boss, with the inactivity sweep, token cleanup and Strava export moved onto it                            | Proves the queue on things that exist before anything new depends on it               |
| 2    | Tables, OAuth server, consent page, Connected apps section                                                   | Gets a Fable review: it is auth-adjacent and the token rules above are easy to fumble |
| 3    | Partner workouts API, results builder, delivery and expiry jobs                                              | Testable end to end with `curl` and a fake webhook receiver before any mobile code    |
| 4    | Mobile `/w/` route, pending store, pre-session card, `partnerWorkoutId` on `createSession`, web landing page | JS-only, ships by OTA                                                                 |
| 5    | Android `/w` intent filter                                                                                    | Native, rides release/next; the scheme covers Android until then                      |
| 6    | `fourByFour` native, `round` and per-round timing in results                                                 | After #5379 and #5380                                                                 |

Telemetry, in `@boardsesh/analytics` `SHARED_EVENTS`: `Partner Workout
Opened`, `Partner Workout Started`, `Partner Workout Completed`, each with
`clientId`, `blockTypes`, `nativeBlockCount`, `freeformBlockCount`, and on
Completed `completion`. Per the board-render rule, never pool these across
`board_name`.

---

## What waits on the workouts epic

The partner doc promises `climbs[].round`, per-round timing and rest adherence
"later". Concretely:

- `blockIndex` today comes from the plan snapshot, which is good for native
  blocks and a guess for freeform ones. Once #5379 gives every queue item a
  stage that survives the queue boundary and the server records it on the
  tick, attribution becomes exact and `blockIndex` is set for every tick.
- `round` needs #5380: a queue that knows it is four climbs repeated four
  times, and a tick that knows which repetition it was. Until then it is
  `null` and the doc says so.
- Rest adherence (planned rest vs actual per block) needs both, plus the rest
  timer's arm state or fire times on the server. Today the timer is client-only
  (`rest-timer-store.ts` is deliberately not persisted). `restBeforeSeconds`
  from tick gaps is what we can offer now and it is labelled as derived.
- RPE has no column anywhere. If we add it, it is a nullable field on
  `board_sessions` set from the end-session sheet, independent of the epic,
  and it goes into the payload as optional `session.effort`.

None of these change a field that already exists, which is the whole reason
the payload was shaped with `null`s and a `support` flag instead of waiting.

---

## Open questions

- Does Sequence want `workout.opened` at all, or only `completed`? The
  registration record has an `events` list so either answer is a data change.
- Can Sequence pass the climber's configured grade scale on the workout, so
  the card and the results lead with the right one? The payload carries both
  scales regardless; this is only about display.
- App-to-app consent. Once universal links are reliable on both platforms
  the consent screen could live in the app instead of the browser, which is a
  nicer flow when Boardsesh is installed. It also means the app would handle
  `/oauth/authorize`, the opposite of what step 0 does, so it is a later
  decision, not a small one.
- Whether a partner may create workouts for a climber who has never opened
  Boardsesh on a phone. Today the answer is yes (the row just sits at
  `created` until it expires), and that seems right.

## Related docs

- [partner-api.md](./partner-api.md), the contract this file implements
- [integrations.md](./integrations.md), the Strava export path and the
  signed-token envelope the OAuth server borrows from
- [mobile-auth-flow.md](./mobile-auth-flow.md), refresh rotation and hashed
  token storage on the mobile side
- [inferred-sessions.md](./inferred-sessions.md), why `board_sessions` is the
  only place a session lives
- [feature-flags.md](./feature-flags.md), the mobile flag catalog
- [db-migrations.md](./db-migrations.md), before generating the tables above
