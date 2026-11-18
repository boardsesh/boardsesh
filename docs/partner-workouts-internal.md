# Workouts over the API: implementation and launch gates

[partner-api.md](./partner-api.md) section 4 is the workouts contract we hand
to app developers. This file is the other half: which tables hold a workout,
which handlers serve it, where the mobile app picks it up, and what has to wait
for the workouts epic.

Workouts are milestone 3 of the integration platform. The OAuth server, app
registration, scopes, bearer auth, rate limits, the logbook feed and webhooks
are shared by every app and every scope, and their design lives in
[integration-platform.md](./integration-platform.md). Read that first; this
file only covers what is specific to workouts. Identity and session migration
are a separate deliverable in [better-auth-migration.md](./better-auth-migration.md).
Workouts depend on the validated Better Auth OAuth provider and connection
lifecycle, not on retiring compatibility endpoints for old native apps or
Garmin watches. Both remain backed by the same auth authority.

The first app to ask for workouts was Sequence (sequence-app.com): their plan
says "4x4 at V4, three minutes rest", the climber taps Open in Boardsesh,
climbs, and their Sequence logbook fills itself in. What Sequence needs is in
[integration-consumers.md](./integration-consumers.md). Nothing below is
specific to Sequence; any app with `workouts:write` gets the same thing.

Status: the workout API, mobile handoff, results and webhook completion
path are implemented. The mobile `app-workouts` flag defaults off; backend
availability follows `PARTNER_OAUTH_MODE`. This document does not announce
production activation. The remaining rollout and device checks are below.

