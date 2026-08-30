# Recently Climbed & Display Mode

## Context

Gyms running any Boardsesh-supported board want a passive screen — a smart TV in a browser pointed at a public URL — that shows the **board's** currently active climb plus a feed of the recent ones, including who sent and who logged a tick. This is a board-centric view, not a session-centric one: it should keep working even when no party session is active and even when several party sessions are sharing one physical board. The implementation is keyed on `userBoards` rows and treats the board type as a parameter, so any board family currently or eventually supported by Boardsesh works without code changes here.

We also have to close two loose ends that this feature depends on:

1. **Always send the user to the named-board route after BLE connect.** Most of this exists, but there is no enforcement when a user is on a generic `/[board_name]/...` route while their controller has a saved `userBoards` row. We need to force the redirect so that activity always carries a `boardUuid`.
2. **Let a gym owner claim a physical board.** Without ownership we cannot show the gym's name on the display, and we cannot stop random users from spoofing display events for someone else's hardware. The auth/email/token primitives are already in place — we just need a domain-validated claim flow.

## Scope

In scope:

- New per-board WebSocket channel `boardsesh:display:{boardUuid}` carrying `ClimbActivated` and `ClimbTickLogged` events.
- Postgres-persisted history table powering both the live feed and a "recent climbs" GraphQL query for cold loads.
- A public, no-auth `/b/{slug}/display` route rendered for big screens.
- A new **"Recently Climbed"** feed embedded on board pages (the user's "My Board" view and any board search result page), surfacing the same activity stream in a logbook-entry-style list with a stripped-down feed-card variant.
- Hook from `BluetoothAutoSender` to fire `ClimbActivated` (publishable **without** auth — see security note below).
- Hook from the existing `saveTick` path to fire `ClimbTickLogged` (always authenticated; honours the user's display-opt-out flag).
- Enforced BLE serial → `/b/{slug}` redirect on connect when a saved `userBoards` row matches the serial.
- Gym-owner board-claim flow: form → confirmation email to the gym domain → token verification → set `userBoards.gymId` + `ownerId`.

Explicitly **not** in scope (mentioned in the prompt as future):

- Multi-session boards proper. We will design the schema and event shape so a future "turn" button (each session can grab the display back) is a small, additive change. We will not build the UI yet — we will only make sure the channel key is `boardUuid`, not `sessionId`, so multi-session works later without a migration.

## Architectural Decisions

**Channel key is `boardUuid`, not `serialNumber`.** Stability is the reason: a board can swap controllers, and slugs can be renamed. UUID is the only stable identifier. (Serials are scanned/visible too, so they're also a weak choice for a public channel.)

**Display events are public on both ends.** No NextAuth token is required to subscribe to `boardsesh:display:{boardUuid}`. **`ClimbActivated` is also publishable without auth** — Web Bluetooth lets a logged-out user pair and send frames, and we don't want a logged-out climber's activations to vanish from the gym TV. Trade-off: the `recordBoardActivation` mutation is open to anyone with a `boardUuid`, which is a public identifier — anyone can therefore spoof activations for any board. Mitigations:

- Aggressive IP rate limit on the mutation (e.g., 12 req/min per IP — well above legitimate climbing pace, well below useful spam).
- The mutation persists `requesterIp` in `metadata.requesterIp` (jsonb) so we can review patterns and add per-board allowlists later.
- Anonymous activations always render as "Someone" on the TV; spoofing produces noise but cannot impersonate a specific climber.
- `ClimbTickLogged` is **always authenticated** — ticks are tied to a user's logbook, so the spoof vector doesn't apply.

If anonymous spoofing turns out to be a real abuse problem, the next step is a per-board ephemeral token issued at connect time (e.g., a short-lived JWT seeded from the controller's serial-derived secret); this is an additive change and not v1.

**Privacy posture on the wire.** Each user has an **opt-out** toggle in their profile, default **on** (visible). When opted out:

- `ClimbActivated` events still publish so the climb on the wall updates on the TV, but the wire payload omits `displayName`, `avatarUrl`, and `userId` (the activity row stores `userId` so we can still aggregate stats privately later, but the published event has nothing identifying).
- `ClimbTickLogged` events are **suppressed entirely** for opted-out users — their ascents do not appear on the TV feed at all.

This keeps the climb-on-wall responsive even for privacy-conscious climbers while honouring "don't show me on a public TV." Setting lives on the user record, not per-board, since this is a global preference about being shown on any gym TV.

**Persisting history is mandatory.** Persist in the same transaction as the publish so `FullSync` is never ahead of incremental events. One source of truth for both the WS subscriber's catch-up and a future GraphQL query.

**One feed table, not two.** A single `board_climb_activity` table with an `eventType` text column (not Postgres enum, so adding new event types like the future `turn` action is a no-op migration). A `metadata jsonb` column carries event-type-specific fields (e.g., the `turn` event will need session info). The first-class columns are only the ones we index on or filter by in the feed query.

**Only the device that actually wrote the frames over BLE may emit `ClimbActivated`.** This is the load-bearing constraint of the whole feature, not a corollary. The producer is gated on a _successful_ `sendFramesToBoard` call returning `result === true` for the specific `(climbUuid, boardUuid)` pair that just completed — i.e., the BLE GATT write to the controller actually happened on this device for this climb. Concretely:

- `setCurrentClimb` does **not** publish display events. A queue advance is observed by every party-session participant; if any of them emitted on observation, we'd get N duplicate events for one physical send, plus phantom events when a user advances their queue away from the wall with no BLE connection at all.
- Every client in a party session runs `BluetoothAutoSender` and reacts to `currentClimbQueueItem` changes, but only the one with an active BLE connection has `sendFramesToBoard` resolve truthy. Clients without a connection see `result` as falsy/undefined and **must not** call `recordBoardActivation`. Clients whose write was aborted (e.g., the user swiped past the climb mid-write — see `controller.signal.aborted` at `bluetooth-context.tsx:84`) also must not call it.
- This naturally serializes events across a session: only one device is BLE-connected to a given Aurora controller at a time, so only one device per physical send fires the mutation.
- Trade-off: a pure-mirror party session with no BLE pairing produces no display events. Acceptable — a session that never touched the board has nothing to show on a board-centric view.

**Gym claims are restricted, not advisory.** A claim only succeeds when (a) the board already has a `gymId`, and (b) the claimant email's domain matches the domain of `gyms.contactEmail` on that gym row. Boards without a `gymId` cannot be claimed through this flow — they need a gym row created via support first. User-entered website strings are **never** trusted as a domain source; the only trust anchor is the `gyms.contactEmail` value already stored on the gym row. This stops random users from claiming boards by clicking their own email link.

**BLE redirect is a hard redirect that preserves session state.** When connect resolves a serial to a saved `userBoards` row owned by the user and the current route is not the matching `/b/{slug}/...`, push to `/b/{slug}/{angle}/...` automatically. The board config (layout/size/setIds/angle) on the target route matches the source, so this is effectively a URL swap; the queue and current climb must survive it.

Preservation strategy: the queue is already persisted in IndexedDB via the existing `QueueProvider` and rehydrates on the new route's mount; the active party session is kept alive because the WS connection is owned by `BluetoothProvider`'s parent layout, not the page. We need an E2E test that asserts: queue items present pre-redirect → still present post-redirect; active climb pre-redirect → still active post-redirect.

## Database Changes

New migrations under `packages/db/drizzle/` (generated via `vp exec drizzle-kit generate` from `packages/db/`).

### `board_climb_activity`

```
id              bigserial PK
boardUuid       text  references userBoards.uuid (cascade)
climbUuid       text  not null
eventType       text  not null  -- 'activated' | 'ticked' | (future: 'turn')
                                -- text not enum so future event types don't need a Postgres enum migration
userId          text  references users.id (set null)  -- nullable for anonymous BLE sends or non-opted-in users
sessionId       text  references boardSessions.id (set null)
attemptStatus   text  -- only meaningful when eventType='ticked'; reuse the *exact* values from the existing tick schema (verify before generating migration)
angle           int   not null
mirrored        boolean not null default false
metadata        jsonb -- event-type-specific extras (future 'turn' events will store sessionId/grabbedBy here)
createdAt       timestamptz default now()

CHECK (attempt_status IS NULL OR event_type = 'ticked')
index (boardUuid, createdAt desc)  -- the feed query
index (boardUuid, climbUuid)        -- "how many times has this climb been ticked on this board"
```

`attemptStatus` values must be reconciled with the existing tick schema (look at whatever logbook entry table currently stores ticks before generating the migration — do not introduce a parallel vocabulary). We denormalize `boardUuid` so cascade-on-delete cleans history when a board is deleted.

### `users.show_on_board_displays` (column add)

Add boolean column on the existing `users` table, default `true`. Drives whether `ClimbActivated` events include the user's identity and whether `ClimbTickLogged` events publish at all for this user.

### `gym_board_claims`

```
id              bigserial PK
gymId           bigint references gyms.id (cascade)
boardUuid       text   references userBoards.uuid (cascade)
claimantEmail   text   not null
claimantUserId  text   references users.id  (nullable; set if claimant has an account)
token           text   not null
expires         timestamptz not null
domainMatched   boolean not null  -- did claimantEmail's domain match gym's known domain
verifiedAt      timestamptz
createdAt       timestamptz default now()

unique (token)
index (gymId, boardUuid) where verifiedAt is null
```

Mirrors the `verificationTokens` schema (UUID token, 24h expiry, single-use).

## Backend Changes

### Pub/Sub plumbing

`packages/backend/src/pubsub/redis-adapter.ts:12` — add `DISPLAY_CHANNEL_PREFIX = 'boardsesh:display:'`.

`packages/backend/src/pubsub/index.ts:290` — add `publishDisplayEvent(boardUuid, event)` modeled on `publishQueueEvent`. It must: (a) write to `board_climb_activity` in the same transaction as whatever caused the event, (b) then publish to the channel. Persistence-before-publish is required so `FullSync` is never ahead of incremental events.

### GraphQL schema

`packages/shared-schema/src/schema/`:

- New `boardDisplay.ts`: `DisplayEvent` union (`ClimbActivated`, `ClimbTickLogged`, `FullSync`), `DisplayActivityItem` type, `RecentlyClimbedCardData` type (the aggregated per-climb roll-up for the board-page feed), `boardDisplayUpdates(boardUuid: ID!)` subscription, `recentBoardActivity(boardUuid: ID!, limit: Int, before: DateTime)` query (returns aggregated cards), and `boardClimbActivityForClimb(boardUuid: ID!, climbUuid: ID!, limit: Int)` query (returns un-aggregated rows for the drawer).
- Wire into `subscriptions.ts` and `queries.ts` exports.

`packages/backend/src/graphql/resolvers/`:

- New `display/subscriptions.ts` — eager-subscribe pattern (mirror `queue/subscriptions.ts:14`), no `requireSessionMember` (this channel is public-read).
- New `display/queries.ts` — `recentBoardActivity` reads from `board_climb_activity` joined with `users` and `climbs` (board-type-specific table picked by `userBoards.boardType`).

### Producers

- A **new** mutation `recordBoardActivation(boardUuid, climbUuid, angle, mirrored)` is the only producer of `ClimbActivated`. **Unauthenticated callers are allowed** (Web Bluetooth permits anonymous send). The mutation is fired exclusively from `BluetoothAutoSender` after the BLE GATT write returns success for the specific climb (i.e., `sendFramesToBoard(...) === true` and the abort signal was not tripped). No other call site in the codebase may invoke it. `setCurrentClimb` does not publish display events.
- Resolver behavior:
  - Authenticated + opted-in: full identity fields on the wire (`userId`, `displayName`, `avatarUrl`).
  - Authenticated + opted-out: stripped wire payload; `userId` still persisted to the activity row for private aggregates (e.g., the user's own session view, future stats).
  - Unauthenticated: stripped wire payload; activity row gets `userId = null` and `metadata.requesterIp` for abuse review.
  - All callers go through the IP rate limiter described in the architecture decisions.
- `packages/web/app/lib/saveTick` (or whichever resolver actually writes a tick — needs concrete confirmation; see implementation-phase open questions) — after the tick is persisted, call `publishDisplayEvent(boardUuid, ClimbTickLogged)` **only if** the user has `show_on_board_displays = true`. Auth is mandatory for ticks. If `saveTick` lives on the Next.js side, the publisher is a small Redis-direct helper that uses the same channel name.

## Frontend Changes

### Display route

`packages/web/app/b/[board_slug]/display/page.tsx` (server component): resolve slug → `userBoards` row, fetch `recentBoardActivity` for the initial paint, render a client component that subscribes to `boardDisplayUpdates`. SEO: `noindex`.

Layout: large hold-rendered current climb on the left (must respect `mirrored`), feed of last ~15 events on the right, header shows gym name + board name when `gymId` is set, falls back to board name only when null. Use existing climb-rendering components from `packages/web/app/components/board-renderer/`.

**Reconnect/resume.** TVs aggressively sleep tabs; on visibility-restore the client must drop and re-establish the WS subscription, which triggers a fresh `FullSync` (mirroring the existing `queueUpdates` eager-subscribe pattern). The `recentBoardActivity` query result on `FullSync` is the source of truth on resume — incremental events buffered during sleep are discarded.

**Rate limit on the public query.** `recentBoardActivity` is an unauthenticated GraphQL query backed by an indexed table. Add an IP-based rate limit (reuse `packages/web/app/lib/auth/rate-limiter`) — e.g., 60 req/min per IP — to keep it from being a trivial DoS vector.

### "Recently Climbed" feed on board pages

A new section embedded on board pages — both the user's "My Board" view and any board search-result page that lands on `/b/{slug}` — showing the chronological activity stream in a logbook-style list. Implemented as a new component `packages/web/app/components/logbook/recently-climbed-feed.tsx` that reuses the existing `logbook-entry-card.tsx` (or a sibling card variant — see below) so styling stays consistent with the rest of the logbook UI.

**Data source.** The same `recentBoardActivity(boardUuid, limit, before)` GraphQL query that powers the TV display, but with a different aggregation: rather than one feed item per event, we collapse events into one card per _climb_ (keyed by `boardUuid + climbUuid`, ordered by most-recent activity), so a climb that's been activated 3 times and ticked twice that day shows as a single card. Aggregation happens server-side in the resolver to keep the wire payload small.

**Card variant — `RecentlyClimbedCard`.** A new component (sibling of `logbook-entry-card.tsx`, sharing the same outer layout primitives) tailored for this feed. Differences from the standard logbook card:

| Standard logbook card               | RecentlyClimbedCard                                                    |
| ----------------------------------- | ---------------------------------------------------------------------- |
| Shows the user's tries count        | Hidden                                                                 |
| Shows climb grade                   | Hidden                                                                 |
| Shows star ratings                  | Hidden                                                                 |
| Shows tick status icon for one user | Avatar group: senders' avatars + activator avatar (when not opted-out) |
| Single-user context                 | Multi-user roll-up                                                     |

The avatar group renders, in order: the activator (if they've opted in), then up to 4 senders ordered by most recent send, with a `+N` overflow chip if there are more. Each avatar shows a small badge corresponding to the highest-ranked tick status that user logged on this climb at this board (using the existing tick-status icon set from `packages/web/app/components/climb-actions/`).

**Avatar-group tap → drawer.** Tapping the avatar group opens an MUI `Drawer` (reuse the pattern from `packages/web/app/components/play-view/play-view-drawer.tsx`) that lists the underlying logbook entries — one row per `(user, eventType, createdAt)` — using the standard `logbook-entry-card.tsx` for each row. This is where the full per-user detail (tries, attempt status, timestamp) lives. Drawer content is fetched lazily via a `boardClimbActivityForClimb(boardUuid, climbUuid, limit)` query that returns un-aggregated rows.

**Embedding.**

- `packages/web/app/b/[board_slug]/page.tsx` (the board landing): add a `<RecentlyClimbedFeed />` section below the board info, before any "all climbs" listings.
- The "My Board" view (look up where the current user's owned/saved boards are rendered — likely under a profile or boards page) gets the same component instance.
- Board search results that link out to `/b/{slug}` already land on the new page; no changes to the search flow needed beyond ensuring the `/b/{slug}` page renders the feed.

**Pagination.** Cursor-based via the `before` argument on `recentBoardActivity`; "Load more" button at the bottom of the feed. Default page size 20 collapsed cards.

**Live updates.** When the user is on a board page that already shows the feed, subscribe to `boardDisplayUpdates(boardUuid)` to prepend new activity in real time (same subscription used by the TV). Drop subscription on unmount.

### Bluetooth send → display event

`packages/web/app/components/board-bluetooth-control/bluetooth-context.tsx:74` (`BluetoothAutoSender.sendClimb`): immediately after the existing `result === true` analytics block (and only there — same `controller.signal.aborted` check applies), fire the new `recordBoardActivation` mutation with the just-written climb's `climbUuid`, `angle`, and `mirrored` plus the resolved `boardUuid`. The same conditions that gate the success-analytics call gate the mutation: BLE write returned truthy _and_ the abort signal was not tripped. **No fallback path exists if the write fails or is aborted** — a failed/aborted send produces no display event because the board did not light up. This is the only call site of `recordBoardActivation` in the codebase; do not add others.

Concrete properties this gives us:

- Only the BLE-connected device emits — observers in the same party session do not, because their `sendFramesToBoard` does not resolve `true`.
- Rapid swiping (where the user advances past a climb before its write completes) does not emit, because the abort signal trips before the success branch runs.
- `boardUuid` resolution: under `/b/{slug}` the provider already has the saved-board UUID; under generic `/[board_name]/...` routes we fall back to the resolver entry recorded for the connected serial (`packages/web/app/api/internal/board-serials/route.ts`). If neither is available (legitimately new board with no recording yet), skip the mutation rather than guess.

### BLE-serial → named-board hard redirect

`packages/web/app/components/board-bluetooth-control/use-board-bluetooth.ts:291` (after `parseSerialNumber`): once the serial resolves to a `userBoards` row owned by the current user and the current route is **not** the matching `/b/{slug}/...`, call `router.push(buildSwitchUrl(...))` immediately. The target route has the same board config so the swap is a URL change only; queue (IndexedDB-backed) and active session (WS-backed at the layout level) survive.

E2E tests:

- Connect on generic route → assert URL becomes `/b/{slug}/...` within 1s.
- Pre-redirect: add 3 climbs to queue + set a current climb. Connect. Post-redirect: queue still has 3 climbs, current climb unchanged.
- Pre-redirect: in a party session. Connect. Post-redirect: still in the same session (same `sessionId`), other participants still visible.

### Gym claim form

`packages/web/app/b/[board_slug]/claim/page.tsx`: server component renders a form (claimant email only — the gym is identified by the board's existing `gymId`). On POST to a new `/api/gyms/claim` route:

1. Look up the `userBoards` row by slug.
2. If `gymId` is already set and verified, return 409.
3. Generate token (UUID), 24h expiry.
4. If the board has no `gymId`, reject the claim with a 400 explaining the gym must be created via support first. Otherwise, extract the domain from `claimantEmail` and compare it to the domain of `gyms.contactEmail` on the linked gym row. Reject the claim outright if the domains do not match — the `domainMatched` boolean is therefore always `true` on persisted rows; it remains in the schema only as defense-in-depth so the verify route can re-check.
5. Insert `gym_board_claims` row.
6. Send email via `packages/web/app/lib/email/email-service.ts` (already wired with Nodemailer) using a new `sendGymClaimEmail` template. Email body must escape user input (the existing `sendVerificationEmail` shows the pattern).
7. Rate limit: reuse `checkRateLimit('claim-board:' + clientIp, 5, 60_000)`.

Verification route `/api/gyms/claim/verify?token=...` mirrors `/api/auth/verify-email` (`packages/web/app/api/auth/verify-email/route.ts`):

- Validate token, check expiry, single-use (delete on success).
- Reject if `domainMatched` was `false` at claim time, or if board has no `gymId` — both should already be blocked at claim creation, but verify is defense-in-depth.
- In a transaction: set `userBoards.ownerId` to the claimant if they have an account; otherwise the claim sits in a `verified-but-unclaimed` state until the email signs up (NextAuth's credentials/oauth flow already keys on email).
- Redirect to `/b/{slug}` with a success toast.

Boards with no `gymId` cannot be claimed via this flow; users must email support to get a `gyms` row created first.

## Critical Files

- `packages/db/src/schema/app/board-activity.ts` (new) and re-export from `packages/db/src/schema/index.ts`.
- `packages/db/src/schema/app/gym-claims.ts` (new) similarly.
- `packages/backend/src/pubsub/redis-adapter.ts` (extend channel prefixes).
- `packages/backend/src/pubsub/index.ts` (`publishDisplayEvent`).
- `packages/backend/src/graphql/resolvers/display/{subscriptions,queries,mutations}.ts` (new).
- `packages/backend/src/graphql/resolvers/queue/mutations.ts` — **no display-event producer here.** Queue mutations like `setCurrentClimb` deliberately do not publish display events; users frequently advance the queue without being BLE-connected, so a queue advance is not a reliable signal that the board lit up. The BLE send path is the sole producer.
- `packages/shared-schema/src/schema/boardDisplay.ts` (new).
- `packages/web/app/components/board-bluetooth-control/bluetooth-context.tsx` (`BluetoothAutoSender` calls `recordBoardActivation`).
- `packages/web/app/components/board-bluetooth-control/use-board-bluetooth.ts` (post-connect redirect enforcement).
- `packages/web/app/b/[board_slug]/display/page.tsx` (new route — kiosk display).
- `packages/web/app/b/[board_slug]/page.tsx` (existing board landing — embed the new feed).
- `packages/web/app/components/logbook/recently-climbed-feed.tsx` (new — section component).
- `packages/web/app/components/logbook/recently-climbed-card.tsx` (new — card variant).
- `packages/web/app/components/logbook/recently-climbed-drawer.tsx` (new — avatar-tap drawer using existing `logbook-entry-card.tsx`).
- `packages/web/app/b/[board_slug]/claim/page.tsx` (new claim form).
- `packages/web/app/api/gyms/claim/route.ts`, `packages/web/app/api/gyms/claim/verify/route.ts` (new).
- `packages/web/app/lib/email/email-service.ts` (add `sendGymClaimEmail`).
- `packages/web/app/api/internal/board-serials/route.ts` (no change, but the redirect logic depends on the resolver it backs).

## Reused Components

- Logbook card baseline: `packages/web/app/components/logbook/logbook-entry-card.tsx` is reused as-is inside the avatar-tap drawer; `recently-climbed-card.tsx` borrows its outer layout primitives but strips tries/grade/stars in favour of the avatar group.
- Drawer pattern: `packages/web/app/components/play-view/play-view-drawer.tsx`.
- Tick-status icons: `packages/web/app/components/climb-actions/`.
- Climb rendering: `packages/web/app/components/board-renderer/` for the big-screen current-climb visual on the kiosk display.
- Email send: `sendVerificationEmail` in `email-service.ts` is the template pattern for `sendGymClaimEmail`.
- Token verification flow: `packages/web/app/api/auth/verify-email/route.ts` is the reference for `gyms/claim/verify`.
- Rate limiter: `packages/web/app/lib/auth/rate-limiter`.
- WS pub/sub publisher: `publishQueueEvent` in `packages/backend/src/pubsub/index.ts:290` is the reference for `publishDisplayEvent`.
- Eager-subscribe pattern: `packages/backend/src/graphql/resolvers/queue/subscriptions.ts:14`.
- BLE-redirect URL builder: `buildSwitchUrl` in `bluetooth-context.tsx:366` (already handles `/b/{slug}` vs traditional route).

## Verification

- **Unit**: pubsub test that `publishDisplayEvent` writes a row and emits on the right channel; resolver test that `recentBoardActivity` returns events in `createdAt desc`.
- **Integration**: backend test that `recordBoardActivation` produces a `ClimbActivated` event on `boardsesh:display:{boardUuid}` and persists a row to `board_climb_activity`; assert opted-out callers get a row with `userId` set but a wire payload with no identity fields (test infra already in `packages/backend/docker-compose.test.yml`).
- **E2E (Playwright, `packages/web/e2e/`)**:
  - Display page subscribes, then a second tab signs in and triggers a tick → display feed shows the tick within 2s.
  - Connect a controller (use the ESP32 emulator at `/development`) on a generic `/[board_name]/...` route → assert the URL becomes `/b/{slug}/...`.
  - Anonymous (logged-out) BLE send → display page receives a `ClimbActivated` rendered as "Someone".
  - Board page renders `RecentlyClimbedFeed`: send and tick on a climb from two different signed-in users → the climb shows as one collapsed card on the board page; tapping the avatar group opens the drawer with two `logbook-entry-card` rows.
  - Submit a board-claim form → assert email is intercepted by the test SMTP catcher (Mailpit/Inbucket — pick whichever the codebase already uses, or add Mailpit) → click verification link → assert `userBoards.gymId` is set.
- **Manual smoke on TV**: open `/b/{slug}/display` in Chrome on a smart TV, send three climbs from a phone, log one tick, confirm feed updates without page refresh.

## Resolved Decisions

- **Display privacy:** Profile-level **opt-out** toggle, default on. Opted-out users still trigger `ClimbActivated` (the climb shows on the wall TV) but the event payload omits identity fields; `ClimbTickLogged` is suppressed entirely.
- **Gym claim v1:** Restricted — board must already have a `gymId` and email domain must match the gym's known domain. New gyms via support out-of-band.
- **BLE redirect:** Hard redirect to `/b/{slug}/...` on connect; queue and active session must survive (covered by IndexedDB rehydrate + layout-owned WS).
- **Anonymous activations:** `recordBoardActivation` is unauthenticated; rate-limited by IP; renders as "Someone" on the wire. Mitigation for spoofing is the IP rate limit; future hardening via a per-board ephemeral token if abuse appears.
- **Recently Climbed feed:** New collapsed-card variant lives on board pages alongside the existing logbook UI; reuses `logbook-entry-card.tsx` inside the avatar-tap drawer.

## Open Questions for Implementation Phase

- **Where does `saveTick` actually live today?** Exploration showed it surfaced via BoardProvider; needs concrete confirmation before wiring the display publish (Next.js API vs GraphQL mutation determines whether the publisher lives on the web or backend side).
- **"My Board" page location.** Confirm the exact route/component used for "My Board" so the `RecentlyClimbedFeed` is dropped in the right place (likely under a profile or boards list page; not yet pinned down in this exploration).
- **Test SMTP catcher.** No local-dev SMTP catcher in the repo today. Suggest adding Mailpit to `docker-compose.dev.yml` for the claim-flow E2E.
- **`attemptStatus` vocabulary.** Reconcile against the existing tick/logbook schema before the migration is generated — do not introduce a parallel enum.
- **ESP32 emulator fixtures.** Confirm the emulator's serials match real `userBoards` rows in the test DB so the redirect E2E actually exercises the resolver.
- **Aggregation window for `RecentlyClimbedCard`.** Collapsing all activity for a `(boardUuid, climbUuid)` into one card forever loses the "this climb was climbed yesterday" vs "today" distinction. Consider bucketing by day, or a configurable max-age before a climb gets a fresh card. Default proposal: a single rolling card per climb capped at the last 7 days of activity; older activity is excluded from the aggregate but visible in the drawer.
