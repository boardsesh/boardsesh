# Board connection holder — "who's connected / writing to the wall"

Reference for the board-presence **connection holder**: the live indicator of who is currently connected to a climbing wall and writing climbs to it. Shipped GA (no feature flag). See also `docs/websocket-implementation.md` for the broader board-presence / party-session architecture.

## Model

A board's **holder** is the **emitter of its most recent confirmed send** — `userId` for a logged-in client, or `conn:{connectionId}` for an anonymous one. There is no separate "claim": connecting a phone and lighting a climb (which fires `reportBoardClimb`) makes you the holder. It is **always-take** — the latest send wins, and Aurora controllers are last-connection-wins, so one phone is physically connected at a time and there is **no write-gate**. The holder is a **display + take** concept, not a lock.

Display states (client):

- **active** — connected, recent send → lit lightbulb, holder's avatar (or "?" for an anonymous holder).
- **idle** — holder unchanged for > 15 min → avatar gains a "?" badge (single threshold, no ticking countdown).
- **free** — no holder → "tap to take" (the unlit lightbulb).

## Redis keys (`packages/backend/src/pubsub/index.ts`)

- `board:{boardId}:writer` → the current holder's emitter id. Set atomically by `setBoardWriter` (`SET … EX … GET` so concurrent sends detect only a real hand-off); cleared by `clearBoardWriterIf` (Lua compare-and-delete — only the current holder can clear it). TTL = `BOARD_MEMBERSHIP_TTL` (12 h). Redis-only: without Redis the holder degrades to "no holder".
- `presence:board:{boardId}:user:{emitterId}` → proof-of-presence membership stamp (gates who may emit; `NX`, stores first-seen for the durable-write dwell gate).

## GraphQL surface (`packages/shared-schema/src/schema/board-presence.ts`)

- `type BoardConnectionHolder { userId, displayName, avatarUrl, lastSentAt }` — anonymous holders carry nulls.
- `BoardConnectionChanged { holder: BoardConnectionHolder | null, seq }` — a member of the `BoardPresenceEvent` union streamed by `boardNowPlaying`. Published on a real hand-off (holder changed) and on clear (`holder: null`).
- `query boardConnection(boardId): BoardConnectionHolder` — late-joiner initial state.
- `mutation reportBoardClimb(boardId, climb, angle)` — report a confirmed send (sets the holder).
- `mutation reportBoardDisconnect(boardId)` — release this client's hold (lightbulb-off / BLE drop).

## Auth model

Board presence is **auth-optional** so anonymous web/mobile users are first-class:

- **Emit / connect**: `reportBoardClimb`, `reportBoardDisconnect`, `resolveBoardForConfig`, `resolveBoardForUuid` are auth-optional (anon keyed by `conn:{connectionId}`). Anon may only **bind existing** boards — `resolveBoardForConfig` is bind-only for anon (create-on-miss requires auth), `resolveBoardForUuid` resolves only public boards for anon. Serial resolution and board create/own stay auth-required.
- **Read (live feed)**: `boardNowPlaying`, `boardRecentClimbs`, `boardConnection` are anon-watchable but `requireAnonReadableBoard` restricts anonymous viewers to **public + system-shared** boards (so an anon can't enumerate ids to watch a private wall). Logged-in users keep membership-free reads. `boardHistory` and `boardPresenceStats` remain auth-required.
- Proof-of-presence (`hasBoardMembership`) gates emits; a 60 s dwell gate filters durable `board_climb_events` writes; all entry points are rate-limited.

## Crash backstop

The clean release path is the client calling `reportBoardDisconnect` on BLE drop (BLE survives a WS blip). As a backstop for a crashed holder, the WebSocket `onDisconnect` hook (`packages/backend/src/websocket/setup.ts`) calls `roomManager.clearBoardWriterForConnection`, which frees the wall via the emitter-keyed compare-and-delete. It runs at the single WS-close chokepoint (covering both solo `removeClient` and party `disconnectClient` holders) and is recorded per connection by `roomManager.noteBoardWriter` (called from `reportBoardClimb`).

## Clients

- **Shared** (`@boardsesh/board-presence` + `@boardsesh/board-presence-react`): the reducer tracks `holder` + `lastConnectionSeq` (seq-gated `APPLY_CONNECTION_CHANGED` / `SEED_CONNECTION`); `useBoardPresenceCurrent()` exposes `holder`; the client interface gains optional `fetchConnection` / `reportDisconnect`.
- **Mobile**: the play-drawer lightbulb is a **connect/disconnect toggle** (lit iff BLE connected) — connecting auto-pushes the climb and takes the board; pressing again disconnects and frees it. `BluetoothAutoSender` mounts on `isConnected` alone (no driver/preview write-gate). `BoardConnectionBadge` renders the holder beside the lightbulb. `reportBoardDisconnect` fires on explicit and unexpected BLE drops.

## Known limitations

- **Same-user multi-connection**: the writer is keyed by emitter, so if a logged-in user holds from two connections, either connection's drop frees the wall (re-acquired on the next send). Benign under always-take.
- **Anonymous `connectionId` is not stable across WS reconnects** — a blip briefly frees an anon hold, re-taken on the next send.
- **Anonymous WebSocket rate limiting** is per-connection (resettable by reconnecting); per-IP limiting is tracked in #2863.
