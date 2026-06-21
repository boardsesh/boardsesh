# Boardsesh Entity Structure

This document is the canonical reference for how Boardsesh entities relate to each other. It describes every entity in the system — its properties, relationships, and current implementation status.

**Related document**: `docs/social-features-plan.md` describes the _how_ (implementation milestones, DB schemas, GraphQL types, frontend components). This document describes the _what_ (the conceptual entity graph and how everything fits together).

## Status Legend

- **[IMPLEMENTED]** — Schema exists, resolvers/UI built, deployed
- **[PARTIAL]** — Schema exists but planned enhancements are not yet built
- **[PLANNED]** — Designed but not yet implemented

---

## Entity Relationship Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           USERS                                         │
│  [IMPLEMENTED] NextAuth users + userProfiles + auroraCredentials        │
└──┬───────┬───────┬───────┬───────┬───────┬───────┬──────────────────────┘
   │       │       │       │       │       │       │
   │ follows       │  owns │  owns │ member│follows│ participates
   │ (user_follows)│       │       │  of   │       │  in
   │       │       │       │       │       │       │
   ▼       │       ▼       │       ▼       │       ▼
┌──────┐   │   ┌──────┐   │   ┌──────┐   │   ┌──────────┐
│Users │   │   │Boards│   │   │ Gyms │   │   │ Sessions │
│      │   │   │      │◄──┼───│      │   │   │          │
└──────┘   │   └──┬───┘   │   └──────┘   │   └────┬─────┘
           │      │       │              │        │
           │      │ has   │              │        │ 1:1
           │      │       │              │        ▼
           │      │       │              │   ┌──────────┐
           │      │       │              │   │  Queue   │
           │      │       │              │   │          │
           │      │       │              │   └──────────┘
           │      │       │              │
           │      ▼       │              │
           │  ┌──────────┐│              │
           │  │Controller││              │
           │  │ (ESP32)  ││              │
           │  └──────────┘│              │
           │              │              │
           ▼              ▼              ▼
       ┌──────┐      ┌──────┐      ┌──────┐
       │Boards│      │ Gyms │      │ Gyms │
       │(follow)     │(own) │      │(follow)
       └──────┘      └──────┘      └──────┘
