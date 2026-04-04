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

---

## Architecture Overview

The party session system uses a GraphQL-over-WebSocket architecture with the following key components:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Frontend (Next.js)                          │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────┐    ┌─────────────────────────────────────────┐ │
│  │ PersistentSession   │◄───┤ GraphQL Client (graphql-ws)             │ │
│  │ Context             │    │ - Connection management                  │ │
│  └─────────┬───────────┘    │ - Subscription handling                  │ │
│            │                │ - Reconnection with exponential backoff  │ │
│  ┌─────────▼───────────┐    └─────────────────────────────────────────┘ │
│  │ QueueContext        │                                                 │
│  │ - Local state       │                                                 │
│  │ - Optimistic updates│                                                 │
│  └─────────────────────┘                                                 │
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

## Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| WebSocket Protocol | `graphql-ws` | GraphQL subscriptions over WebSocket |
| Backend Framework | GraphQL Yoga | HTTP + WS GraphQL server |
| Frontend Client | `graphql-ws` client | Connection management |
| Pub/Sub | Redis (subscriber connection) | Multi-instance event distribution |
| Hot Cache | Redis (publisher connection) | Real-time session state (4h TTL) |
| Stream Consumer | Redis (streamConsumer connection) | Dedicated connection for blocking `XREADGROUP` in EventBroker |
| Persistent Storage | PostgreSQL | Durable session & queue history |

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
    else Session exists in Redis (inactive)
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
4. **Session Restoration**: Sessions can be restored from Redis (hot) or PostgreSQL (cold)
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
- If joining an existing session (active, inactive, or dormant), these values are ignored and the existing session state is used
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

