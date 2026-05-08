# WebSocket Implementation for Party Sessions

This document describes the WebSocket implementation used for real-time party session synchronization in Boardsesh. Party mode allows multiple climbers to collaborate on a shared queue of climbs, with real-time synchronization across all connected clients.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Technology Stack](#technology-stack)
3. [Connection Flow](#connection-flow)
4. [Backend URL Resolution](#backend-url-resolution)
5. [Session Management](#session-management)
6. [Queue State Synchronization](#queue-state-synchronization)
7. [Multi-Instance Support](#multi-instance-support)
8. [Failure States and Recovery](#failure-states-and-recovery)
9. [Client-Side Connection Supervisor](#client-side-connection-supervisor)
10. [Data Persistence Strategy](#data-persistence-strategy)
11. [Native iOS WebSocket Client](#native-ios-websocket-client)

---

## Architecture Overview

The party session system uses a GraphQL-over-WebSocket architecture with the following key components:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Frontend (Next.js)                          │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────┐    ┌─────────────────────────────────────────┐ │
│  │ PersistentSession   │◄───┤ GraphQL Client (graphql-ws)             │ │
│  │ Context (split)     │    │ - Connection management                  │ │
│  │ ├ ActionsContext     │    │ - Subscription handling                  │ │
│  │ └ StateContext       │    │ - Reconnection with exponential backoff  │ │
│  └─────────┬───────────┘    └─────────────────────────────────────────┘ │
│            │                                                             │
│  ┌─────────▼───────────┐                                                 │
│  │ QueueContext (split) │                                                │
│  │ ├ ActionsContext     │                                                │
│  │ │  (stable callbacks)│                                                │
│  │ └ DataContext        │                                                │
│  │   - Local state      │                                                │
│  │   - Optimistic update│                                                │
│  └──────────────────────┘                                                │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ WebSocket (graphql-ws protocol)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Backend (Node.js)                              │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────┐    ┌─────────────────────┐                     │
│  │ WebSocket Server    │    │ GraphQL Yoga        │                     │
│  │ (graphql-ws)        │◄───┤ - Schema            │                     │
│  │ - Auth validation   │    │ - Resolvers         │                     │
│  │ - Connection mgmt   │    └─────────────────────┘                     │
│  └─────────┬───────────┘                                                 │
│            │                                                             │
│  ┌─────────▼───────────┐    ┌─────────────────────┐                     │
│  │ RoomManager         │◄───┤ PubSub              │                     │
│  │ - Session state     │    │ - Local dispatch    │                     │
│  │ - Client tracking   │    │ - Redis pub/sub     │                     │
│  └─────────┬───────────┘    └─────────────────────┘                     │
│            │                                                             │
│  ┌─────────▼─────────────────────────────────────────────────────────┐  │
│  │ DistributedStateManager (multi-instance support)                   │  │
│  │ - Cross-instance connection tracking                               │  │
│  │ - Distributed leader election (Lua scripts)                        │  │
│  │ - Session membership across instances                              │  │
│  │ - Instance heartbeating & cleanup                                  │  │
│  └─────────┬─────────────────────────────────────────────────────────┘  │
│            │                                                             │
│  ┌─────────▼───────────┐    ┌─────────────────────┐                     │
│  │ RedisSessionStore   │    │ PostgreSQL          │                     │
│  │ - Hot cache (4h TTL)│    │ - Persistent storage│                     │
│  │ - User presence     │    │ - Session history   │                     │
│  │ - Distributed locks │    │ - Queue state       │                     │
│  └─────────────────────┘    └─────────────────────┘                     │
└─────────────────────────────────────────────────────────────────────────┘
```

### Context Split Pattern

Both `PersistentSessionContext` and `QueueContext` are split into separate **Actions** and **Data** contexts to prevent unnecessary re-renders:

- **ActionsContext** — stable callback functions (`addToQueue`, `setMyPick`, `claimTurn`, etc.). Uses a `latestRef` pattern so callbacks have empty `[]` dependency arrays and never change identity. Components that only call actions (e.g., list item "add to queue" buttons) subscribe here and avoid re-rendering when queue data changes.
- **DataContext** — frequently-changing state (`queue`, `currentClimb`, `connectionState`, etc.). Only components that display this data subscribe here.
- **Combined Context** — merges both via `useMemo(() => ({ ...dataValue, ...actionsValue }))` for backward compatibility. Existing consumers using `useQueueContext()` or `usePersistentSession()` continue working unchanged.

Targeted hooks: `useQueueActions()`, `useQueueData()`, `usePersistentSessionActions()`, `usePersistentSessionState()`.

### QueueBridgeProvider — root-level QueueContext

`QueueBridgeProvider` (`packages/web/app/components/queue-control/queue-bridge-context.tsx`) is mounted once at the root inside `PersistentSessionWrapper` so a `QueueContext` value is always available, even off board routes (e.g. `/you/logbook`, `/session/[sessionId]`, `/playlists/...`). It has two modes:

- **Injected mode** — when a board route mounts `GraphQLQueueProvider`, it injects its full context (with the GraphQL data fetcher and reducer) into the bridge. Consumers transparently see the board route's queue context.
- **Adapter mode** — off board routes, `usePersistentSessionQueueAdapter` fronts the persistent session directly. Mutations now branch on `ps.activeSession`:
  - **Solo / no party**: mutations go through `setLocalQueueState` (in-memory, no persistence beyond the session restore on reload).
  - **Active party session**: queue planning mutations still delegate to `ps.addQueueItem`, `ps.removeQueueItem`, `ps.setQueue`, `ps.mirrorCurrentClimb`, and `ps.replaceQueueItem`. Climb browsing delegates to `ps.setMyPick`, while wall ownership delegates to `ps.claimTurn` / `ps.yieldTurn`. `setLocalQueueState` is a no-op when `activeSession` is set, so without this delegation off-board taps would silently disappear.
  - `setCurrentClimb` checks for an existing queue entry by `climb.uuid` first; if found it reuses that queue item, but in an active party session the result is written as the caller's pick rather than directly changing `currentClimbQueueItem`.
  - Items created by the adapter populate `addedBy` / `addedByUser` from `usePartyProfile` so peers see consistent attribution regardless of which surface added the climb.
  - Optimistic pick state is keyed by the session connection id (`SessionUser.id` / `clientId`) first, because the backend publishes pick and active-climber events with that live participant id.

## Technology Stack

| Component          | Technology                        | Purpose                                                       |
| ------------------ | --------------------------------- | ------------------------------------------------------------- |
| WebSocket Protocol | `graphql-ws`                      | GraphQL subscriptions over WebSocket                          |
| Backend Framework  | GraphQL Yoga                      | HTTP + WS GraphQL server                                      |
| Frontend Client    | `graphql-ws` client               | Connection management                                         |
| Pub/Sub            | Redis (subscriber connection)     | Multi-instance event distribution                             |
| Hot Cache          | Redis (publisher connection)      | Real-time session state (4h TTL)                              |
| Stream Consumer    | Redis (streamConsumer connection) | Dedicated connection for blocking `XREADGROUP` in EventBroker |
| Persistent Storage | PostgreSQL                        | Durable session & queue history                               |

**Redis Connection Architecture:** The backend maintains 3 Redis connections:

1. **Publisher** — shared by RoomManager, RedisSessionStore, DistributedState, EventBroker (non-blocking ops like `xadd`, `xack`)
2. **Subscriber** — dedicated to ioredis pub/sub mode (enters special subscribe-only mode)
3. **Stream Consumer** — dedicated to EventBroker's blocking `XREADGROUP BLOCK 5000` loop, preventing it from starving the publisher connection

---

## Connection Flow

### Initial Connection Sequence

```mermaid
sequenceDiagram
    participant C as Client
    participant WS as WebSocket Server
    participant A as Auth Middleware
    participant RM as RoomManager
    participant R as Redis
    participant PG as PostgreSQL

    C->>WS: WebSocket Connect (origin check)
    WS->>WS: Verify origin
    WS->>C: Connection Accepted

    C->>WS: ConnectionInit (with authToken)
    WS->>A: validateNextAuthToken(token)
    A-->>WS: userId (or null)
    WS->>RM: registerClient(connectionId)
    RM-->>WS: Client registered
    WS->>C: ConnectionAck

    C->>WS: Execute joinSession mutation
    Note over C,WS: With optional initialQueue & initialCurrentClimb
    WS->>RM: joinSession(connectionId, sessionId, boardPath, initialQueue?)

    alt Session exists in memory
        RM->>RM: Add client to session
        Note over RM: initialQueue ignored (session has state)
    else Session exists in Redis (warm cache)
        RM->>R: getSession(sessionId)
        R-->>RM: Session data
        RM->>RM: Restore to memory
        Note over RM: initialQueue ignored (restored state)
    else Session exists in Postgres (dormant)
        RM->>PG: SELECT session, queue
        PG-->>RM: Session data
        RM->>R: saveSession()
        RM->>RM: Restore to memory
        Note over RM: initialQueue ignored (restored state)
    else New session
        RM->>PG: INSERT session
        RM->>R: saveSession()
        RM->>RM: Create in memory
        alt Has initialQueue
            RM->>RM: Initialize queue with provided items
            RM->>PG: INSERT queue state (immediate)
            RM->>R: Save queue state
        end
    end

    RM-->>WS: {clientId, users, queueState, isLeader}
    WS-->>C: joinSession response

    C->>WS: Subscribe queueUpdates
    WS->>WS: Subscribe FIRST (eager)
    WS->>R: Subscribe to Redis channel
    WS->>RM: getQueueState()
    WS->>C: FullSync event
    WS->>C: Stream incremental events

    C->>WS: Subscribe sessionUpdates
    WS->>C: Stream session events
```

### Key Points

1. **Origin Validation**: WebSocket connections are validated against allowed origins
2. **Authentication**: Optional auth token passed in `connectionParams`
3. **Eager Subscription**: Queue subscription starts BEFORE fetching state to prevent race conditions
4. **Session Restoration**: Sessions can be restored from Redis (warm cache) or PostgreSQL (dormant durable state)
5. **Initial Queue Seeding**: When creating a new session, clients can provide `initialQueue` and `initialCurrentClimb` to seed the session with an existing local queue (e.g., when starting party mode with climbs already queued)

### Initial Queue Seeding

When a user starts party mode while they already have climbs in their local queue, the client sends the existing queue along with the `joinSession` mutation. This ensures users don't lose their queued climbs when transitioning to party mode.

**GraphQL Mutation Parameters:**

```graphql
mutation JoinSession(
  $sessionId: ID!
  $boardPath: String!
  $username: String
  $avatarUrl: String
  $initialQueue: [ClimbQueueItemInput!]    # Optional: existing queue items
  $initialCurrentClimb: ClimbQueueItemInput # Optional: current climb
  $sessionName: String                      # Optional: display name for the session
) {
  joinSession(
    sessionId: $sessionId
    boardPath: $boardPath
    username: $username
    avatarUrl: $avatarUrl
    initialQueue: $initialQueue
    initialCurrentClimb: $initialCurrentClimb
    sessionName: $sessionName
  ) { ... }
}
```

**Behavior:**

- `initialQueue`, `initialCurrentClimb`, and `sessionName` are **only applied when creating a new session**
- If joining an existing session (active, warm, or dormant), these values are ignored and the existing session state is used
- The queue is persisted immediately to Postgres (not debounced) to ensure durability for new sessions
- All users who join after the initial seed will receive the seeded queue state

**Client Flow (PersistentSessionContext):**

1. User calls `startSession()` which generates a new session ID
2. Client stores current queue in `pendingInitialQueue` via `setInitialQueueForSession()`
3. On WebSocket connection, the `joinSession` mutation includes the initial queue data
4. Server initializes the new session with the provided queue items
5. Client clears `pendingInitialQueue` after successful join

### Session Path Continuity

The WebSocket connection should remain stable when users navigate within the same board configuration. This is controlled by the **base board path** concept.

**URL Structure:**

```
/{board}/{layout}/{size}/{sets}/{angle}/{view}/{climb}
  │       │        │      │      │       │       │
  └───────┴────────┴──────┴──────┴───────┴───────┴──── Dynamic segments
  │       │        │      │      │
  └───────┴────────┴──────┴──────┴──────────────────── Base board path (session identity)
```

**What triggers session reconnection:**
| Change Type | Reconnects? | Reason |
|-------------|-------------|--------|
| Different board (kilter vs tension) | ✅ Yes | Different physical board |
| Different layout | ✅ Yes | Different hold arrangement |
| Different size | ✅ Yes | Different board dimensions |
| Different sets | ✅ Yes | Different hold selection |
| Different angle | ❌ No | Board angle is adjustable during session |
| Different view (/list, /play, /create) | ❌ No | Just navigation state |
| Different climb (in /play view) | ❌ No | Just viewing different climb |

**Implementation:**
The `getBaseBoardPath()` utility in `url-utils.ts` extracts the stable board configuration path by stripping:

- `/play/[climb_uuid]` - climb being viewed
- `/view/[climb_slug]` - climb detail view
- `/list`, `/create` - view type
- `/{angle}` - board angle (numeric segment at end)

This ensures `BoardSessionBridge` only calls `activateSession()` when the actual board configuration changes, not when users swipe between climbs or adjust the board angle.

---

## Backend URL Resolution

The WebSocket backend URL is resolved at runtime by `packages/web/app/lib/backend-url.ts` rather than relying solely on the build-time `NEXT_PUBLIC_WS_URL` environment variable. This is necessary because branch deploy previews serve a single build from multiple domains, and a hard-coded URL only works for one of them.

### Preview Domain Pattern

Branch deploy previews use per-PR subdomains:

| Service      | Domain pattern                 | Example (PR #42)              |
| ------------ | ------------------------------ | ----------------------------- |
| Web frontend | `{N}.preview.boardsesh.com`    | `42.preview.boardsesh.com`    |
| WS backend   | `{N}.ws.preview.boardsesh.com` | `42.ws.preview.boardsesh.com` |

The runtime resolver maps the frontend hostname to the backend:

```
42.preview.boardsesh.com  →  wss://42.ws.preview.boardsesh.com/graphql
```

### Client-Side Resolution Order

`getBackendWsUrl()` checks these sources in order and returns the first match:

1. **Host-derived URL** -- if the page hostname matches `{N}.preview.boardsesh.com`, the backend URL is derived automatically. No build-time config needed.
2. **`NEXT_PUBLIC_WS_URL` build-time fallback** -- the standard env var baked into the Next.js client bundle at build time. Used for production (`boardsesh.com`) and any hostname that doesn't match a known pattern.

On the server side (SSR), only the build-time env var is used.

### Preview Deploy Infrastructure

```
                                Internet
                                   │
                       ┌───────────▼───────────┐
                       │   Main Traefik Proxy   │
                       │  (boardsesh.com infra) │
                       └───────┬───────┬────────┘
                               │       │
        *.preview.boardsesh.com│       │*.ws.preview.boardsesh.com
                               │       │
                       ┌───────▼───────▼────────┐
                       │  Branch-Deploy VM       │
                       │  Traefik Proxy          │
                       └───────┬───────┬────────┘
                               │       │
                    ┌──────────▼──┐ ┌──▼──────────┐
                    │ PR #42 Web  │ │ PR #42 WS   │
                    │ Container   │ │ Container    │
                    └─────────────┘ └──────────────┘
```

The main Traefik instance routes `*.preview.boardsesh.com` and `*.ws.preview.boardsesh.com` traffic to a dedicated branch-deploy VM. A second Traefik instance on that VM routes to the per-PR containers using the numeric prefix as the routing key.

### Local dev: WSS via Tailscale cert

`vp run dev` will provision a TLS cert for your Tailscale hostname (one-time, via `tailscale cert`) and start both the Next.js web server and the backend over HTTPS/WSS. That lets real phones on your tailnet hit the dev backend in a secure context — required for shake-to-feedback (DeviceMotion), Web Bluetooth, clipboard, etc.

- Cert cache: `$XDG_CACHE_HOME/boardsesh-dev-certs/<host>.{crt,key}` (fallback `~/.cache/...`), refreshed after 24h.
- Backend flip: `packages/backend/src/server.ts` reads `DEV_HTTPS_CERT_FILE` / `DEV_HTTPS_KEY_FILE` and, when both are present, uses `https.createServer(...)` so WS upgrades ride `wss://` on the same server.
- Web flip: the orchestrator sets the same env vars + `TAILSCALE_HOSTNAME` for the web dev script, which switches `NEXT_PUBLIC_WS_URL` / `NEXTAUTH_URL` / `BASE_URL` to `https://` / `wss://` and passes `--experimental-https --experimental-https-cert --experimental-https-key` to `next dev`.
- Fallback: any failure (Tailscale not installed, not logged in, tailnet missing the HTTPS Certificates feature, operator-permission denied) prints a targeted hint and continues on plain HTTP, so non-Tailscale devs are unaffected. Prod/branch-preview flow above is unchanged.

---

## Session Management

### Session Lifecycle States

```
                    ┌─────────────────────────────────────┐
                    │              Created                │
                    │  - Optional: goal, color, boardIds │
                    │  - Optional: isPermanent flag      │
                    │  - startedAt set on creation       │
                    └──────────────┬──────────────────────┘
                                   │ First user joins
                                   ▼
    ┌──────────────────────────────────────────────┐
    │                   ACTIVE                     │
    │  - Users connected                           │
    │  - Real-time sync enabled                    │
    │  - Redis cache hot                           │
    │  - In-memory session state                   │
    └──────┬───────────────────────┬───────────────┘
           │ Last user leaves      │ Leader calls endSession
           ▼                       ▼
    ┌──────────────────────────┐   ┌──────────────────────────────┐
    │   GRACE PERIOD (60s)     │   │     ENDED (explicit)         │
    │  - No connected users    │   │  - endedAt set               │
    │  - In-memory state       │   │  - Summary generated         │
    │    retained              │   │  - SessionEnded event sent   │
    │  - Redis session kept    │   │  - Removed from Redis        │
    │  - Postgres row not ended│   │  - Postgres record kept      │
    └────────┬──────┬──────────┘   └──────────────────────────────┘
             │      │ 60s expires
             │      ▼
             │   ┌──────────────────────────────┐
             │   │      WARM (Redis only)       │
             │   │  - In-memory state deleted   │
             │   │  - Redis cache retained (4h) │
             │   │  - Rejoin restores from      │
             │   │    Redis back into memory    │
             │   └──────────┬───────────────────┘
             │              │ Redis TTL expires
             │              ▼
             │   ┌──────────────────────────────┐
             │   │    DORMANT (Postgres only)   │
             │   │  - Redis entry expired       │
             │   │  - Postgres row still active │
             │   │  - Rejoin restores from      │
             │   │    Postgres while status     │
             │   │    is not 'ended'            │
             │   └──────────────────────────────┘
             │
             │ User rejoins within grace
             ▼
    ┌────────────────────┐
    │  Back to ACTIVE    │
    │  (no restoration   │
    │   needed)          │
    └────────────────────┘
```

**Grace Period:** When the last user disconnects, the session enters a 60-second grace period where in-memory state is preserved. If a client reconnects within this window (common during network flaps or page refreshes), the session is instantly available without the expensive lock + Redis/Postgres restoration cycle. The grace period duration is controlled by `SESSION_GRACE_PERIOD_MS` in `RoomManager`.

If the grace period expires, the session is evicted from memory but remains restorable from Redis until the 4-hour TTL expires. After Redis TTL expiry, the session is still not ended; the next join restores it from Postgres as long as the durable row has not been explicitly marked `ended`.

### Session Properties

Sessions support the following configurable properties set at creation time:

| Property      | Type      | Description                                                                            |
| ------------- | --------- | -------------------------------------------------------------------------------------- |
| `goal`        | `String?` | Free-text session goal (max 500 chars), displayed in the session header                |
| `color`       | `String?` | Hex color code for multi-session display (e.g., `#FF5722`)                             |
| `isPermanent` | `Boolean` | Optional flag for long-lived kiosk-style sessions, persisted with the session metadata |
| `isPublic`    | `Boolean` | Whether the session appears in discovery (default: true)                               |
| `boardIds`    | `[Int]?`  | Multi-board support — links session to specific boards within a gym                    |

### Session Ending and Summaries

Sessions only end when a client explicitly calls `endSession`. Last-user disconnects, grace-period expiry, and Redis TTL expiry do not mark a session as ended; they only evict hot state and force later restoration from Redis or Postgres.

When a session ends via `endSession`:

- `endedAt` timestamp is recorded in Postgres
- A `SessionEnded` event is broadcast to all connected clients
- A `SessionSummary` is generated and returned to the caller

**Session Summary** includes:

- Total sends and attempts across all participants
- Grade distribution (sends grouped by difficulty grade)
- Hardest climb sent (with climb name and grade)
- Per-participant stats (sends, attempts, display name, avatar)
- Session duration (calculated from `startedAt` to `endedAt`)
- Session goal (if set)

The frontend displays the summary in a dialog when the session ends, and optionally as a feed item in the activity feed.

### Multi-Board Sessions

Sessions can be linked to multiple boards within the same gym via the `sessionBoards` junction table. This is validated at creation time:

- All `boardIds` must exist in the `userBoards` table
- All boards must belong to the same gym (different gyms are rejected)

### Leader Election

Leader election uses Redis-backed atomic operations for consistency across instances:

**Single Instance Mode:**

- First client to join becomes leader
- On leader disconnect, earliest connected client is elected

**Multi-Instance Mode (Distributed):**

- Uses Lua scripts for atomic leader election
- Leader stored in Redis: `boardsesh:session:{id}:leader`
- Consistent across all backend instances

```mermaid
sequenceDiagram
    participant U1 as User 1 (Leader)
    participant U2 as User 2 (Instance 2)
    participant RM as RoomManager
    participant DS as DistributedState
    participant R as Redis
    participant PS as PubSub

    Note over U1,PS: User 1 is current leader

    U1->>RM: disconnect()
    RM->>DS: leaveSession(connectionId, sessionId)
    DS->>R: Execute ELECT_NEW_LEADER Lua script
    R->>R: Find earliest connected member
    R->>R: SET leader key atomically
    R-->>DS: newLeaderId = U2
    DS-->>RM: {newLeaderId: U2}
    RM->>PS: publishSessionEvent(LeaderChanged)
    PS->>U2: LeaderChanged{leaderId: U2}

    Note over U2: User 2 is now leader (on Instance 2)
```

**Lua Script Atomicity:**

```lua
-- ELECT_NEW_LEADER_SCRIPT
-- Gets all session members, filters out leaving connection
-- Sorts by connectedAt, picks earliest
-- Atomically sets new leader
```

### Session Update Events

`sessionUpdates(sessionId)` emits membership/lifecycle events and live stats updates.

| Event                 | When emitted                                | Key fields                                                                                                                                                        |
| --------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UserJoined`          | A client joins the session                  | `user`                                                                                                                                                            |
| `UserLeft`            | A client disconnects/leaves                 | `userId`                                                                                                                                                          |
| `LeaderChanged`       | Leader election selects a new leader        | `leaderId`                                                                                                                                                        |
| `SessionEnded`        | Session is ended explicitly or by cleanup   | `reason`, `newPath`                                                                                                                                               |
| `SessionStatsUpdated` | A tick is saved for an active party session | `totalSends`, `totalFlashes`, `totalAttempts`, `tickCount`, `participants`, `gradeDistribution`, `boardTypes`, `hardestGrade`, `durationMinutes`, `goal`, `ticks` |

`SessionStatsUpdated` payloads include full `ticks` rows so clients can update charts and climbs/attempt lists without issuing an extra session detail refetch. On the client, `useEventProcessor` patches the `SESSION_DETAIL_QUERY_KEY(sessionId)` React Query cache entry directly with the new stats and ticks — there is no separate `liveSessionStats` merge layer, so any component subscribed via `useSessionDetail` re-renders from the updated cache automatically.

---

## Queue State Synchronization

### Event Types

| Event                  | Description                                   | Fields                                                            |
| ---------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| `FullSync`             | Complete state snapshot                       | `sequence`, `state` (queue, current climb, picks, active climber) |
| `QueueItemAdded`       | Item added to queue                           | `sequence`, `item`, `position`                                    |
| `QueueItemRemoved`     | Item removed from queue                       | `sequence`, `uuid`                                                |
| `QueueReordered`       | Item moved in queue                           | `sequence`, `uuid`, `oldIndex`, `newIndex`                        |
| `CurrentClimbChanged`  | Board climb changed                           | `sequence`, `item`, `clientId`, `correlationId`                   |
| `ClimbMirrored`        | Mirror state toggled                          | `sequence`, `mirrored`                                            |
| `PickChanged`          | A participant's personal pick changed         | `sequence`, `userId`, `pick`, `correlationId`                     |
| `ActiveClimberChanged` | The participant controlling the board changed | `sequence`, `userId`, `correlationId`                             |
| `BoardSendAdded`       | A climb was appended to board history         | `sequence`, `boardSend`                                           |

### Queue Mutations

| Mutation                   | Event emitted                                                     | Notes                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addQueueItem`             | `QueueItemAdded`                                                  | Appends to queue or inserts at `position`. Idempotent on `item.uuid` — duplicate adds are collapsed server-side during offline reconciliation.                                                                                                                                                                                  |
| `removeQueueItem`          | `QueueItemRemoved`                                                | Removes by queue-item uuid. The server should reject attempts to remove another participant's plan-ahead item unless a future host/owner policy explicitly allows it.                                                                                                                                                           |
| `reorderQueue`             | `QueueReordered`                                                  | Moves a queue item to a new index. The server should apply the same ownership check as remove.                                                                                                                                                                                                                                  |
| `setCurrentClimbQueueItem` | `CurrentClimbChanged`                                             | Legacy/programmatic board activation by queue-item uuid. The web party-session UI should route browsing through `setMyPick` instead.                                                                                                                                                                                            |
| `setCurrentClimb`          | `CurrentClimbChanged` + `QueueItemAdded`                          | Legacy/solo/programmatic board activation. In party-session UI flows, this is wrapped as `setMyPick` so non-active climbers can browse without changing the board.                                                                                                                                                              |
| `setMyPick`                | `PickChanged`, plus board-send events when caller is active       | Updates the caller's personal pick. If the caller is active, the server also mirrors the pick to `currentClimbQueueItem` and emits `CurrentClimbChanged` + `BoardSendAdded`.                                                                                                                                                    |
| `claimTurn`                | `ActiveClimberChanged` + `CurrentClimbChanged` + `BoardSendAdded` | Makes the caller's existing pick active on the board. Requires the caller to already have a pick. Idempotent when already active; it re-sends the same climb to the board for LED recovery.                                                                                                                                     |
| `yieldTurn`                | `ActiveClimberChanged` + `CurrentClimbChanged` + `BoardSendAdded` | Hands the board to another participant's existing pick. `toUserId` is the live session participant id, not the stable auth user id.                                                                                                                                                                                             |
| `clearMyPick`              | `PickChanged`, and sometimes `ActiveClimberChanged`               | Clears the caller's pick. If the caller was active, active climber becomes `null`.                                                                                                                                                                                                                                              |
| `replaceQueueItem`         | `FullSync`                                                        | Replaces the climb inside an existing queue slot in place, preserving position and the queue-item uuid. Used by the create-climb form to push saves of the currently-authored climb to peers without reshuffling the queue. Emits `FullSync` rather than a narrow delta because replace is infrequent and simpler to reconcile. |
| `mirrorCurrentClimb`       | `ClimbMirrored`                                                   | Flips the mirror flag on the current board climb.                                                                                                                                                                                                                                                                               |
| `setQueue`                 | `FullSync`                                                        | Bulk replaces queue + current climb. Used for offline to online reconciliation.                                                                                                                                                                                                                                                 |

### Collaborative Picks and Active Climber

Party sessions now separate "what I am browsing" from "what is on the board":

- `QueueState.currentClimbQueueItem` is the climb currently on the LEDs. The queue control bar and controller subscriptions should keep using this field.
- `QueueState.picks` is the per-participant browsing state. Climb lists, play-view edit mode, and the avatar drawer should show the current user's pick from this list.
- `QueueState.activeClimberUserId` identifies which participant's pick is mirrored to `currentClimbQueueItem`. If the active climber swipes, `setMyPick` changes both their pick and the board climb. If a non-active climber swipes, only their pick changes.

Pick and active-climber identity uses the live WebSocket session participant id (`SessionUser.id`, also returned from `joinSession` as `clientId`). `SessionUser.userId` is the stable authenticated profile id and is useful for attribution/profile display, but it is not the key used by `PickChanged.userId`, `ActiveClimberChanged.userId`, `claimTurn`, or `yieldTurn`.

Because `PickChanged.userId` is `ID!` and `ActiveClimberChanged.userId` is nullable `ID`, GraphQL validation rejects selecting both under the same response name in one union operation. Client operations must alias the active climber field in both `queueUpdates` and `eventsReplay`:

```graphql
subscription QueueUpdates($sessionId: ID!) {
  queueUpdates(sessionId: $sessionId) {
    __typename
    ... on PickChanged {
      sequence
      userId
      pick {
        uuid
      }
      correlationId
    }
    ... on ActiveClimberChanged {
      sequence
      activeClimberUserId: userId
      correlationId
    }
    ... on BoardSendAdded {
      sequence
      boardSend {
        id
        climbUuid
        sentByUserId
        activeClimberUserId
      }
    }
  }
}
```

The same aliasing rule applies to `eventsReplay(sessionId:, sinceSequence:)`, so replayed events can flow through the same client-side event processor as live subscription events.

The sent-to-board history is queried with `boardSends(sessionId:, deduplicate:)`. The default `deduplicate: true` view returns one row per climb UUID, latest first, so the history drawer shows climbs that actually reached the board without duplicate sends or upcoming queue items.

### Tick Mode and Queue Bar Freeze

When a user opens the inline tick bar (to log a send/flash/attempt for the current climb), the queue control bar freezes navigation to prevent the active climb from changing mid-tick. This is implemented client-side in `queue-control-bar.tsx`:

- **Freeze trigger**: Opening tick mode sets `activeDrawer: 'tick'` in the queue bar state.
- **Frozen behaviour**: While tick mode is open, swipe navigation and prev/next buttons on the queue bar are disabled. The bar continues to display the climb being ticked, even if other participants change the current climb via WebSocket.
- **Unfreeze**: Closing tick mode (via the close button, swipe-to-dismiss, or after saving) unfreezes the bar and syncs back to the latest server state.
- **Unmount guarantee**: `QuickTickBar` unmounts when tick mode closes. Internal refs (e.g. `tickTargetTaken`) rely on this unmount to reset — they are not explicitly cleared.

This prevents data-loss scenarios where a user is mid-tick and a peer's navigation changes the climb, which would cause the tick to be saved against the wrong climb.

### Optimistic Updates with Correlation IDs

```mermaid
sequenceDiagram
    participant C as Client
    participant R as Reducer
    participant PS as PersistentSession
    participant S as Server

    C->>R: setMyPick(item)
    R->>R: Generate correlationId
    R->>R: Apply optimistic pick for clientId
    R-->>C: My pick UI updated immediately

    PS->>S: setMyPick(item, correlationId)
    S->>S: Update state
    alt Caller is active climber
        S->>S: Mirror pick to currentClimbQueueItem
        S->>PS: PickChanged + CurrentClimbChanged + BoardSendAdded
    else Caller is not active climber
        S->>PS: PickChanged
    end

    PS->>R: DELTA_PICK_CHANGED

    alt correlationId matches pending
        R->>R: Remove from pending
        R->>R: Skip update (already applied)
    else correlationId doesn't match
        R->>R: Apply server state
    end
```

### Sequence Gap Detection

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    Note over C: lastReceivedSequence = 5

    S->>C: Event (sequence: 6)
    C->>C: 6 == 5+1 ✓ Apply event

    S->>C: Event (sequence: 8)
    C->>C: 8 != 6+1 ⚠️ Gap detected!
    C->>C: Log warning
    C->>C: Apply anyway (hash will catch drift)

    Note over C: Periodic hash verification (60s)
    C->>C: Compute local state hash

    alt Hash matches server
        C->>C: State verified ✓
    else Hash mismatch
        C->>S: Trigger resync
        S->>C: FullSync event
    end
```

---

## Multi-Instance Support

The backend supports horizontal scaling with multiple instances behind a load balancer. **No sticky sessions are required** - any instance can handle any client.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Load Balancer                             │
│              (No sticky sessions required)                       │
└─────────────────────────────────────────────────────────────────┘
           │                    │                    │
    ┌──────▼───────┐    ┌──────▼───────┐    ┌──────▼───────┐
    │  Instance A  │    │  Instance B  │    │  Instance C  │
    │              │    │              │    │              │
    │ DistState ───┼────┼──────────────┼────┼─── Redis ◄──┤
    │  Manager     │    │              │    │              │
    └──────────────┘    └──────────────┘    └──────────────┘
```

### DistributedStateManager

The `DistributedStateManager` enables true horizontal scaling:

| Feature             | Description                                         |
| ------------------- | --------------------------------------------------- |
| Connection Tracking | All connections visible across instances via Redis  |
| Session Membership  | Aggregated user list from all instances             |
| Leader Election     | Atomic Lua scripts ensure consistent leader         |
| Instance Heartbeat  | 30s heartbeat detects dead instances                |
| WebSocket Ping/Pong | 30s ping detects dead connections on live instances |
| Graceful Cleanup    | Connections cleaned up on instance shutdown         |

### Redis Pub/Sub for Cross-Instance Events

```mermaid
sequenceDiagram
    participant C1 as Client (Instance 1)
    participant I1 as Backend Instance 1
    participant R as Redis
    participant I2 as Backend Instance 2
    participant C2 as Client (Instance 2)

    C1->>I1: addQueueItem mutation
    I1->>I1: Update state
    I1->>I1: Dispatch to local subscribers
    I1->>R: PUBLISH boardsesh:queue:sessionId

    R->>I2: Message received
    I2->>I2: Check instanceId (skip if self)
    I2->>I2: Dispatch to local subscribers
    I2->>C2: QueueItemAdded event

    I1->>C1: QueueItemAdded event
```

### Cross-Instance Session Membership Validation

```mermaid
sequenceDiagram
    participant C as Client
    participant I1 as Instance 1
    participant DS as DistributedState
    participant R as Redis

    C->>I1: Subscribe to session (via Instance 1)
    I1->>I1: Check local context
    Note over I1: Not found locally

    I1->>DS: isConnectionInSession(connId, sessionId)
    DS->>R: HGET connection data
    R-->>DS: {sessionId: "session-123"}
    DS-->>I1: true (valid member)
    I1->>C: Subscription authorized
```

### Channel Naming Convention

- Queue events: `boardsesh:queue:{sessionId}`
- Session events: `boardsesh:session:{sessionId}`
- Notification events: `boardsesh:notifications:{userId}` (per-user, authenticated)
- Comment live updates: `boardsesh:comments:{entityType}:{entityId}` (per-entity, public)

### Event Buffer for Delta Sync

Events are buffered in Redis for reconnection recovery:

```
boardsesh:session:{sessionId}:events
├── Most recent event (index 0)
├── ...
└── Oldest event (max 100 events, 5 min TTL)
```

---

## Failure States and Recovery

### 1. Client Disconnection

```mermaid
sequenceDiagram
    participant C as Client
    participant WS as WebSocket
    participant G as graphql-ws Client

    Note over C,G: Connection Lost

    WS--xC: Connection closed
    G->>G: Detect disconnection
    G->>G: Start retry (attempt 1)
    G->>G: Wait 1s (exponential backoff)
    G->>WS: Reconnect attempt

    alt Reconnect succeeds
        WS->>G: Connected
        G->>G: Call onReconnect callback
        G->>WS: joinSession mutation
        WS-->>G: Session state
        G->>G: Delta sync or full sync
    else Reconnect fails
        G->>G: Retry with backoff
        Note over G: 1s → 2s → 4s → 8s → ... → 30s max
        Note over G: Up to 10 retries
    end
```

**Recovery mechanism:**

- Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (max)
- Up to 10 retry attempts
- On reconnection: re-join session and sync state
- Delta sync attempted if gap ≤ 100 events
- Falls back to full sync if gap too large
- Client-side supervisor detects stale connections and triggers reconnect (see [Client-Side Connection Supervisor](#client-side-connection-supervisor))

**Offline queue support:**

While disconnected (`isDisconnected` state in `useMutationGuard`), the client can continue operating on its local queue. The mutation guard allows local mutations once the session has been connected at least once:

- **Offline-allowed mutations** apply to local state immediately via the reducer
- **Additions** (`addToQueue`, legacy `setCurrentClimb` queue additions) are buffered in a 500-item offline buffer (`useOfflineQueueBuffer`) for reconciliation on reconnect
- **Pick browsing** (`setMyPick`, `setCurrentClimbQueueItem` while in a party session) applies optimistically to the local user's pick, keyed by `clientId`; it is not buffered for replay, so the next server `FullSync` remains authoritative after reconnect
- **Turn hand-off mutations** (`claimTurn`, `yieldTurn`, `clearMyPick`) require an active connection because they change shared board ownership
- **Other mutations** (`removeFromQueue`, `setQueue`, `mirrorClimb`) apply locally only — they are not buffered because reconciling removals/reorders across multiple users is conflict-prone
- **IndexedDB persistence** is enabled during offline party mode so the queue survives app restarts

On reconnect, the reconciliation hook (`useOfflineReconciliation`) waits for the FullSync event and then chooses a strategy:

- **Client wins** (full local state pushed via `setQueue`): when only 1 user is in the session, or when the server sequence number hasn't changed (no one else modified the queue while we were offline)
- **Server wins with additions merge** (default): server queue state is authoritative; only buffered additions are pushed via individual idempotent `addQueueItem` calls
- **Safety timeout**: if no FullSync arrives within 15 seconds, falls back to additions-only reconciliation against the current local queue

The FullSync handler in the event processor also merges offline-buffered items into the displayed queue for visual continuity — items the user added offline don't briefly disappear during the reconciliation window.

The UI shows the normal queue controls with a "Disconnected" indicator (CloudOff icon) instead of the blocking "Reconnecting..." spinner, so users can keep interacting.

### 2. Redis Connection Failure

```mermaid
sequenceDiagram
    participant B as Backend
    participant R as Redis
    participant PG as PostgreSQL

    B->>R: Publish event
    R--xB: Connection error

    alt Redis Required Mode
        B->>B: Throw error
        B->>B: Health check fails
    else Fallback Mode
        B->>B: Log error, continue
        B->>B: Local dispatch succeeds
        B->>PG: Write to Postgres directly
        Note over B: Other instances won't receive event
    end
```

**Key behavior:**

- If `REDIS_URL` is configured, Redis is **required** (fail-closed)
- Without Redis config: local-only mode (single instance)
- Publish failures logged but don't block local dispatch
- Health endpoint reports Redis status

### 3. PostgreSQL Write Failure

```mermaid
sequenceDiagram
    participant RM as RoomManager
    participant R as Redis
    participant PG as PostgreSQL

    Note over RM: Queue mutation occurs

    RM->>R: Update immediately (source of truth)
    RM->>RM: Schedule Postgres write (30s debounce)

    Note over RM,PG: After 30s debounce timer

    RM->>PG: Write queue state

    alt Write succeeds
        RM->>RM: Clear pending write
    else Write fails
        RM->>RM: Schedule retry (exponential backoff)
        Note over RM: 1s → 2s → 4s → ... → 30s max
        Note over RM: Up to 3 retries

        alt Max retries reached
            RM->>RM: Log error with state
            RM->>RM: Data may be lost
            Note over RM: Redis still has data
        end
    end
```

**Mitigation:**

- Redis is the real-time source of truth
- Postgres writes are debounced (30s) and retried
- Graceful shutdown flushes all pending writes
- Session can be recovered from Redis (4h TTL)

### 4. Session Restoration Race Condition

```mermaid
sequenceDiagram
    participant C1 as Client 1
    participant I1 as Instance 1
    participant R as Redis Lock
    participant I2 as Instance 2
    participant C2 as Client 2

    C1->>I1: Join session (not in memory)
    C2->>I2: Join session (not in memory)

    I1->>R: acquireLock(session:restore:id)
    R-->>I1: Lock acquired ✓

    I2->>R: acquireLock(session:restore:id)
    R-->>I2: Lock NOT acquired
    I2->>I2: Wait with exponential backoff

    I1->>R: Restore session from Redis/Postgres
    I1->>R: releaseLock()

    I2->>I2: Check if session now in memory
    I2->>I2: Proceed with join
```

**Lock mechanism:**

- Redis-based distributed lock (10s TTL)
- Lua script ensures only owner can release
- Backoff waiting: 50ms → 100ms → 200ms → ... (5 attempts)

### 5. State Hash Mismatch (Drift Detection)

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    Note over C: Every 60 seconds

    C->>C: Compute local hash
    C->>C: Compare to last server hash

    alt Hashes match
        C->>C: State verified ✓
    else Hashes differ
        C->>C: Log "State drift detected"
        C->>S: Trigger resync
        S->>S: Re-join session
        S->>C: FullSync event
        C->>C: Apply full state
    end
```

**Additional checks:**

- Current climb must exist in queue
- Sequence numbers must increment by 1
- Hash updated after each delta event

### 6. Queue Item Corruption Detection

The client detects and recovers from corrupted queue items (null/undefined entries) that may occur due to server bugs, network issues, or state corruption.

```mermaid
sequenceDiagram
    participant C as Client
    participant PS as PersistentSession
    participant S as Server

    Note over C: useEffect runs on queue change

    C->>C: Check for null/undefined items

    alt No corrupted items
        C->>C: Compute and update state hash
    else Corrupted items detected
        C->>C: Check resync cooldown (30s)

        alt Within cooldown
            C->>C: Filter items locally
            C->>C: Log error (Sentry)
            Note over C: Prevents infinite loops
        else Cooldown expired
            C->>C: Log error (Sentry)
            C->>S: Trigger resync
            S->>C: FullSync event
            C->>C: Apply clean state
        end
    end
```

**Corruption sources:**

- Server sends malformed queue data
- State corruption during delta sync
- Race conditions in event handling

**Detection points:**

1. **FullSync handler**: Filters null items when receiving initial/full state
2. **QueueItemAdded handler**: Skips events with null items
3. **State hash effect**: Detects corruption in current queue state

**Resync cooldown:**

- 30 second cooldown between corruption-triggered resyncs
- Prevents infinite loop if server keeps returning corrupted data
- During cooldown: filter corrupted items locally instead of resyncing
- All corruption events logged at `console.error` level for Sentry visibility

**Implementation:**

- `computeQueueStateHash()` defensively filters null/undefined items
- `isFilteringCorruptedItemsRef` prevents useEffect re-trigger loops
- `lastCorruptionResyncRef` tracks cooldown timing

### 7. Subscription Error / Complete

```mermaid
sequenceDiagram
    participant C as Client
    participant PS as PersistentSession
    participant S as Server

    S->>PS: Subscription error/complete
    PS->>PS: Clean up subscription ref
    PS->>PS: Set error state

    Note over PS: graphql-ws handles reconnection

    PS->>S: Automatic reconnect
    S->>PS: Connected
    PS->>PS: Re-join session
    PS->>PS: Re-establish subscriptions
```

---

## Client-Side Connection Supervisor

The `WebSocketConnectionManager` (`packages/web/app/components/connection-manager/websocket-connection-manager.ts`) is a singleton that sits between the raw `graphql-ws` clients and the React UI. It provides health monitoring, staleness detection, and a unified connection state for the reconnect UX.

### Architecture

```
graphql-ws Client(s)
        │
        │  on('connected' | 'closed' | 'ping' | 'pong' | 'error' | ...)
        ▼
┌──────────────────────────────┐
│  WebSocketConnectionManager  │  (singleton)
│                              │
│  - Registered clients map    │
│  - Primary name selection    │
│  - Health check interval     │
│  - Visibility change handler │
└──────────┬───────────────────┘
           │  subscribe(snapshot)
           ▼
┌──────────────────────────────┐
│  WebSocketConnectionProvider │  (React context)
│                              │
│  - Exposes state, error,     │
│    lastActivity, name        │
│  - forceReconnect() action   │
└──────────────────────────────┘
```

### Connection States

| State          | Meaning                                         |
| -------------- | ----------------------------------------------- |
| `idle`         | No clients registered                           |
| `connecting`   | Client is establishing a WebSocket connection   |
| `connected`    | Client connected and receiving keep-alive pongs |
| `reconnecting` | Connection lost — `graphql-ws` is retrying      |
| `stale`        | No activity received within `STALE_GRACE_MS`    |
| `error`        | Client reported an error event                  |

### Health Check

A 1-second interval (`HEALTH_CHECK_INTERVAL_MS`) monitors each registered client:

1. If `document.visibilityState !== 'visible'`, skip (avoid terminating background tabs).
2. If `Date.now() - lastActivity > STALE_GRACE_MS` (10s, or 2x the server keep-alive interval), mark the client as `reconnecting` and call `client.terminate()` to force a fresh connection.

This catches silent connection deaths that are common on iOS Safari when the app is backgrounded and the OS kills the socket without a close frame.

### Visibility Change Handler

When the page returns to the foreground (`visibilitychange` → `visible`):

- If the primary client's `lastActivity` exceeds `STALE_GRACE_MS`, or its state is `error`/`reconnecting`, immediately call `forceReconnect()`.

This provides instant recovery when users switch back to the Boardsesh tab.

### Multi-Client Support

Multiple `graphql-ws` clients can be registered simultaneously (e.g., one for queue subscriptions, one for session control). Each is tracked independently with its own state and activity timestamp. The `primaryName` determines which client's state is surfaced to the UI — it auto-promotes to `'session'` on registration and can be switched via `setPrimaryName()`.

### Lifecycle

- **Registration**: `registerClient(client, name)` attaches event listeners and returns an `unregister` function.
- **Unregister**: Removes all event listeners and deletes the client from the map. When the last client is removed, state returns to `idle`.
- **Dispose**: `dispose()` removes the `visibilitychange` listener and clears the health check interval. Used during HMR teardown.

### SSR Shim

On the server (`typeof window === 'undefined'`), the exported `connectionManager` is a no-op shim with the same interface, returning `idle` state. This allows importing in server components without conditional guards.

### Reconnect UX

The `QueueControlBar` reads connection state from the provider. When `state` is `reconnecting`, `stale`, or `error`:

1. The normal climb info is replaced with a spinner and "Reconnecting..." / "Connection error – retrying..." message.
2. A "Cancel" button reveals a confirmation row: "Leave session" (calls `endSession` or `disconnect`) vs "Keep reconnecting".
3. When the connection recovers, the bar automatically returns to normal.

---

## Data Persistence Strategy

### Hybrid Storage Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Write Path                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Queue Mutation ──────► Redis (immediate)                       │
│         │                                                        │
│         └──────────────► Postgres (30s debounced)                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                         Read Path                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Get State ──► Redis (hot cache) ──► Postgres (cold storage)   │
│                      │                       │                   │
│                      ▼                       ▼                   │
│                 Active sessions         Dormant sessions         │
│                 (< 4 hours)             (> 4 hours)              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Postgres-Only Fallback (Single Instance Mode)

When Redis is unavailable, RoomManager falls back to **Postgres-only mode**:

- Queue mutations write **directly to Postgres** (no debouncing, since there's no Redis to serve as a fast read layer)
- Session restoration from Redis is skipped; only Postgres restoration is available
- Distributed state (cross-instance leader election, connection tracking) is disabled
- This mode only supports a single backend instance (no horizontal scaling)

### Session State Tiers

| Tier     | Storage           | TTL        | Use Case                                                                           |
| -------- | ----------------- | ---------- | ---------------------------------------------------------------------------------- |
| **Hot**  | In-Memory + Redis | 4 hours    | Active sessions with connected users                                               |
| **Warm** | Redis only        | 4 hours    | No connected users, but fast restoration is still available                        |
| **Cold** | PostgreSQL        | Indefinite | Durable session rows, including dormant sessions restorable until explicitly ended |

### Participant Tracking (Postgres)

Session participation is tracked in two layers:

| Layer                     | Table / Key                      | Granularity            | Lifetime           |
| ------------------------- | -------------------------------- | ---------------------- | ------------------ |
| **Real-time** (Redis)     | `boardsesh:session:{id}:members` | Per connection ID      | Ephemeral (4h TTL) |
| **Historical** (Postgres) | `board_session_participants`     | Per authenticated user | Permanent          |

**`board_session_participants`** records one row per (session_id, user_id) with a `joined_at` timestamp. It is upserted (`ON CONFLICT DO NOTHING`) when an authenticated user joins a session. Rows are never deleted on disconnect — they serve as a permanent historical record of who participated.

> **Note:** The legacy `board_session_clients` table (one row per WebSocket connection) is no longer written to. Leader state is managed exclusively in Redis via the `DistributedStateManager`.

### Key Redis Data Structures

**Session State (RedisSessionStore):**

```
boardsesh:session:{id}              # Hash - session data (queue, version, etc.)
boardsesh:session:{id}:users        # Hash - connected users (legacy)
boardsesh:session:{id}:events       # List - event buffer (delta sync)
boardsesh:session:active            # Set - active session IDs
boardsesh:session:recent            # Sorted Set - recent sessions (by time)
boardsesh:lock:session:restore:{id} # String - distributed lock (10s TTL)
```

**Distributed State (DistributedStateManager):**

```
boardsesh:conn:{connectionId}       # Hash - connection data (1h TTL, refreshed on activity)
boardsesh:session:{id}:members      # Set - connection IDs in session (4h TTL)
boardsesh:session:{id}:leader       # String - leader connection ID (4h TTL)
boardsesh:instance:{id}:conns       # Set - connections owned by instance (2h TTL, refreshed on heartbeat)
boardsesh:instance:{id}:heartbeat   # String - instance heartbeat timestamp (60s TTL, refreshed every 30s)
```

**Pub/Sub Channels:**

```
boardsesh:queue:{sessionId}         # Queue events (add, remove, reorder, etc.)
boardsesh:session:{sessionId}       # Session events (join, leave, leader change)
```

### Graceful Shutdown

```mermaid
sequenceDiagram
    participant P as Process
    participant RM as RoomManager
    participant DS as DistributedState
    participant R as Redis
    participant PG as PostgreSQL
    participant WS as WebSocket

    P->>P: SIGTERM received
    P->>RM: shutdown()
    RM->>RM: flushPendingWrites()

    loop For each pending session
        RM->>RM: Clear debounce timer
        RM->>PG: Write queue state
    end

    RM->>DS: stop()
    DS->>DS: Stop heartbeat interval

    loop For each connection on this instance
        DS->>R: Remove connection data
        DS->>R: Remove from session members
        DS->>R: Elect new leader if needed
    end

    DS->>R: Remove instance tracking keys
    DS-->>RM: Cleanup complete

    RM-->>P: Shutdown complete

    P->>WS: Close all connections
    WS->>WS: Send close frame (1000)

    P->>R: Disconnect
    P->>P: Exit
```

### Dead Connection and Instance Detection

The system uses multiple layers to detect and clean up dead connections:

**1. WebSocket Ping/Pong (30s interval)**

The WebSocket server pings every connected client every 30 seconds. If a client doesn't respond with a pong before the next ping cycle, the socket is terminated. This detects half-open TCP connections caused by network drops (phone sleep, WiFi switch, browser tab killed without close frame). When `terminate()` is called, the `ws` close event fires, graphql-ws triggers `onDisconnect`, and the existing Redis cleanup runs. Dead connections are detected within 30–60 seconds.

**2. Instance Heartbeat (60s TTL, refreshed every 30s)**

```
boardsesh:instance:{id}:heartbeat = timestamp (60s TTL)
```

When an instance dies unexpectedly, its heartbeat key expires after 60 seconds.

**3. Active Dead Instance Cleanup**

The `DistributedStateManager` actively discovers and cleans up dead instances:

- **On startup**: `cleanupDeadInstanceConnections()` runs asynchronously after the first heartbeat
- **Periodically**: Piggybacks on the 30s heartbeat cycle, running every 4th heartbeat (~2 minutes)

The cleanup process:

1. SCANs for `boardsesh:instance:*:conns` keys
2. Checks if the corresponding heartbeat key exists (skip current instance)
3. For each dead instance: fetches its connection IDs, groups by session
4. Deletes all orphaned connection hashes and instance tracking keys
5. Runs `PRUNE_STALE_SESSION_MEMBERS_SCRIPT` (Lua) per affected session to atomically remove stale members and re-elect leader if needed

**4. Active Session Stale Member Cleanup**

On the same ~2 minute cadence, each instance also prunes stale members from sessions it participates in. This catches edge cases where a connection on the current instance died between ping intervals (e.g., race between ping check and socket termination).

**5. Self-Healing Reads**

Even between cleanup cycles, stale entries never inflate participant counts:

- `getSessionMemberCount()` pipelines `EXISTS` checks against each member's connection hash — only live connections are counted
- `getSessionMembers()` filters out members whose connection data is missing **and** fires a background cleanup to remove stale IDs from the Redis set
- `hasSessionMembers()` delegates to the filtered count

**6. TTL Self-Healing (defense in depth)**

| Key                                 | TTL        | Refreshed                |
| ----------------------------------- | ---------- | ------------------------ |
| `boardsesh:conn:{id}`               | 1 hour     | On client activity       |
| `boardsesh:instance:{id}:conns`     | 2 hours    | On every heartbeat (30s) |
| `boardsesh:instance:{id}:heartbeat` | 60 seconds | Every 30s                |
| `boardsesh:session:{id}:members`    | 4 hours    | On join/leave/refresh    |

Even if all active cleanup fails, orphaned data expires naturally via these TTLs.

---

## Controller Events (ESP32 Integration)

The backend supports ESP32 controllers that bridge between official Kilter/Tension apps and BoardSesh sessions. Controllers receive LED updates and can send detected climbs back to the session.

### Authentication

Controllers authenticate using API keys passed in the WebSocket connection params (not in GraphQL variables):

```javascript
// graphql-ws protocol connection_init
{
  "type": "connection_init",
  "payload": {
    "controllerApiKey": "your-64-char-hex-key"
  }
}
```

The backend extracts this from `connectionParams.controllerApiKey` during the `onConnect` hook and stores `controllerId` and `controllerApiKey` in the connection context.

### Authorization Flow

1. **User Registration** (Web UI)
   - User visits Settings > ESP32 Controllers
   - Clicks "Add Controller" and configures board type, layout, size, sets
   - Receives a 64-character hex API key (shown once, must save it)

2. **Session Authorization** (Automatic)
   - When user calls `joinSession` mutation (authenticated)
   - Backend auto-authorizes all user's controllers for that session
   - Sets `authorizedSessionId` column in database

3. **Controller Connection** (ESP32)
   - ESP32 connects with API key in `connection_init` payload
   - Backend validates key and populates context with controller info

4. **Subscription Authorization**
   - Controller subscribes to `controllerEvents(sessionId)`
   - Backend verifies controller is authorized for that session
   - Throws error if not: "Controller not authorized for session"

5. **Mutation Authorization**
   - Controller calls `setClimbFromLedPositions(sessionId, frames)`
   - Backend verifies session authorization before processing

### Controller Subscription

```graphql
subscription ControllerEvents($sessionId: ID!) {
  controllerEvents(sessionId: $sessionId) {
    ... on LedUpdate {
      commands {
        position
        r
        g
        b
      }
      climbUuid
      climbName
      climbGrade
      boardPath
      angle
    }
    ... on ControllerPing {
      timestamp
    }
  }
}
```

### Events

| Event                 | Description                                                  |
| --------------------- | ------------------------------------------------------------ |
| `LedUpdate`           | LED commands for current climb (RGB values and positions)    |
| `ControllerQueueSync` | Full queue state sync (sent on connection and queue changes) |
| `ControllerPing`      | Keep-alive ping (not currently implemented)                  |

### LedUpdate Fields

| Field           | Type   | Description                                                                                                                                                                |
| --------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands`      | Array  | LED positions with RGB values                                                                                                                                              |
| `queueItemUuid` | String | UUID of the queue item (for navigation)                                                                                                                                    |
| `climbUuid`     | String | Unique identifier for the climb                                                                                                                                            |
| `climbName`     | String | Display name of the climb                                                                                                                                                  |
| `climbGrade`    | String | The climb difficulty/grade (e.g., "V5", "6a/V3")                                                                                                                           |
| `gradeColor`    | String | Hex color for the grade (e.g., "#00FF00")                                                                                                                                  |
| `boardPath`     | String | Board configuration path for context-aware operations (e.g., "kilter/1/12/1,2,3/40")                                                                                       |
| `angle`         | Int    | Board angle in degrees                                                                                                                                                     |
| `clientId`      | String | Identifier of client that initiated the change (used by ESP32 to decide whether to disconnect BLE client - if clientId matches ESP32's MAC, it was self-initiated via BLE) |
| `navigation`    | Object | Navigation context with previousClimbs, nextClimb, currentIndex, totalCount                                                                                                |

### ControllerQueueSync Fields

| Field          | Type  | Description                                                        |
| -------------- | ----- | ------------------------------------------------------------------ |
| `queue`        | Array | Array of queue items with uuid, climbUuid, name, grade, gradeColor |
| `currentIndex` | Int   | Index of the current climb in the queue (-1 if none)               |

### LED Color Mapping

| Hold State | RGB Value             |
| ---------- | --------------------- |
| STARTING   | (0, 255, 0) Green     |
| FINISH     | (255, 0, 255) Magenta |
| HAND       | (0, 255, 255) Cyan    |
| FOOT       | (255, 170, 0) Orange  |

### Controller Mutations

```graphql
# Send detected climb from Bluetooth
mutation SetClimbFromLeds($sessionId: ID!, $frames: String) {
  setClimbFromLedPositions(sessionId: $sessionId, frames: $frames) {
    matched
    climbUuid
    climbName
  }
}

# Navigate queue via hardware buttons (previous/next)
# queueItemUuid is preferred for direct navigation (most reliable)
# direction is used as fallback when queueItemUuid not found
mutation NavigateQueue($sessionId: ID!, $direction: String!, $queueItemUuid: String) {
  navigateQueue(sessionId: $sessionId, direction: $direction, queueItemUuid: $queueItemUuid) {
    uuid
    climb {
      name
      difficulty
    }
  }
}

# Heartbeat to update lastSeenAt
mutation Heartbeat($sessionId: ID!) {
  controllerHeartbeat(sessionId: $sessionId)
}
```

### Queue Navigation

The `navigateQueue` mutation allows ESP32 controllers to browse the queue via hardware buttons:

| Parameter       | Type    | Description                                                |
| --------------- | ------- | ---------------------------------------------------------- |
| `sessionId`     | ID!     | Session to navigate within                                 |
| `direction`     | String! | "next" or "previous" (fallback if queueItemUuid not found) |
| `queueItemUuid` | String  | Direct navigation to specific queue item (preferred)       |

**Navigation Flow:**

1. ESP32 maintains local queue state from `ControllerQueueSync` events
2. On button press, ESP32 calculates the target item locally (optimistic update)
3. ESP32 sends `navigateQueue` with the target `queueItemUuid`
4. Backend updates current climb and broadcasts `CurrentClimbChanged`
5. ESP32 receives `LedUpdate` with new climb data

**Debounce Behavior:**

- Navigation mutations are debounced with a 100ms delay to prevent WebSocket disconnection from rapid button presses
- UI updates immediately (optimistic), but only ONE mutation is sent after 100ms of button inactivity
- Example: Pressing "next" 10 times quickly results in 10 immediate display updates but only 1 mutation (to the final position)
- During rapid navigation, incoming `LedUpdate` events skip queue index sync to preserve optimistic state
- Only one mutation can be in-flight at a time; new mutations wait for the previous to complete

### Manual Authorization

If auto-authorization doesn't apply (e.g., controller owner is not in session), use:

```graphql
mutation AuthorizeController($controllerId: ID!, $sessionId: ID!) {
  authorizeControllerForSession(controllerId: $controllerId, sessionId: $sessionId)
}
```

Requires user authentication and controller ownership.

---

## Configuration

### Environment Variables

| Variable        | Description             | Default                |
| --------------- | ----------------------- | ---------------------- |
| `REDIS_URL`     | Redis connection string | None (local-only mode) |
| `PORT`          | HTTP/WS server port     | 8080                   |
| `BOARDSESH_URL` | Allowed CORS origin     | https://boardsesh.com  |

### Timeouts and Limits

| Setting                 | Value   | Purpose                                   |
| ----------------------- | ------- | ----------------------------------------- |
| Retry attempts          | 10      | WebSocket reconnection                    |
| Max retry delay         | 30s     | Exponential backoff cap                   |
| Keep-alive interval     | 10s     | Connection health check                   |
| Mutation timeout        | 30s     | Prevent hanging mutations                 |
| Redis TTL               | 4 hours | Session cache expiry                      |
| Postgres debounce       | 30s     | Batch writes                              |
| Event buffer size       | 100     | Delta sync limit                          |
| Event buffer TTL        | 5 min   | Old events cleanup                        |
| Hash verification       | 60s     | State drift detection                     |
| Subscription queue      | 1000    | Max pending events                        |
| Connection TTL          | 1 hour  | Distributed connection expiry             |
| WebSocket ping interval | 30s     | Dead connection detection                 |
| Instance heartbeat      | 30s     | Heartbeat update interval                 |
| Instance heartbeat TTL  | 60s     | Dead instance detection                   |
| Session members TTL     | 4 hours | Matches session TTL                       |
| Session grace period    | 60s     | In-memory retention after last disconnect |

---

## Native iOS WebSocket Client

The iOS app includes a native WebSocket client (`SessionWebSocketManager`) that maintains its own connection to the GraphQL backend, independent of the web view's connection. This enables Live Activities (Lock Screen and Dynamic Island widgets) to receive real-time queue updates even when the web view is backgrounded.

### Why a Separate Native Client

The web view's `graphql-ws` connection is tied to the web view's lifecycle — when iOS suspends the web view (backgrounding, Lock Screen), the connection drops. Live Activities need continuous updates to show the current climb on the Lock Screen. A native `URLSessionWebSocketTask` connection persists longer and can be managed by the app's main process.

### Protocol

The native client implements the same `graphql-ws` protocol as the web client:

1. **ConnectionInit** — Sent on connect with optional `authToken` in `connectionParams`
2. **ConnectionAck** — Server confirms
3. **JoinSession** — Mutation to join the session, which sets `ctx.sessionId` on the server so subsequent mutations are authorized
4. **Subscribe** — `queueUpdates(sessionId:)` subscription for queue delta events
5. **Next** — Queue delta events (FullSync, CurrentClimbChanged, QueueItemAdded, etc.). The native Live Activity client only needs board-visible state, so pick-only events may be ignored unless the native client adds explicit `PickChanged` / `ActiveClimberChanged` fragments.
6. **Ping/Pong** — Server sends pings every 30s, client responds with pong

### Reconnection

Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s. Reconnection stops on intentional disconnect (session end, app termination). After reconnection, the first event from the server is always a `FullSync`, which resets the client's queue state.

### Sequence Gap Detection

Each queue event carries a `sequence` number. The native client tracks the last received sequence and detects gaps (missed events). When a gap is detected, the client relies on the server's next `FullSync` to recover — no explicit resync request is needed since the server sends a full state on reconnection.

### Data Flow

```
SessionWebSocketManager
  │ subscribes to queueUpdates(sessionId:)
  │ receives delta events
  ▼
LiveActivityManager
  │ calls Activity.update() with new ContentState
  ▼
Lock Screen / Dynamic Island
  │ renders updated climb info
```

Widget button taps (next/prev) flow in the opposite direction:

```
Widget App Intent (NextClimbIntent / PreviousClimbIntent)
  │ updates App Group UserDefaults optimistically
  │ updates Live Activity directly
  │ posts Darwin notification
  ▼
LiveActivityPlugin (main app process, Capacitor plugin)
  │ reads updated queue state from App Group
  │ calls SessionWebSocketManager.navigateToItem()
  │ also emits JS event (fallback for foregrounded app)
  ▼
SessionWebSocketManager
  │ sends setCurrentClimb mutation via native WS (legacy/programmatic board path)
  ▼
Backend publishes CurrentClimbChanged
  │ all clients (web + native) receive update
```

For collaborative pick-aware navigation, a native client should use the same flow as the web UI: `setMyPick` for browsing and `claimTurn` / `yieldTurn` for changing the active climber. Direct `setCurrentClimb` remains available for solo, controller, and other programmatic board-control paths.

### App Group Shared State

The main app and widget extension share data via App Group (`group.com.boardsesh.app`):

| Key                                             | Type       | Purpose                                           |
| ----------------------------------------------- | ---------- | ------------------------------------------------- |
| `queue_items`                                   | JSON array | Serialized `SharedQueueItem` list                 |
| `current_index`                                 | Int        | Current position in queue                         |
| `session_id`                                    | String     | Active session identifier                         |
| `server_url`                                    | String     | Backend URL for thumbnail fetching                |
| `board_name`, `layout_id`, `size_id`, `set_ids` | String/Int | Board details for thumbnail URL construction      |
| `pending_action`                                | String     | Widget→app navigation request ("next"/"previous") |

### Lifecycle

- **Start**: `LiveActivityPlugin.startSession()` stores board details in App Group, connects the WebSocket manager, and starts the Live Activity
- **End**: `LiveActivityPlugin.endSession()` clears the callback, disconnects WebSocket, ends all Live Activities, and cleans up App Group state
- **App termination**: `SceneDelegate.sceneDidDisconnect` and `AppDelegate.applicationWillTerminate` attempt to end the Live Activity and disconnect the WebSocket, but these callbacks are **not reliably called** on force-quit. As a fallback, the stale date is set to 3 minutes (refreshed every 60s by the ping timer), and `SceneDelegate.sceneWillEnterForeground` / `scene(_:willConnectTo:)` clean up any stale or orphaned activities on the next app launch or foreground return

## Related Files

### Backend

- `packages/backend/src/websocket/setup.ts` - WebSocket server configuration
- `packages/backend/src/pubsub/index.ts` - Event pub/sub system
- `packages/backend/src/pubsub/redis-adapter.ts` - Redis pub/sub adapter
- `packages/backend/src/services/room-manager.ts` - Session & queue management
- `packages/backend/src/services/redis-session-store.ts` - Redis session persistence
- `packages/backend/src/services/distributed-state.ts` - Multi-instance state management
- `packages/backend/src/graphql/resolvers/queue/` - Queue mutations & subscriptions
- `packages/backend/src/graphql/resolvers/sessions/` - Session mutations & subscriptions
- `packages/backend/src/graphql/resolvers/shared/helpers.ts` - Cross-instance auth validation

### Frontend

- `packages/web/app/lib/backend-url.ts` - Runtime backend URL resolver (preview deploys, dev overrides)
- `packages/web/app/components/graphql-queue/graphql-client.ts` - WebSocket client
- `packages/web/app/components/graphql-queue/use-queue-session.ts` - Session hook
- `packages/web/app/components/persistent-session/persistent-session-context.tsx` - Root-level session management (split into ActionsContext + StateContext for render performance)
- `packages/web/app/components/graphql-queue/QueueContext.tsx` - Queue state context (split into ActionsContext + DataContext; actions use `latestRef` pattern for stable callback identity)

### Native iOS

- `mobile/ios/App/App/SessionWebSocketManager.swift` - Native graphql-ws client for queue subscriptions
- `mobile/ios/App/App/LiveActivityPlugin.swift` - Capacitor plugin bridge (start/end session, update activity)
- `mobile/ios/App/App/LiveActivityManager.swift` - ActivityKit lifecycle management
- `mobile/ios/App/App/SharedConstants.swift` - App Group ID, UserDefaults keys, shared queue state helpers
- `mobile/ios/App/App/ThumbnailFetcher.swift` - Board-render thumbnail fetching and caching
- `mobile/ios/App/BoardseshWidgets/NextClimbIntent.swift` - Widget next button App Intent
- `mobile/ios/App/BoardseshWidgets/PreviousClimbIntent.swift` - Widget previous button App Intent
- `packages/web/app/lib/live-activity/use-live-activity.ts` - React hook bridging queue state to native Live Activity

### Shared

- `packages/shared-schema/src/schema.ts` - GraphQL schema definition
- `packages/shared-schema/src/types.ts` - TypeScript types

## Onboarding tour integration points

The onboarding tour (see `packages/web/app/components/onboarding/`) drives the real session UI with mock data so a new user can see what a populated party session looks like without creating one. A few escape hatches in the session-related components exist solely for the tour — do not remove them thinking they are dead code:

- **`SeshSettingsDrawer` — `tourMockSession?: SessionDetail` prop.** When set, the drawer skips its GraphQL `sessionDetail` query, bypasses the `activeSession` guard, hides the Stop-session button, and swaps the real invite link / QR for a non-URL preview string (`boardsesh:onboarding-tour-preview`). It renders entirely from the mock object generated by `packages/web/app/components/onboarding/mock-session-detail.ts`.
- **`SeshSettingsDrawer` / `SessionDetailContent` — `tourActiveSection?: 'invite' | 'activity' | 'analytics' | null` prop.** Threads down to `CollapsibleSection`'s `forcedActiveKey`, which forces a specific section open and disables the user's collapse/expand interaction while the tour is driving it.
- **`CollapsibleSection` — `forcedActiveKey?: string | null` prop.** Controlled-mode override used by the tour to walk the user through Invite → Activity → Analytics in sequence. When unset, the section is uncontrolled (existing behaviour).
- **`QueueControlBar` — `TOUR_CLOSE_PLAY_VIEW_EVENT` window event (`onboarding:close-play-view`).** The bar closes the play drawer on demand so the session overview can be shown without stacking.
- **`QueueControlBar` session mini-bar — `data-tour-anchor="session-mini-bar"`.** Placed on the always-rendered `.sessionHeaderInner` wrapper so the anchor resolves whether or not a real `activeSession` exists. The "Open your session" step anchors here.
- **`ClimbsList` — `TOUR_CLIMB_LIST_PICK_EVENT` window event (`onboarding:climb-list-pick`).** Dispatched when the user explicitly taps a climb card while the tour is on the `climb-list` step. The provider advances on this signal rather than on `currentClimb` observation, so async queue hydration into a newly-created session can't falsely skip the step.
- **`PlayViewDrawer` — `TOUR_OPEN_PLAY_QUEUE_EVENT` + `TOUR_CLOSE_PLAY_QUEUE_EVENT` window events.** Let the tour open/close the nested queue drawer inside the play view. On tour-driven open, the nested `QueueDrawer` is mounted with `initialShowHistory=true` so every queued climb is visible regardless of which one is currently active.

All of the above are cheap conditional paths — they only branch when the matching prop/event is present. They do not affect the WebSocket flow or any real-session behaviour.

The event constants live in `packages/web/app/components/onboarding/onboarding-tour-events.ts`. The state machine and side-effect dispatcher live in `packages/web/app/components/onboarding/onboarding-tour-provider.tsx`.