```

### Relationship Summary

| From    | To         | Relationship          | Table/Mechanism                                               | Status        |
| ------- | ---------- | --------------------- | ------------------------------------------------------------- | ------------- |
| User    | User       | follows               | `user_follows`                                                | [IMPLEMENTED] |
| User    | Board      | owns                  | `user_boards.owner_id`                                        | [IMPLEMENTED] |
| User    | Board      | follows               | `board_follows`                                               | [IMPLEMENTED] |
| User    | Gym        | owns                  | `gyms.owner_id`                                               | [PLANNED]     |
| User    | Gym        | member of (with role) | `gym_members`                                                 | [PLANNED]     |
| User    | Gym        | follows               | `gym_follows`                                                 | [PLANNED]     |
| User    | Session    | participates in       | `board_session_clients`                                       | [IMPLEMENTED] |
| User    | Session    | created               | `board_sessions.created_by_user_id`                           | [IMPLEMENTED] |
| Board   | Gym        | belongs to            | `user_boards.gym_id`                                          | [PLANNED]     |
| Board   | Session    | hosts                 | `board_sessions.board_id`                                     | [IMPLEMENTED] |
| Board   | Controller | controlled by         | config matching (`boardName`, `layoutId`, `sizeId`, `setIds`) | [IMPLEMENTED] |
| Board   | Followers  | has followers         | `board_follows`                                               | [IMPLEMENTED] |
| Session | Queue      | has                   | `board_session_queues.session_id`                             | [IMPLEMENTED] |
| Session | Boards     | spans (multi-board)   | `session_boards` junction                                     | [PLANNED]     |
| Session | Ticks      | tracks ascents        | `boardsesh_ticks.session_id`                                  | [IMPLEMENTED] |
| Gym     | Boards     | contains              | `user_boards.gym_id`                                          | [PLANNED]     |

---

## Entities

### Users [IMPLEMENTED]

Users are NextAuth-managed accounts with optional Aurora (Kilter/Tension) credential linkage and social profiles.

**Core tables:**

| Table                 | Purpose                                         | Key file                                     |
| --------------------- | ----------------------------------------------- | -------------------------------------------- |
| `users`               | NextAuth user accounts (id, name, email, image) | `packages/db/src/schema/auth/users.ts`       |
| `accounts`            | OAuth provider accounts (Google, etc.)          | `packages/db/src/schema/auth/users.ts`       |
| `sessions`            | NextAuth session tokens                         | `packages/db/src/schema/auth/users.ts`       |
| `user_credentials`    | Email/password auth (password hashes)           | `packages/db/src/schema/auth/credentials.ts` |
| `user_profiles`       | Display name, avatar URL, Instagram URL         | `packages/db/src/schema/auth/credentials.ts` |
| `user_board_mappings` | Links NextAuth users to Aurora board user IDs   | `packages/db/src/schema/auth/mappings.ts`    |
| `aurora_credentials`  | Encrypted Aurora API credentials per board type | `packages/db/src/schema/auth/mappings.ts`    |

**Properties** (from `users` + `user_profiles`):

| Property       | Source                        | Notes                                           |
| -------------- | ----------------------------- | ----------------------------------------------- |
| `id`           | `users.id`                    | UUID PK                                         |
| `name`         | `users.name`                  | From OAuth or registration                      |
| `email`        | `users.email`                 | Unique                                          |
| `image`        | `users.image`                 | OAuth avatar                                    |
| `displayName`  | `user_profiles.display_name`  | Custom display name, falls back to `users.name` |
| `avatarUrl`    | `user_profiles.avatar_url`    | Custom avatar, falls back to `users.image`      |
| `instagramUrl` | `user_profiles.instagram_url` | Optional social link                            |

**Relationships:**

| Relationship             | Mechanism                                   | Status        |
| ------------------------ | ------------------------------------------- | ------------- |
| Follows other users      | `user_follows` (follower_id, following_id)  | [IMPLEMENTED] |
| Followed by other users  | `user_follows` reverse                      | [IMPLEMENTED] |
| Owns boards              | `user_boards.owner_id`                      | [IMPLEMENTED] |
| Follows boards           | `board_follows`                             | [IMPLEMENTED] |
| Owns gyms                | `gyms.owner_id`                             | [PLANNED]     |
| Member of gyms           | `gym_members`                               | [PLANNED]     |
| Follows gyms             | `gym_follows`                               | [PLANNED]     |
| Participates in sessions | `board_session_clients`                     | [IMPLEMENTED] |
| Creates sessions         | `board_sessions.created_by_user_id`         | [IMPLEMENTED] |
| Logs ascents             | `boardsesh_ticks.user_id`                   | [IMPLEMENTED] |
| Has Aurora credentials   | `aurora_credentials`, `user_board_mappings` | [IMPLEMENTED] |
| Has community roles      | `community_roles`                           | [IMPLEMENTED] |
| Has notifications        | `notifications.recipient_id`                | [IMPLEMENTED] |
| Has feed items           | `feed_items.recipient_id`                   | [IMPLEMENTED] |

---

### Gyms [PLANNED]

A gym represents a physical climbing location that contains one or more boards. Home wall users get an auto-created gym when they create their first board. Commercial gyms can have multiple boards and member management.

**Planned tables:** See `docs/social-features-plan.md` Milestone 10 for full schema.

| Table         | Purpose                                                          |
| ------------- | ---------------------------------------------------------------- |
| `gyms`        | Gym entity (name, slug, owner, address, coordinates, visibility) |
| `gym_members` | Junction table: users ↔ gyms with role (admin, member)           |
| `gym_follows` | Junction table: users follow gyms                                |

**Properties** (planned `gyms` table):

| Property        | Type               | Notes                |
| --------------- | ------------------ | -------------------- |
| `id`            | `bigserial`        | PK                   |
| `uuid`          | `text`             | Unique               |
| `name`          | `text`             | NOT NULL             |
| `slug`          | `text`             | Unique, URL-friendly |
| `owner_id`      | `text`             | FK → users.id        |
| `address`       | `text`             | Nullable             |
| `contact_email` | `text`             | Nullable             |
| `contact_phone` | `text`             | Nullable             |
| `latitude`      | `double precision` | Nullable             |
| `longitude`     | `double precision` | Nullable             |
| `is_public`     | `boolean`          | DEFAULT true         |
| `description`   | `text`             | Nullable             |
| `image_url`     | `text`             | Nullable             |

**Relationships:**

| Relationship    | Mechanism                             | Notes                       |
| --------------- | ------------------------------------- | --------------------------- |
| Owned by 1 user | `gyms.owner_id` FK → users            | Owner has full control      |
| Has members     | `gym_members` (user_id, gym_id, role) | Roles: admin, member        |
| Has followers   | `gym_follows` (user_id, gym_id)       | Public gyms can be followed |
| Contains boards | `user_boards.gym_id` FK → gyms        | 1:many                      |

**Auto-creation UX:**

- Creating a board when user has no gym → auto-creates a gym and links the board
- Creating a board when user has 1+ gym → prompts "Add to existing gym?" or "Create new gym"

---

### Boards [IMPLEMENTED, enhancements PLANNED]

A board represents a specific physical board installation — a climbing wall with a particular board type, layout, size, and hold set configuration. Users create boards to name their setups, track ascents, and enable leaderboards and social features.

**Table:** `user_boards` in `packages/db/src/schema/app/boards.ts`

**Current properties:**

| Property        | Type               | Notes                                    |
| --------------- | ------------------ | ---------------------------------------- |
| `id`            | `bigserial`        | PK                                       |
| `uuid`          | `text`             | Unique, client-generated                 |
| `slug`          | `text`             | Unique, URL-friendly                     |
| `owner_id`      | `text`             | FK → users.id, CASCADE                   |
| `board_type`    | `text`             | 'kilter', 'tension', etc.                |
| `layout_id`     | `bigint`           | Hold layout ID                           |
| `size_id`       | `bigint`           | Physical dimensions ID                   |
| `set_ids`       | `text`             | Comma-separated hold set IDs             |
| `name`          | `text`             | User-assigned name                       |
| `description`   | `text`             | Nullable                                 |
| `location_name` | `text`             | Nullable, gym/location label             |
| `latitude`      | `double precision` | Nullable                                 |
| `longitude`     | `double precision` | Nullable                                 |
| `is_public`     | `boolean`          | DEFAULT true                             |
| `is_owned`      | `boolean`          | DEFAULT true (vs. gym board user visits) |
| `created_at`    | `timestamp`        | DEFAULT now()                            |
| `updated_at`    | `timestamp`        | DEFAULT now()                            |
| `deleted_at`    | `timestamp`        | Nullable, soft delete                    |

**Planned additions:**

| Property   | Type                     | Notes                               | Milestone |
| ---------- | ------------------------ | ----------------------------------- | --------- |
| `gym_id`   | `bigint`                 | FK → gyms.id, ON DELETE SET NULL    | M10       |
| `location` | `geography(Point, 4326)` | PostGIS column for proximity search | M8        |

**Relationships:**

| Relationship     | Mechanism                                        | Status        |
| ---------------- | ------------------------------------------------ | ------------- |
| Owned by 1 user  | `user_boards.owner_id`                           | [IMPLEMENTED] |
| Belongs to 1 gym | `user_boards.gym_id` FK → gyms                   | [PLANNED]     |
| Has followers    | `board_follows`                                  | [IMPLEMENTED] |
| Has sessions     | `board_sessions.board_id` FK → user_boards       | [IMPLEMENTED] |
| Has controller   | `esp32_controllers` config matching              | [IMPLEMENTED] |
| Has ascents      | `boardsesh_ticks.board_id` FK → user_boards      | [IMPLEMENTED] |
| Has comments     | `comments` (entity_type='board', entity_id=uuid) | [IMPLEMENTED] |
| Has leaderboard  | Derived from `boardsesh_ticks` aggregation       | [IMPLEMENTED] |

**Relationship to URL routing:**
The existing route pattern `/{board_name}/{layout_id}/{size_id}/{set_ids}/{angle}` maps directly to a `user_boards` row (minus angle). When navigating to a board path, the app resolves which `user_board` the user is interacting with.

**Relationship to ESP32 controllers:**
`esp32_controllers` stores `board_name`, `layout_id`, `size_id`, `set_ids` matching the same config. A controller is associated with a board by matching these fields.

**Key constraints:**

- Unique: `(owner_id, board_type, layout_id, size_id, set_ids) WHERE deleted_at IS NULL` — no duplicate active boards per user
- Unique: `slug WHERE deleted_at IS NULL` — URL-friendly identifier

---

### Sessions [IMPLEMENTED, enhancements PLANNED]

A session represents a climbing session on one or more boards — the real-time party mode where users share a queue and take turns. Sessions are ephemeral by default but can be made permanent.

**Table:** `board_sessions` in `packages/db/src/schema/app/sessions.ts`

**Current properties:**

| Property             | Type               | Notes                                                                   |
| -------------------- | ------------------ | ----------------------------------------------------------------------- |
| `id`                 | `text`             | PK                                                                      |
| `board_path`         | `text`             | `/{board_type}/{layout_id}/{size_id}/{set_ids}`                         |
| `created_at`         | `timestamp`        | DEFAULT now()                                                           |
| `last_activity`      | `timestamp`        | DEFAULT now(), updated on interaction                                   |
| `status`             | `text`             | 'active', 'ended' (legacy CHECK also permits 'inactive', never written) |
| `latitude`           | `double precision` | Nullable, for discovery                                                 |
| `longitude`          | `double precision` | Nullable, for discovery                                                 |
| `discoverable`       | `boolean`          | DEFAULT false                                                           |
| `created_by_user_id` | `text`             | FK → users.id, SET NULL                                                 |
| `name`               | `text`             | Nullable, display name                                                  |
| `board_id`           | `bigint`           | FK → user_boards.id, SET NULL                                           |

**Planned additions:**

| Property       | Type        | Notes                                         | Milestone |
| -------------- | ----------- | --------------------------------------------- | --------- |
| `goal`         | `text`      | Nullable, session goal text                   | M11       |
| `is_public`    | `boolean`   | DEFAULT true                                  | M11       |
| `started_at`   | `timestamp` | Nullable, explicit start time                 | M11       |
| `ended_at`     | `timestamp` | Nullable, explicit or auto end time           | M11       |
| `is_permanent` | `boolean`   | DEFAULT false, exempt from auto-end           | M11       |
| `color`        | `text`      | Nullable, hex color for multi-session display | M11       |

**Related tables:**

| Table                   | Purpose                                                             | Status        |
| ----------------------- | ------------------------------------------------------------------- | ------------- |
| `board_session_clients` | Tracks connected users (id, sessionId, username, isLeader)          | [IMPLEMENTED] |
| `board_session_queues`  | Queue state (items JSONB, currentClimbQueueItem, version, sequence) | [IMPLEMENTED] |
| `session_boards`        | Junction for multi-board sessions (sessionId, boardId)              | [PLANNED]     |

**Relationships:**

| Relationship       | Mechanism                                     | Status        |
| ------------------ | --------------------------------------------- | ------------- |
| Created by 1 user  | `board_sessions.created_by_user_id`           | [IMPLEMENTED] |
| Has participants   | `board_session_clients`                       | [IMPLEMENTED] |
| Has 1 queue        | `board_session_queues` (1:1 via sessionId PK) | [IMPLEMENTED] |
| On 1 board         | `board_sessions.board_id` FK → user_boards    | [IMPLEMENTED] |
| On multiple boards | `session_boards` junction                     | [PLANNED]     |
| Has ascents        | `boardsesh_ticks.session_id`                  | [IMPLEMENTED] |

**Session lifecycle:**

1. **Active** — users are connected, queue is live
2. **Inactive** — no users connected, state preserved in Redis
3. **Ended** — explicitly closed or auto-ended after inactivity

**Auto-end behavior:**

- Periodic sweep (every 1 min) on `RoomManager` calls `endStaleInactiveSessions` to mark any session where `status='active'`, `is_permanent=false`, and `last_activity < NOW() - 1 hour` as `status='ended'` with `ended_at` stamped.
- Sessions with `is_permanent = true` are exempt.
- The web client lazily surfaces auto-ended sessions: on app open it pre-flights a `GET_SESSION_SUMMARY` against the persisted session and, if `endedAt` is truthy, opens the existing `SessionSummaryDialog` in `autoFinished` mode (title becomes "Session Finished").

---

### Session Modes [PLANNED]

Sessions can operate in different modes depending on the board/gym configuration.

#### Single-session board (default)

One active session per board. This is the current behavior.

- **Boardsesh display layout**: 2/3 width shows the current climb preview, 1/3 width shows a scrollable queue list
- Users interact with the shared queue
- "Next" / "Previous" navigation moves through the queue for everyone

#### Multi-session board

Multiple concurrent sessions on one board. Useful when multiple groups want to share a single physical board.

- **Boardsesh display layout**: 2/3 width shows the active session's current climb, 1/3 width shows colored session buttons
- Each session has an assigned color for visual distinction
- "My turn" button: pressing a session button claims the board's LEDs for that session's current climb
- Non-active sessions can still manipulate their queue without affecting the board LEDs
- Color auto-assignment when multiple sessions exist on one board

#### Multi-board session

One session spanning multiple boards from the same gym. Useful for circuit training or gym-wide sessions.

- All boards must belong to the same gym (enforced at app layer)
- Search finds climbs across all boards in the session
- Queue items include `boardId`/`boardPath` to identify which board each climb is for
- `ClimbQueueItem` gains optional `boardId` and `boardPath` fields
- Board switcher tabs in the session UI

---

### Queue [IMPLEMENTED]

The queue is the ordered list of climbs for a session. It's stored as JSONB and managed via optimistic concurrency control.

**Table:** `board_session_queues` in `packages/db/src/schema/app/sessions.ts`

**Properties:**

| Property                   | Type        | Notes                                     |
| -------------------------- | ----------- | ----------------------------------------- |
| `session_id`               | `text`      | PK, FK → board_sessions.id, CASCADE       |
| `queue`                    | `jsonb`     | Array of `ClimbQueueItem`                 |
| `current_climb_queue_item` | `jsonb`     | Currently active `ClimbQueueItem` or null |
| `version`                  | `integer`   | For optimistic locking                    |
| `sequence`                 | `integer`   | For event ordering                        |
| `updated_at`               | `timestamp` | DEFAULT now()                             |

**Relationships:**

- 1:1 with Session via `session_id` PK
- History/upcoming derived from `current_climb_queue_item` position within the `queue` array

**Planned enhancements (M12):**

- `ClimbQueueItem` gains optional `boardId` and `boardPath` fields for multi-board sessions

---

### Controllers (ESP32) [IMPLEMENTED]

Physical ESP32 devices that control board LEDs and display session information.

**Table:** `esp32_controllers` in `packages/db/src/schema/app/controllers.ts`

**Properties:**

| Property                | Type           | Notes                             |
| ----------------------- | -------------- | --------------------------------- |
| `id`                    | `uuid`         | PK, auto-generated                |
| `user_id`               | `text`         | FK → users.id, CASCADE (nullable) |
| `api_key`               | `varchar(64)`  | Unique, for API auth              |
| `name`                  | `varchar(100)` | Human-readable name               |
| `board_name`            | `varchar(20)`  | Board type ('kilter', 'tension')  |
| `layout_id`             | `integer`      | Layout configuration              |
| `size_id`               | `integer`      | Size configuration                |
| `set_ids`               | `varchar(100)` | Hold set IDs                      |
| `authorized_session_id` | `text`         | Currently authorized session      |
| `created_at`            | `timestamp`    | DEFAULT now()                     |
| `last_seen_at`          | `timestamp`    | Last heartbeat                    |

**Relationships:**

| Relationship           | Mechanism                                             | Status        |
| ---------------------- | ----------------------------------------------------- | ------------- |
| Owned by user          | `esp32_controllers.user_id`                           | [IMPLEMENTED] |
| Controls a board       | Config matching (boardName, layoutId, sizeId, setIds) | [IMPLEMENTED] |
| Authorized for session | `esp32_controllers.authorized_session_id`             | [IMPLEMENTED] |

**Planned display modes (M14):**

- **Single-session**: Board preview (2/3) + scrollable queue list (1/3)
- **Multi-session**: Board preview (2/3) + colored session buttons (1/3)
- Display mode auto-detected based on number of active sessions on the board

---

### Activity Feed [IMPLEMENTED, enhancements PLANNED]

The activity feed shows social activity from followed users and boards.

**Table:** `feed_items` in `packages/db/src/schema/app/feed.ts`

**Current properties:**

| Property       | Type                 | Notes                                               |
| -------------- | -------------------- | --------------------------------------------------- |
| `id`           | `bigserial`          | PK                                                  |
| `recipient_id` | `text`               | FK → users.id, CASCADE                              |
| `actor_id`     | `text`               | FK → users.id, SET NULL                             |
| `type`         | `feed_item_type`     | Enum: ascent, new_climb, comment, proposal_approved |
| `entity_type`  | `social_entity_type` | What entity this is about                           |
| `entity_id`    | `text`               | Specific entity identifier                          |
| `board_uuid`   | `text`               | Nullable, for board-scoped filtering                |
| `metadata`     | `jsonb`              | Denormalized rendering data                         |
| `created_at`   | `timestamp`          | DEFAULT now()                                       |

**Current features:**

- Fan-out-on-write: feed items materialized to each follower asynchronously
- Cursor-based pagination with `(created_at, id)` encoding
- Board-scoped filtering via `board_uuid`
- Sort modes: new, top, controversial, hot
- 180-day retention with periodic cleanup

**Planned enhancements (M13):**

| Enhancement                      | Description                                                               |
| -------------------------------- | ------------------------------------------------------------------------- |
| SSR with URL filtering           | Move filtering to URL search params for server-rendering and deep linking |
| Session summaries                | Group ascents by explicit `session_id`; solo ticks are not grouped        |
| Multi-user session summaries     | "Bob, Marco, Anton sent 32 problems"                                      |
| Grade bar chart in summaries     | Reuse `profile-stats-charts.tsx` pattern                                  |
| Hardest climbs slideshow         | Image slideshow of 5 hardest climbs per session                           |
| Proposal feed items              | Surface proposals from followed boards/climbs                             |
| @mentions                        | Parse `@username` in comments, autocomplete, notifications                |
| `session_id` on feed_items       | For session grouping                                                      |
| `session_summary` feed item type | New enum value                                                            |

---

### Ascents / Ticks [IMPLEMENTED]

Ascent records (ticks) track every climb attempt — successful (flash/send) or failed (attempt).

**Table:** `boardsesh_ticks` in `packages/db/src/schema/app/ascents.ts`

**Properties:**

| Property           | Type                | Notes                             |
| ------------------ | ------------------- | --------------------------------- |
| `id`               | `bigserial`         | PK                                |
| `uuid`             | `text`              | Unique                            |
| `user_id`          | `text`              | FK → users.id                     |
| `board_type`       | `text`              | 'kilter', 'tension'               |
| `climb_uuid`       | `text`              | Climb identifier                  |
| `angle`            | `integer`           | Board angle                       |
| `is_mirror`        | `boolean`           | Mirrored climb                    |
| `status`           | `tick_status`       | flash, send, attempt              |
| `attempt_count`    | `integer`           | Number of attempts                |
| `quality`          | `integer`           | 1-5 stars (nullable)              |
| `difficulty`       | `integer`           | Grade ID (nullable)               |
| `is_benchmark`     | `boolean`           | Benchmark designation             |
| `comment`          | `text`              | User comment                      |
| `climbed_at`       | `timestamp`         | When the climb happened           |
| `session_id`       | `text`              | FK → board_sessions.id (nullable) |
| `board_id`         | `bigint`            | FK → user_boards.id (nullable)    |
| `aurora_type`      | `aurora_table_type` | 'ascents' or 'bids'               |
| `aurora_id`        | `text`              | UUID in Aurora's system           |
| `aurora_synced_at` | `timestamp`         | Last sync time                    |

**Relationships:**

- Belongs to user (`user_id`)
- Optionally linked to session (`session_id`) — if tick was during party mode
- Optionally linked to board (`board_id`) — resolved from URL context
- Synced to Aurora API (`aurora_id`, `aurora_synced_at`)

---

### Social Entities [IMPLEMENTED]

The polymorphic social system (comments, votes, notifications) is built on a shared `social_entity_type` enum.

**Entity type registry:**

| `entity_type`    | Represents                | `entity_id` format             | Status        |
| ---------------- | ------------------------- | ------------------------------ | ------------- |
| `playlist_climb` | Climb within a playlist   | `{playlist_uuid}:{climb_uuid}` | [IMPLEMENTED] |
| `climb`          | Climb's global discussion | `{climb_uuid}`                 | [IMPLEMENTED] |
| `tick`           | User's ascent record      | tick `uuid`                    | [IMPLEMENTED] |
| `comment`        | Comment (for voting)      | comment `uuid`                 | [IMPLEMENTED] |
| `proposal`       | Community proposal        | proposal `uuid`                | [IMPLEMENTED] |
| `board`          | Board entity              | board `uuid`                   | [IMPLEMENTED] |
| `gym`            | Gym entity                | gym `uuid`                     | [PLANNED]     |

**Social tables:**

| Table                | Purpose                                     | Key file                                           |
| -------------------- | ------------------------------------------- | -------------------------------------------------- |
| `comments`           | Polymorphic comments with threading         | `packages/db/src/schema/app/social.ts`             |
| `votes`              | Up/downvotes on any entity                  | `packages/db/src/schema/app/social.ts`             |
| `notifications`      | User notifications                          | `packages/db/src/schema/app/notifications.ts`      |
| `feed_items`         | Materialized activity feed                  | `packages/db/src/schema/app/feed.ts`               |
| `climb_proposals`    | Community grade/classic/benchmark proposals | `packages/db/src/schema/app/proposals.ts`          |
| `proposal_votes`     | Weighted votes on proposals                 | `packages/db/src/schema/app/proposals.ts`          |
| `community_roles`    | Admin/leader role assignments               | `packages/db/src/schema/app/community-roles.ts`    |
| `community_settings` | Configurable proposal thresholds            | `packages/db/src/schema/app/community-settings.ts` |

---

## UI Sections

### Home Page

**Current:** Basic landing with authentication.

**Planned enhancements (M13):**

1. **"Jump back in" horizontal slider**
   - Shows boards the user has recently used (from recent ticks/sessions)
   - Each card: board name, last session date, quick "Start session" action
   - Horizontal scroll with snap points

2. **Activity feed**
   - Below the "Jump back in" slider
   - Board/friend filtering via pills
   - Sort mode selector (new, top, hot, controversial)
   - Default scope: user's default board

**Key files:** `packages/web/app/page.tsx`, `packages/web/app/components/home-page-content.tsx`

### Activity Feed UI

**Current:** Client-side filtering, cursor-paginated feed items.

**Planned (M13):**

- URL-driven filtering for SSR + deep linking (boardUuid, sortBy, topPeriod as search params)
- Session summary cards with grade bar charts and climb previews
- @mention autocomplete in comment forms
- Shareable feed URLs that SSR the same filtered view

### Boardsesh Display (ESP32)

**Current:** Basic LED control and queue navigation.

**Planned (M14):**

- **Single-session layout**: Board climb preview (2/3 width) + scrollable queue list (1/3 width, showing climb name, grade with color, setter)
- **Multi-session layout**: Board climb preview (2/3 width) + colored session buttons (1/3 width)
- Automatic layout switching when sessions are added/removed
- Session button interaction: touch → WebSocket message → turn claimed

---

## Cross-Cutting Concerns

### Soft Delete

Used for entities where deletion should preserve referential integrity:

- `user_boards` — preserves FK references from ticks/sessions
- `comments` — deleted comments show "[deleted]" if they have replies
- `gyms` [PLANNED] — preserves board associations

Hard delete is used for lightweight toggles:

- `user_follows`, `board_follows`, `gym_follows` [PLANNED] — trivially recreatable
- `votes`, `proposal_votes` — toggled on/off by design
- `notifications` — pruned by 90-day retention policy

### Aurora Integration

Users link their Aurora (Kilter/Tension) accounts via `aurora_credentials`. The mapping between NextAuth users and Aurora board users is tracked in `user_board_mappings`. Ascents logged in Boardsesh are synced to Aurora via background jobs.

### Real-Time Infrastructure

WebSocket-based real-time features use `graphql-ws` + Redis pub/sub:

- Session queue synchronization
- Live comment updates
- Notification delivery
- New climb feed updates

See `docs/websocket-implementation.md` for architecture details.