| Service | Domain pattern | Example (PR #42) |
|---------|---------------|-------------------|
| Web frontend | `{N}.preview.boardsesh.com` | `42.preview.boardsesh.com` |
| WS backend | `{N}.ws.preview.boardsesh.com` | `42.ws.preview.boardsesh.com` |

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

---

## Session Management

### Session Lifecycle States

```
                    ┌─────────────────────────────────────┐
                    │              Created                  │
                    │  - Optional: goal, color, boardIds   │
                    │  - Optional: isPermanent flag        │
                    │  - startedAt set on creation         │
                    └──────────────┬────────────────────────┘
                                   │ First user joins
                                   ▼
    ┌──────────────────────────────────────────────┐
    │                   ACTIVE                      │
    │  - Users connected                            │
    │  - Real-time sync enabled                     │
    │  - Redis cache hot                            │
    │  - In-memory session state                    │
    └──────┬───────────────────────┬───────────────┘
           │ Last user leaves      │ Leader calls endSession
           ▼                       ▼
    ┌────────────────────┐   ┌──────────────────────────────┐
    │  GRACE PERIOD (60s)│   │     ENDED (explicit)          │
    │  - No connected    │   │  - endedAt set                │
    │    users           │   │  - Summary generated           │
    │  - In-memory state │   │  - SessionEnded event sent     │
    │    RETAINED        │   │  - Removed from Redis          │
    │  - Redis: inactive │   │  - Postgres record kept        │
    │  - Postgres:       │   └──────────────────────────────┘
    │    'inactive'      │
    └────────┬──────┬────┘
             │      │ 60s expires
             │      ▼
             │   ┌─────────────────────────────┐
             │   │          INACTIVE            │
             │   │  - In-memory state deleted   │
             │   │  - Redis cache retained (4h) │
             │   │  - Restoration needed on     │
             │   │    next join (lock + fetch)   │
             │   └──────────┬──────────────────┘
             │              │ TTL expires OR auto-end
             │              ▼
             │   ┌──────────────────────────────┐
             │   │      ENDED (auto/TTL)         │
             │   │  - endedAt set                │
             │   │  - Removed from Redis         │
             │   │  - Postgres record kept       │
             │   │  - Cannot be rejoined         │
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

### Session Properties

Sessions support the following configurable properties set at creation time:

| Property | Type | Description |
|----------|------|-------------|
| `goal` | `String?` | Free-text session goal (max 500 chars), displayed in the session header |
| `color` | `String?` | Hex color code for multi-session display (e.g., `#FF5722`) |
| `isPermanent` | `Boolean` | Exempt from auto-end cleanup (for gym kiosk sessions) |
| `isPublic` | `Boolean` | Whether the session appears in discovery (default: true) |
| `boardIds` | `[Int]?` | Multi-board support — links session to specific boards within a gym |

### Session Ending and Summaries

Sessions can end in three ways:

1. **Explicit end** — Leader or creator calls `endSession` mutation
2. **Auto-end** — Background job ends inactive, non-permanent sessions after 30 minutes (configurable via `SESSION_AUTO_END_MINUTES` env var)
3. **TTL expiry** — Redis cache expires after 4 hours of inactivity

When a session ends explicitly via `endSession`:
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

### Auto-End Cleanup

A periodic background job runs every 5 minutes on the backend server to automatically end stale sessions:

- Targets sessions with status `inactive` that have not had activity for `SESSION_AUTO_END_MINUTES` (default: 30)
- Skips sessions with `isPermanent = true` (gym kiosk sessions)
- Processes up to 50 sessions per cycle to avoid overload
- Failures for individual sessions are logged but don't block other sessions

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

| Event | When emitted | Key fields |
|-------|--------------|------------|
| `UserJoined` | A client joins the session | `user` |
| `UserLeft` | A client disconnects/leaves | `userId` |
| `LeaderChanged` | Leader election selects a new leader | `leaderId` |
| `SessionEnded` | Session is ended explicitly or by cleanup | `reason`, `newPath` |
| `SessionStatsUpdated` | A tick is saved for an active party session | `totalSends`, `totalFlashes`, `totalAttempts`, `tickCount`, `participants`, `gradeDistribution`, `boardTypes`, `hardestGrade`, `durationMinutes`, `goal`, `ticks` |

`SessionStatsUpdated` payloads now include full `ticks` rows so clients can update charts and climbs/attempt lists without issuing an extra session detail refetch.

---

## Queue State Synchronization

### Event Types

| Event | Description | Fields |
|-------|-------------|--------|
| `FullSync` | Complete state snapshot | `sequence`, `state` (queue + currentClimb) |
| `QueueItemAdded` | Item added to queue | `sequence`, `item`, `position` |
| `QueueItemRemoved` | Item removed from queue | `sequence`, `uuid` |
| `QueueReordered` | Item moved in queue | `sequence`, `uuid`, `oldIndex`, `newIndex` |
| `CurrentClimbChanged` | Active climb changed | `sequence`, `item`, `clientId`, `correlationId` |
| `ClimbMirrored` | Mirror state toggled | `sequence`, `mirrored` |

### Optimistic Updates with Correlation IDs

```mermaid
sequenceDiagram
    participant C as Client
    participant R as Reducer
    participant PS as PersistentSession
    participant S as Server

    C->>R: setCurrentClimbQueueItem(climb)
    R->>R: Generate correlationId
    R->>R: Add to pendingCurrentClimbUpdates
    R->>R: Apply optimistic update
    R-->>C: UI updated immediately

    PS->>S: setCurrentClimb(climb, correlationId)
    S->>S: Update state
    S->>PS: CurrentClimbChanged event

    PS->>R: DELTA_UPDATE_CURRENT_CLIMB

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

| Feature | Description |
|---------|-------------|
| Connection Tracking | All connections visible across instances via Redis |
| Session Membership | Aggregated user list from all instances |
| Leader Election | Atomic Lua scripts ensure consistent leader |
| Instance Heartbeat | 30s heartbeat detects dead instances |
| WebSocket Ping/Pong | 30s ping detects dead connections on live instances |
| Graceful Cleanup | Connections cleaned up on instance shutdown |

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

- **All mutations** apply to local state immediately via the reducer
- **Additions** (addToQueue, setCurrentClimb) are buffered in a 500-item offline buffer (`useOfflineQueueBuffer`) for reconciliation on reconnect
- **Other mutations** (removeFromQueue, setQueue, setCurrentClimbQueueItem, mirrorClimb) apply locally only — they are not buffered because reconciling removals/reorders across multiple users is conflict-prone
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

| State | Meaning |
|-------|---------|
| `idle` | No clients registered |
| `connecting` | Client is establishing a WebSocket connection |
| `connected` | Client connected and receiving keep-alive pongs |
| `reconnecting` | Connection lost — `graphql-ws` is retrying |
| `stale` | No activity received within `STALE_GRACE_MS` |
| `error` | Client reported an error event |

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

| Tier | Storage | TTL | Use Case |
|------|---------|-----|----------|
| **Hot** | In-Memory + Redis | 4 hours | Active sessions with connected users |
| **Warm** | Redis only | 4 hours | Recently inactive (users left) |
| **Cold** | PostgreSQL | Indefinite | Historical sessions, dormant restoration |

### Participant Tracking (Postgres)

Session participation is tracked in two layers:

| Layer | Table / Key | Granularity | Lifetime |
|-------|-------------|-------------|----------|
| **Real-time** (Redis) | `boardsesh:session:{id}:members` | Per connection ID | Ephemeral (4h TTL) |
| **Historical** (Postgres) | `board_session_participants` | Per authenticated user | Permanent |

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

| Key | TTL | Refreshed |
|-----|-----|-----------|
| `boardsesh:conn:{id}` | 1 hour | On client activity |
| `boardsesh:instance:{id}:conns` | 2 hours | On every heartbeat (30s) |
| `boardsesh:instance:{id}:heartbeat` | 60 seconds | Every 30s |
| `boardsesh:session:{id}:members` | 4 hours | On join/leave/refresh |

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
      commands { position r g b }
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

| Event | Description |
|-------|-------------|
| `LedUpdate` | LED commands for current climb (RGB values and positions) |
| `ControllerQueueSync` | Full queue state sync (sent on connection and queue changes) |
| `ControllerPing` | Keep-alive ping (not currently implemented) |

### LedUpdate Fields

| Field | Type | Description |
|-------|------|-------------|
| `commands` | Array | LED positions with RGB values |
| `queueItemUuid` | String | UUID of the queue item (for navigation) |
| `climbUuid` | String | Unique identifier for the climb |
| `climbName` | String | Display name of the climb |
| `climbGrade` | String | The climb difficulty/grade (e.g., "V5", "6a/V3") |
| `gradeColor` | String | Hex color for the grade (e.g., "#00FF00") |
| `boardPath` | String | Board configuration path for context-aware operations (e.g., "kilter/1/12/1,2,3/40") |
| `angle` | Int | Board angle in degrees |
| `clientId` | String | Identifier of client that initiated the change (used by ESP32 to decide whether to disconnect BLE client - if clientId matches ESP32's MAC, it was self-initiated via BLE) |
| `navigation` | Object | Navigation context with previousClimbs, nextClimb, currentIndex, totalCount |

### ControllerQueueSync Fields

| Field | Type | Description |
|-------|------|-------------|
| `queue` | Array | Array of queue items with uuid, climbUuid, name, grade, gradeColor |
| `currentIndex` | Int | Index of the current climb in the queue (-1 if none) |

### LED Color Mapping

| Hold State | RGB Value |
|------------|-----------|
| STARTING | (0, 255, 0) Green |
| FINISH | (255, 0, 255) Magenta |
| HAND | (0, 255, 255) Cyan |
| FOOT | (255, 170, 0) Orange |

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

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | ID! | Session to navigate within |
| `direction` | String! | "next" or "previous" (fallback if queueItemUuid not found) |
| `queueItemUuid` | String | Direct navigation to specific queue item (preferred) |

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

| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_URL` | Redis connection string | None (local-only mode) |
| `PORT` | HTTP/WS server port | 8080 |
| `BOARDSESH_URL` | Allowed CORS origin | https://boardsesh.com |
| `SESSION_AUTO_END_MINUTES` | Inactive session auto-end threshold | 30 |

### Timeouts and Limits

| Setting | Value | Purpose |
|---------|-------|---------|
| Retry attempts | 10 | WebSocket reconnection |
| Max retry delay | 30s | Exponential backoff cap |
| Keep-alive interval | 10s | Connection health check |
| Mutation timeout | 30s | Prevent hanging mutations |
| Redis TTL | 4 hours | Session cache expiry |
| Postgres debounce | 30s | Batch writes |
| Event buffer size | 100 | Delta sync limit |
| Event buffer TTL | 5 min | Old events cleanup |
| Hash verification | 60s | State drift detection |
| Subscription queue | 1000 | Max pending events |
| Connection TTL | 1 hour | Distributed connection expiry |
| WebSocket ping interval | 30s | Dead connection detection |
| Instance heartbeat | 30s | Heartbeat update interval |
| Instance heartbeat TTL | 60s | Dead instance detection |
| Session members TTL | 4 hours | Matches session TTL |
| Session grace period | 60s | In-memory retention after last disconnect |
| Session auto-end | 30 min | Auto-end inactive non-permanent sessions |
| Auto-end check interval | 5 min | How often the auto-end job runs |

---

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
- `packages/web/app/components/persistent-session/persistent-session-context.tsx` - Root-level session management
- `packages/web/app/components/graphql-queue/QueueContext.tsx` - Queue state context

### Shared

- `packages/shared-schema/src/schema.ts` - GraphQL schema definition
- `packages/shared-schema/src/types.ts` - TypeScript types