The workout runner it uses is
[epic #5399](https://github.com/boardsesh/boardsesh/issues/5399). The stage
model from [#5379](https://github.com/boardsesh/boardsesh/issues/5379) exists
on the phone (`docs/workout-stages.md`); native 4x4 reps and sets remain tied
to [#5380](https://github.com/boardsesh/boardsesh/issues/5380). This
integration supports those blocks as freeform until that work lands (see
"What waits on the workouts epic").

### What changed on 2026-10-27

This file was first written (#5530) as the whole "partner API": OAuth server,
tables, webhooks and workouts, with Sequence as the only client. It now covers
workouts only. The decisions that moved, and why, are in
[integration-platform.md](./integration-platform.md) ("Assessment of the
Sequence plan"). In short:

- The OAuth tables, consent page, token handlers, bearer auth, rate limits and
  Connected apps moved to the platform doc, generalized: self-service
  registration instead of seeded client rows, `api.boardsesh.com` instead of
  `ws`, `/v1/*` instead of `/v1/partner/*`, `authenticateApiBearer` instead of
  `authenticatePartnerBearer`.
- Workouts come after the logbook feed (milestone 1), which delivers most of
  what a training app's logbook needs on its own.
- Results are read with `GET /v1/workouts/{id}`. Webhooks became thin "go
  read" events in milestone 4 instead of carrying the results.
- The results payload lost `session.id` and `session.url` (a session id is its
  invite link), and the derived fields `restBeforeSeconds`, `totals`,
  `blocks[].done` and `round`. Ticks in results use the logbook tick shape.
- The table is `app_workouts` and the mobile flag is `app-workouts`.
  The current mobile card component is `PartnerWorkoutCard`.

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
reuse a registry file. Multiply that by every app that wants to integrate and
it stops being an option at all.

**Boardsesh as the authorization server.** An app writes an OAuth client
(most already have one for Strava), one `POST`, and one `GET`. We write the
server side once and every later app plugs into the same thing. The
relationship stays with the climber: they see "Sequence wants to create
workouts for you" on a boardsesh.com consent page and can cut it off from
Settings → Connected apps.

The second shape won, and [integration-platform.md](./integration-platform.md)
generalizes it into the platform every app uses.

A signed launch link without user tokens was considered and rejected: it
would lose the pull path and per-user revocation. If the Better Auth proof
fails, revise the design explicitly before implementation; do not activate
that alternative as a fallback.

---

## The tables

All in `packages/db/src/schema/`, user columns are `text` referencing
`users.id` with cascade, matching every other user-scoped table. Migrations
go through `vp run build:db` then `vp exec drizzle-kit generate` per
[docs/db-migrations.md](./db-migrations.md). Better Auth's generated schema
and the application-owned app policy and `oauth_connections` records are
specified in the platform doc and exist from milestone 1. Workouts reference
that explicit connection, not a provider-internal grant or browser session.

| Table | Holds | Why a table |
| --- | --- | --- |
| `app_workouts` | `id`, `client_id`, `connection_id`, `connection_generation`, `user_id`, `external_ref`, `title`, `spec jsonb`, `plan_snapshot jsonb`, `status`, `session_id`, `opened_at`, `started_at`, `completed_at`, `expires_at`, `opened_by_mismatch` | Unique on `(client_id, user_id, external_ref)` gives the 409. `plan_snapshot` is what the app actually queued at Start, so results can attribute ticks to blocks |

Attachment uses `app_workouts.session_id`, unique with `user_id`. Each climber
in a shared session can attach one workout. The session foreign key uses
`RESTRICT`, preserving completed partner results. `app_workout_requests` stores
the 24-hour idempotency key, body hash, original response, connection generation
and expiry separately, keyed by app, climber and idempotency key.

`connection_id` and `connection_generation` bind a workout to the authorization
that created it. Creating, opening, attaching and starting a workout recheck
that this generation is active in the same serialized transaction as the
mutation; disconnect cannot race with creation or Start to leave an active
workout behind. Revoking an individual access/refresh token does not revoke
workouts. UI disconnect or `DELETE /v1/connection` invalidates the connection
and moves unfinished workouts to `revoked` atomically. Reconnecting creates a
new generation and never revives those workouts or their queued events.

`session_id` stays internal. It links the workout to the session row so the
results builder can find the ticks; it is never serialized to an app.

### Why the workout is a row and not a URL

The obvious cheap version encodes the whole workout in the launch link. It
was rejected for three reasons that all bite at once: universal links have
practical length limits and a twelve-block plan with instructions blows
through them; a link is copyable, so a workout could be opened by a different
climber than the one it was made for; and there is nowhere to hang status,
results or the idempotency key. Fetch-by-id costs the app one extra request
and buys all of that back.

---

## The workouts API

Handlers live in `packages/backend/src/handlers/public-api/workouts.ts`,
behind the `/v1` router and `authenticateApiBearer` from milestone 1. Request
and response schemas are in `@boardsesh/public-api` with every other route
(unknown block fields stripped rather than rejected). Routes declare
`workouts:write` (create, cancel) or `workouts:read` (get, list).

The status column is an enum and every transition is a conditional `UPDATE`
that names the states it may come from, so two racing requests cannot both
succeed:

| From      | To            | Who                                                          |
| --------- | ------------- | ------------------------------------------------------------ |
| `created` | `opened`      | The app, first successful `appWorkout(id)` fetch             |
| `opened`  | `started`     | `createSession` with `appWorkoutId`                          |
| `started` | `completed`   | `endSession`                                                 |
| `started` | `auto_closed` | The inactivity job                                           |
| `created`, `opened` | `cancelled` | App `DELETE`; from `started` it is a 409               |
| `created`, `opened` | `expired` | A minute-scheduled job, `expires_at` passed. `opened` expires too, or a workout looked at and never started would count against the cap forever |
| `created`, `opened`, `started` | `revoked` | Whole-connection disconnect or security revocation. Token revocation alone leaves workouts unchanged. Finished workouts keep their status |

`Idempotency-Key` is stored in `app_workout_requests` with a hash of the body
and the response; a replay within 24 hours returns the stored response, a different
body returns 422. The unique index on `(client_id, user_id, external_ref)`
produces the 409 and returns the existing row so the app can decide. A
create when the climber already has 20 unfinished workouts from this app
answers `409 workout_limit`; the count is one indexed query on
`(client_id, user_id, status)`.

Expiry is the later of creation plus seven days or `scheduledFor` at 00:00 UTC
plus two days, preserving the full scheduled local day west of UTC. Request
paths also refresh expired unstarted workouts, so enforcement does not depend
on the maintenance schedule. Each minute, `app-workout-expiry` expires at most
1,000 workouts and deletes at most 1,000 expired idempotency receipts in one
bounded transaction; later runs continue any backlog.

Workout list pages have `limit` 1–100 (default 50), `cursor` and `hasMore`.
They briefly fence the connection to authenticate and expire old rows, build
the page and its results in a read-only repeatable-read transaction without
that fence, then revalidate the live bearer, scopes and connection generation
before returning. All three transactions retain the partner timeout bounds; token
refresh, Disconnect and session End do not wait for a page of result builds.

Create-body buffering starts only after authentication, scope checks and rate
limits. The body reader holds no database admission permit while waiting and
still enforces 64 KB, five seconds, 128 readers globally and eight per client
address. Unread bodies force `Connection: close`, including early refusals.

`support` per block is computed server-side from a static map, so the
response is stable regardless of which app build the climber has. That map
is the one place to flip `fourByFour` to `native` when #5380 ships. The
phone's 4x4 is reps × sets on one climb (a set is one climb done for every
rep, then the rest between sets), so flipping it also decides how the block's
`climbCount`, `rounds` and two rests map onto `sets`, `repsPerSet`,
`restBetweenRepsSeconds` and `restBetweenSetsSeconds`.

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
do not copy that one.) It fetches `appWorkout(id)` over GraphQL with the
viewer's first-party session credential; the resolver checks `user_id` and answers 403 for anyone
else, and records `opened_by_mismatch` on the row so the app that created it
can see it. On success it puts the workout into a pending-workout store and
navigates to `/(tabs)/record`. On 403 it shows "This workout was sent to a
different Boardsesh account" with a sign-out button and nothing that
identifies the target account.

`appWorkout(id)` and the mutations below are internal GraphQL for the
Boardsesh app, authenticated with first-party tokens. They are not part of
the public API.

### The pending-workout store

`PreSessionView` keeps its generator selection in component state, which a
route cannot reach. So there is a small module store,
`packages/mobile/src/lib/pending-workout-store.ts`, the same
`useSyncExternalStore` singleton shape as `rest-timer-store.ts`:
`setPendingWorkout`, `clearPendingWorkout`, `usePendingWorkout()`. The pending pre-Start payload stays in memory;
if the app is killed before Start, the climber opens the link again.

After a successful Start or attachment, the app persists the account-scoped
`{ sessionId, workoutId }` association before fetching the workout or checking
whether the displayed session changed. A running free-climbing timer also
persists its block index and end deadline. Private notes, instructions and
stage payloads are fetched from the server rather than copied into this
preference record.

`PartnerWorkoutEntry` rehydrates through `appWorkout(id)` on cold start and
session changes. A matching running session restores the card, instructions,
server-backed workout stages and timer deadline. If Start committed in another
session, the pending card offers Resume instead of trying to start it again.
Credential changes and session teardown clear the association; hydration checks
the account generation and current session before applying late responses.
Signed-out deep-link stashes expire after 24 hours, and flag-off links are not
saved for a later sign-in.

### What the pre-session view does with it

`PreSessionHeaderView` mounts `PartnerWorkoutEntry`, which shows
`PartnerWorkoutCard` when the store has a workout: the source app's registered
name, the title, the coach's notes, then one row per block with its label and
instructions. The board is whatever `useActiveBoard()` returns, or the picker if there is none,
unchanged from today. `preferredBoard` from the spec is only used to pre-sort
the picker.

Start does what it does now and one thing more. `createSessionWithConfig` in
`packages/mobile/src/providers/queue/use-session-commands.ts` gains
`appWorkoutId` on `StartSessionConfig`, passes it through
`CreateSessionInput`, and the resolver writes it to the session row and moves
the workout to `started`. Then the blocks are turned into a queue:

| Block type                                       | What runs it today                                                                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warmUp`, `volume`, `pyramid`, `ladder`, `gradeFocus` | The existing generator. Each maps onto a `GeneratorOptions` variant in `@boardsesh/playlist-generator`, `selectClimbsForPlan` fills it, `appendQueueItems` queues it |
| `onTheMinute`                                    | A native `onTheMinute` stage (`partner-workout-plan.ts`) with `numberOfClimbs` and `intervalSeconds` from the block                                       |
| `freeClimbing`, and any `freeform` block         | Nothing is queued. The block card stays visible in the in-session view with the instructions, and ticks land in the session as usual                    |
| `fourByFour`, `limitBouldering`                  | Freeform. The card shows rounds and rests as text. The app's own 4x4 and limit blocks are native stages now, but the partner mapping is undecided (`docs/partner-api.md`) |

Grades arrive as `{ scale, value }` and the generator wants a board difficulty
id, so the mapping happens on device against the board's grade table from
`@boardsesh/board-config`, once the board is known. A target the board cannot
express (V0 on a MoonBoard) clamps to the nearest grade and the card says so.

The native blocks run through the stage model #5379 built
(`docs/workout-stages.md`). The app already treats every part of a workout as
a block, warm-ups included and in any order, so an API workout's blocks map
one to one: `planFromBlocks` turns them into one stage per block in the API
block vocabulary (an API `warmUp` keeps its own target grade; the app's
ramps to the next workout block), `generateStagedPlan` and the shared preview
pools fill them, and the phone keeps a `WorkoutRun` that maps every queued
climb to its block, so the player and the session card can say
"Volume · 3 of 8".

The existing `session_workouts` write and durable mobile outbox store the run
on the server. `recordAppWorkoutPlan` records its per-block climb snapshot at
Start; the normal session-workout write reconstructs the same canonical snapshot
if that response is lost. Empty freeform blocks remain in the snapshot. Results can infer a block only when the tick's climb matches
exactly one block in that snapshot. A climb never queued, or queued in more
than one block, gets `blockIndex: null`; warm-up and volume can contain the
same climb. Exact attribution requires a queue-item/stage identity recorded
on each tick, which this milestone does not invent.

If a session is already running when the workout lands, the card offers
"End current session" or "Add to this session". Adding attaches the workout id
to the live session and appends the blocks behind the current queue, the same
way "Add a block" adds a stage mid-session today (`add-workout-block.ts`: no
`activateFirstWhenIdle`, so it does not move the wall on this phone, then the
stages join the run; it shares Add to queue's crew race, see
`docs/workout-stages.md`). Permanent gym sessions reject attachment before
changing the workout state; `createSession` also refuses `isPermanent` with
`appWorkoutId`. Both paths return GraphQL `CONFLICT` with
`reason: APP_WORKOUT_PERMANENT_SESSION`, and the card asks for a personal
session. Expected workout conflicts and unavailable states receive typed
GraphQL errors without reporting failed session starts to Sentry.

If the session changes after the server commits Start or attachment, the card
refetches the committed workout and offers Resume for the winning session.
It does not append the old preview into the newly displayed session.

### The web page behind the universal link

`packages/web/app/w/[workoutId]/page.tsx`, patterned on the `/join` page. It
renders a generic heading, an "Open in Boardsesh" button that fires the custom
scheme, store links, and `robots: noindex`. A browser-side public lookup adds
the source app's name when available. This uses the visitor's real backend
ingress for rate limits instead of grouping all SSR requests under the web
server's address. It never shows the workout title, blocks or notes, because
the page is reachable by anyone with the id and the workout may carry a coach's private notes.

`packages/mobile/app.config.ts` includes
`{ host: 'www.boardsesh.com', pathPrefix: '/w/' }` in the Android intent filter.
Installed Android builds must include that native manifest change before
`https://www.boardsesh.com/w/...` can open the app; an OTA update cannot add it.
The launch link must use the `www` host: the apex answers `assetlinks.json` with a redirect, so Android cannot verify it and
the manifest never claims it. Meanwhile the scheme works on every build,
which is why the contract tells apps to try `appUrl` first and why the web
page has a scheme button.

---

## The job queue

This was written as "the API lands after a queue does". The queue has landed:
pg-boss runs inside the backend against the same Postgres
(`packages/backend/src/services/job-queue.ts`, roles and families in
[background-workers.md](./background-workers.md)). The reasoning that chose
it is kept here because `job-queue.ts` points at this section.

[pg-boss](https://github.com/timgit/pg-boss) beat BullMQ, which would have sat
on the Redis we already run, for two reasons:

1. **The job can commit with the state change.** pg-boss `send` accepts a
   `db` option, so the job insert rides the same transaction that ends the
   session and writes the row it is about. A Redis queue cannot join a
   Postgres transaction, which means keeping an outbox table and a relay to
   move rows into Redis, and the relay is the sweep we were trying to delete.
2. **Nothing new to make durable.** Today's Redis use tolerates loss: rate
   limits, nonces, the Streams bus with `MAXLEN ~10000`. A queue would be the
   first thing on it that does not, and would need `noeviction` and
   persistence checked on the Railway instance. Postgres already has both.

pg-boss polls with `SKIP LOCKED` rather than LISTEN/NOTIFY, so it keeps
working behind any connection pooler. Its `pgboss` schema is outside
`packages/db/drizzle`, so `check:db-migrations` does not see it and `pg_dump`
carries it like any other schema (`docs/db-migrations.md`). Of the two
assumptions this section asked to be checked, one is settled on 12.x:
`send(..., { db })` runs on a caller-supplied transaction through the official
`fromDrizzle` adapter (see the header of `job-queue.ts`). The other is
documented in `DEFAULT_JOB_OPTIONS`: `retryBackoff` grows as
`retryDelay * 2^retryCount` with jitter, and the shared default caps it at
`retryDelayMax: 120`, which webhook delivery must override (see the platform
doc).

Boundaries: the Redis Streams notification worker stays as it is; it is a
fan-out bus, not a delayed-job problem, and it works. The Railway scheduler
(`packages/scheduler`) keeps driving the web-side cron paths; backend-side
periodic work moves to pg-boss `schedule()`.

Jobs this design needs, and where the older candidates stand:

| Job | State | Shape |
| --- | --- | --- |
| `session-inactivity` | Implemented in `app-workout-maintenance.ts` | Scheduled every minute on an exclusive queue; closes inactive sessions and attached `started` workouts as `auto_closed` |
| Auth credential cleanup | Existing `startRefreshTokenCleanup` in `native-auth.ts`; #5544 | Coordinate migration with the maintained native/Garmin compatibility API. Better Auth and partner credential cleanup must follow the supported schema and retention policy proven in milestone 1 |
| `integration-export` | Strava still fire-and-forget; #5545 | Not a workouts dependency |
| `app-workout-expiry` | Implemented in `app-workout-maintenance.ts` | Scheduled every minute; expires at most 1,000 `created`/`opened` workouts and prunes at most 1,000 expired receipts per run |
| webhook delivery | Implemented | Platform-wide; see the platform doc |

Session inactivity and workout expiry register independently at startup, each
with a caught registration failure. A failed workout job registration cannot
prevent backend startup or skip inactivity registration.

Tests: the backend suite already boots Postgres, so pg-boss runs for real
under Vitest. Tests that end a session drain the queue or assert on rows, so
no test depends on a timer.

---

## Results

### When and from what

`endSession` in `packages/backend/src/graphql/resolvers/sessions/mutations.ts`
ends a session and then fire-and-forgets `autoSyncSessionToIntegrations`.
Workout completion belongs to `room-manager/session-discovery.ts`, where the
session is actually ended. A session advisory fence serializes attachment and
End; all participating users are locked before their connection rows. The same
transaction completes attached workouts and writes the webhook outbox. Results
are built on read, so subsequent tick edits and deletions remain visible.

Abandoned sessions need no new machinery. `endStaleInactiveSessions` in
`packages/backend/src/services/room-manager/room-manager.ts` already ends a
session after 60 minutes without activity. Its handler moves a `started`
workout to `auto_closed` in the same transaction.

The builder, `buildWorkoutResults(workoutId)` in
`packages/backend/src/services/public-api/workout-results.ts`, reads ticks for
the workout's session filtered to the workout's `user_id`, the way the
`sessionHealthExport` resolver does. A party session has other climbers'
ticks on it and none of those may reach an app. `generateSessionSummary` is
viewer-scoped too, but scoped to whoever is calling, which for an API request
is an app, not a climber; the builder takes the user id explicitly. Each tick
goes through the same serializer as the logbook feed, plus `blockIndex` from
`plan_snapshot`. Session notes, timezone and the private board name are
included only if `session.created_by_user_id === workout.user_id`; all three
are `null` for another climber's workout in a shared session. Public board
configuration remains available.

Building on read means a tick the climber edits or deletes after End shows
up correctly in the next `GET`, with no stored payload to invalidate. That next
`GET` is prompted: for seven days after End, a late, edited or deleted tick
re-sends `workout.completed` (`services/partner-webhooks/workout-results-changed.ts`,
described under "Webhooks" in `integration-platform.md`).

---

## Rolling it out

The mobile side sits behind `app-workouts` in `FEATURE_FLAG_DEFINITIONS`
(`packages/mobile/src/providers/feature-flags-provider.tsx`), default off,
with `EXPO_PUBLIC_APP_WORKOUTS=true` as the static-build override. Off, the
`/w/` route shows "not available yet" and does not stash the workout for a
later sign-in. Backend REST and workout GraphQL paths follow
`PARTNER_OAUTH_MODE`: `off` returns REST 404 or GraphQL `NOT_FOUND`; `hold`
refuses them as temporarily unavailable, and `allowlist`/`open` serve the implemented contract subject to
their usual authentication checks. REST calls require app bearer tokens and
workout scopes; first-party GraphQL requires the climber's credential, except
for the public app-name lookup. Publishing `workouts:*` in the shared contract
does not itself activate production access.

Implementation and remaining launch gates:

| Surface | Implemented | Remaining check |
| --- | --- | --- |
| Backend | Workout storage, REST routes, results, scopes, completion outbox and maintenance | Complete staged partner rollout and monitor worker registration before activation |
| Mobile | Link route, persisted active association, card, atomic Start, attachment and plan recovery | Real-device sign-in, cold-start, Resume and session-change QA with the flag enabled |
| Web | Public source app name, scheme/store links, no private workout content, `noindex` | Verify browser fallback and per-visitor lookup through deployed ingress |
| Android | `/w/` intent filter in app config | Ship and install a native build containing it; validate verified links |
| Advanced blocks | Honest freeform support | Native `fourByFour`, rep/set attribution and related pacing remain separate work |

Acceptance for milestone 3:

1. A backend test creates a workout with a native and a freeform block,
   starts a session with `appWorkoutId`, logs ticks from the climber and from
   a second climber in the same session, ends it, and `GET` returns only the
   climber's ticks with the right `blockIndex` values. Repeat a climb across
   two blocks and assert its ticks have `blockIndex: null`.
2. Replaying the create with the same `Idempotency-Key` returns the same
   response; a different body returns 422; a reused `externalRef` returns 409.
3. An abandoned session ends as `auto_closed` with results.
4. Disconnecting moves unfinished workouts to `revoked` and the old bearer
   receives 401; race creation and Start with disconnect, reconnect, and prove
   no revoked workout/event revives. Token-only revocation leaves the workout
   usable through another valid token from the same connection.
5. On a phone: tap a launch link signed out, sign in, land on the card; tap
   it signed in as another account, see the mismatch screen.

Telemetry, in `@boardsesh/analytics` `SHARED_EVENTS`: `App Workout Opened`,
`App Workout Started`, `App Workout Completed`, each with `clientId`,
`blockTypes`, `nativeBlockCount`, `freeformBlockCount`, and on Completed
`completion`. Per the board-render rule, never pool these across
`board_name`.

---

## What waits on the workouts epic

The contract promises a position within a block, rest adherence and an
effort rating "later". Concretely:

- `blockIndex` is an inference from the plan snapshot, with `null` for missing
  or ambiguous block matches; it is not exact for every native block. #5379 gave every queued climb a
  stage, but on the phone only (`docs/workout-stages.md` says why there is no
  wire field), so the server still cannot read a stage off a tick. Exact
  attribution needs the stage recorded on the tick itself; until then the
  snapshot is the source.
- Position within a 4x4 needs #5380: a queue that knows it is one climb done
  for every rep, set after set, and a tick that knows which rep and set it
  was. The field is added when that exists, not reserved as `null` before.
- Rest adherence (planned rest vs actual per block) needs both, plus the rest
  timer's arm state or fire times on the server. Today the timer is client-only
  (`rest-timer-store.ts` is deliberately not persisted). Apps can compute gaps
  between ticks from `climbedAt` meanwhile.
- RPE has no column anywhere. If we add it, it is a nullable field on
  `board_sessions` set from the end-session sheet, independent of the epic,
  and it goes into the results as optional `session.effort`.

None of these change a field that already exists.

---

## Open questions

- Can an app pass the climber's preferred grade scale on the workout, so the
  card leads with it? Results carry both scales regardless; this is display
  only.
- App-to-app consent. Once universal links are reliable on both platforms the
  consent screen could live in the app instead of the browser, which is a
  nicer flow when Boardsesh is installed. It also means the app would handle
  the browser consent continuation currently served at `/oauth/consent`,
  changing milestone 0's AASA exclusions. The authorization endpoint remains
  on the backend at `/api/auth/oauth2/authorize`; moving consent is a separate
  reviewed design, not a requirement of the Better Auth migration.
- Whether an app may create workouts for a climber who has never opened
  Boardsesh on a phone. Today the answer is yes (the row just sits at
  `created` until it expires), and that seems right.

## Related docs

- [partner-api.md](./partner-api.md), the contract this file implements (section 4)
- [integration-platform.md](./integration-platform.md), OAuth, scopes, the API, webhooks, roadmap
- [integration-consumers.md](./integration-consumers.md), what Sequence needs from workouts
- [better-auth-migration.md](./better-auth-migration.md), first-party sessions and device compatibility
- [workout-stages.md](./workout-stages.md), the stage model API blocks map onto
- [integrations.md](./integrations.md), the Strava export path
- [inferred-sessions.md](./inferred-sessions.md), why `board_sessions` is the
  only place a session lives
- [feature-flags.md](./feature-flags.md), the mobile flag catalog
- [db-migrations.md](./db-migrations.md), before generating the table above
