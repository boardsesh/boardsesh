# Social Features Implementation Plan

This document describes the plan for adding social features to Boardsesh: comments, votes, follows, notifications, and an activity feed.

---

## Goals

1. **Comments** on climbs within public playlists (scoped per playlist)
2. **Comments** on climbs themselves (global discussion threads, independent from playlist context)
3. **Up/downvotes** on playlist climbs, ascents in the activity feed, and comments
4. **Follow system** so users can follow other climbers
5. **Activity feed** on the home page showing ascents from followed users, top comments, and trending content -- strictly chronological
6. **Real-time notifications** via WebSocket when someone follows you, replies to your comment, or votes on your content
7. **Live comment updates** via WebSocket so screens showing comments receive new comments in real time
8. A **well-abstracted, polymorphic system** for comments and votes that works across all entity types
9. **Community proposals** on climbs -- propose grade changes, classic status, and benchmark status, with community voting to approve. Grade and benchmark proposals are **angle-specific** (a grade proposal at 40° is independent from one at 45°). Classic proposals are **angle-independent** (a classic climb is classic at every angle).
10. **Admin and community leader roles** with weighted votes on proposals, configurable approval thresholds, and the ability to freeze climbs from further proposals
11. **Unified search** with a category pill (Climbs | Users | Playlists) in the search drawer. The home page shows the same search bar as the climb list, defaulting to "Users" search; the climb list page defaults to "Climbs" search.
12. **New climb notifications**: When someone you follow creates a new climb, you get a notification. A global "new climbs" feed is also available, subscribable per board + layout combination.
13. **Board entity**: Users can create named boards representing specific physical board installations (board type + layout + size + hold sets). Boards have a name, location, public/private visibility, and an ownership flag. Ascents are associated with the board they were climbed on, enabling future per-board leaderboards. The home page activity feed defaults to the user's owned board.

---

## Architecture Overview

### Design Principles

- **Polymorphic comments and votes**: A single `comments` table and a single `votes` table, each with an `entity_type` + `entity_id` discriminator. This avoids creating N separate tables per commentable/voteable entity.
- **Fan-out on write**: Feed items are materialized at write time into a per-user `feed_items` table. When a user logs an ascent, creates a climb, or posts a significant comment, the notification worker fans out a `feed_item` row to each of that user's followers. This makes feed queries simple, fast, and indexed -- no multi-source JOINs at read time. For unauthenticated users, a small fan-out-on-read approach is used for the public trending feed only (globally trending content is a bounded query that doesn't involve per-user follow graphs).
- **Cursor-based pagination** for the activity feed (better for constantly-changing datasets than offset).
- **Reddit-style ranking modes**: Four sort modes available across comments, feeds, and entity lists -- New (chronological), Top (highest score), Controversial (high engagement, divisive), and Hot (recent + high velocity). See [Ranking Algorithms](#ranking-algorithms) section for implementation details.
- **Real-time via existing WebSocket infrastructure**: Notifications and live comment updates use the same graphql-ws + Redis pub/sub system as party sessions.
- **Adjacent-angle outlier detection**: Grade proposals are automatically fast-tracked (auto-approved) when the existing grade at an angle is a statistical outlier compared to adjacent angles with strong ascent data. If neighboring angles agree the grade is significantly off, the system trusts the data and skips the voting process.
- **Board-type-specific tables**: Aurora tables are per-board-type (`kilter_climbs`, `tension_climbs`, `kilter_climb_stats`, etc.). Throughout this document, `board_climbs` and `board_climb_stats` are shorthand for the board-specific table (e.g., `kilterClimbs`, `tensionClimbs` in the Drizzle schema). All resolvers that reference these tables must dispatch based on `boardType` to query the correct table. This follows the same pattern already used in existing resolvers (tick/ascent resolvers, sync resolvers, etc.).
- **Server-side rendering** where possible for the feed. Interactive elements (vote buttons, comment forms) are client components embedded within server-rendered shells.
- **Rate limiting** on social mutations.
- **Board follow vs. new climb subscription** (intentionally independent):
  - **Board follow** (`followBoard`) = see activity from a specific physical board installation in your feed (ascents, comments, leaderboard changes). Scoped to one `user_boards` entity.
  - **New climb subscription** (`subscribeNewClimbs`) = get notified when ANY new climb is created for a board type + layout combination (across all physical boards with that config). Scoped to a `(boardType, layoutId)` pair.
  - Following a board does NOT auto-subscribe to new climbs for that config, and vice versa. The UI should make this distinction clear with different copy and placement.
- **Soft-delete pattern**: User-facing deletes use soft-delete (`deleted_at` timestamp) for safety and audit trails: `comments` (existing, for threaded coherence) and `user_boards` (preserves FK references from ticks/sessions). Exceptions where hard delete is correct: `user_follows` and `board_follows` (lightweight toggles, trivially recreatable), `votes` and `proposal_votes` (toggled on/off by design, re-voting recreates), `notifications` (pruned by retention policy after 90 days). `climb_proposals` use status-based lifecycle (`superseded`, `rejected`) which serves as logical soft-delete.
- **Message broker for notifications**: Mutations publish lightweight events to a Redis Streams-backed broker. A separate consumer pipeline handles notification creation, deduplication, persistence, and real-time delivery. This decouples mutation latency from notification fanout and makes the system horizontally scalable from day one.

### Entity Type Registry

The polymorphic system uses a string enum `entity_type` to identify what's being commented on or voted on.

| `entity_type`    | Represents                         | `entity_id` format             | Comment scope                       |
| ---------------- | ---------------------------------- | ------------------------------ | ----------------------------------- |
| `playlist_climb` | A climb within a specific playlist | `{playlist_uuid}:{climb_uuid}` | Scoped to that playlist             |
| `climb`          | A climb's global discussion thread | `{climb_uuid}`                 | Global across all contexts          |
| `tick`           | A user's ascent/attempt record     | tick `uuid`                    | Per-tick thread                     |
| `comment`        | A comment (for voting on comments) | comment `uuid`                 | N/A (votes only)                    |
| `proposal`       | A community proposal on a climb    | proposal `uuid`                | Discussion thread on the proposal   |
| `board`          | A user-created board entity        | board `uuid`                   | Board discussion / community thread |

The `session` entity type is backed by explicitly-created `board_sessions` rows. Solo ticks are not auto-grouped into sessions.

**Key distinction**: A climb can have comments in two independent scopes:

- `playlist_climb` with `entity_id = "{playlist_uuid}:{climb_uuid}"` -- discussion in the context of a curated playlist
- `climb` with `entity_id = "{climb_uuid}"` -- the climb's own global discussion (accessible from the climb detail view, search results, etc.)

### Ranking Algorithms

Four Reddit-style sort modes are available wherever sortable content is displayed (comments, playlist climb lists). The `sortBy` field in GraphQL inputs accepts these values:

> **Note**: The activity feed no longer uses sort modes. The home page now has three dedicated tabs — **Sessions** (chronological), **Proposals** (open first), and **Comments** (global feed) — each with board filtering. The `sortBy`/`topPeriod` fields have been removed from `ActivityFeedInput` — all activity feed queries now use chronological ordering.

#### `new` (Chronological)

```sql
ORDER BY created_at DESC
```

Pure reverse-chronological. Default for comment threads and the activity feed.

#### `top` (Highest Score)

```sql
ORDER BY (upvotes - downvotes) DESC, created_at DESC
```

Ranks by net score. Ties broken by recency. Can be combined with a time window filter (`topPeriod`: `hour`, `day`, `week`, `month`, `year`, `all`) to show "top this week", "top all time", etc.

#### `controversial` (Divisive)

Uses Reddit's controversy formula. A controversial item has a high total vote count but a score close to zero (roughly equal upvotes and downvotes).

```
controversy_score = (upvotes + downvotes) ^ balance_factor
where balance_factor = min(upvotes, downvotes) / max(upvotes, downvotes) if max > 0, else 0
```

In SQL (computed in the query):

```sql
ORDER BY
  CASE WHEN GREATEST(upvotes, downvotes) = 0 THEN 0
       ELSE POWER(upvotes + downvotes, LEAST(upvotes, downvotes)::float / GREATEST(upvotes, downvotes))
  END DESC,
  created_at DESC
```

Items with very few votes naturally score low. Items with many votes that are evenly split score highest.

#### `hot` (Trending)

Uses a time-decay formula inspired by Reddit's hot ranking. Recent items with high scores bubble up; older items decay.

```
hot_score = sign(score) * log10(max(|score|, 1)) + (created_epoch - reference_epoch) / 45000
```

Where:

- `score` = upvotes - downvotes
- `created_epoch` = Unix timestamp of creation (seconds)
- `reference_epoch` = a fixed reference point (e.g., app launch date as Unix timestamp)
- `45000` = decay constant (~12.5 hours per order of magnitude). Tunable.

In SQL:

```sql
ORDER BY
  SIGN(upvotes - downvotes) * LOG(GREATEST(ABS(upvotes - downvotes), 1))
  + EXTRACT(EPOCH FROM created_at - '2024-01-01'::timestamp) / 45000.0
  DESC
```

The `hot` sort is the default for entity discovery (e.g., "Discover playlists" could sort by hot).

#### Implementation Strategy

The ranking formulas are computed in SQL at query time using the `votes` table aggregation. For the initial implementation:

1. **Comments**: Sort computed inline via subquery that aggregates votes per comment
2. **Activity feed**: Always chronological (sort modes removed). Home page uses three tabs: Sessions, Proposals, Comments.
3. **Playlist climbs**: Sort computed via JOIN with `bulkVoteSummaries`-style aggregation

If performance becomes an issue (Milestone 9), the `vote_counts` materialized table can store pre-computed `upvotes`, `downvotes`, and `score` columns, making the ranking formulas simple column references instead of aggregations.

#### GraphQL Enum

```graphql
enum SortMode {
  new # Chronological (most recent first)
  top # Highest net score
  controversial # High engagement, divisive (close to 50/50 split)
  hot # Trending (recent + high vote velocity)
}

enum TimePeriod {
  hour
  day
  week
  month
  year
  all
}
```

---

## Phase 1: Database Schema (new tables)

All new tables in `packages/db/src/schema/app/`. Migrations via `bunx drizzle-kit generate` from `packages/db/`.

### 1.1 `social_entity_type` Postgres Enum

Values: `'playlist_climb'`, `'climb'`, `'tick'`, `'comment'`, `'proposal'`, `'board'`

Used in `comments`, `votes`, and `proposal_votes` tables.

### 1.2 `user_follows` table

```
packages/db/src/schema/app/follows.ts
```

| Column         | Type        | Notes                               |
| -------------- | ----------- | ----------------------------------- |
| `id`           | `bigserial` | PK                                  |
| `follower_id`  | `text`      | FK -> `users.id`, ON DELETE CASCADE |
| `following_id` | `text`      | FK -> `users.id`, ON DELETE CASCADE |
| `created_at`   | `timestamp` | DEFAULT now()                       |

**Constraints:**

- Unique index on `(follower_id, following_id)` -- can't follow the same person twice
- Check constraint: `follower_id != following_id` -- can't follow yourself

**Indexes:**

- `(follower_id)` -- "who do I follow?" queries
- `(following_id)` -- "who follows me?" / follower count queries

### 1.3 `comments` table

```
packages/db/src/schema/app/comments.ts
```

| Column              | Type                 | Notes                                              |
| ------------------- | -------------------- | -------------------------------------------------- |
| `id`                | `bigserial`          | PK                                                 |
| `uuid`              | `text`               | Unique, client-generated UUID                      |
| `user_id`           | `text`               | FK -> `users.id`, ON DELETE CASCADE                |
| `entity_type`       | `social_entity_type` | Enum value                                         |
| `entity_id`         | `text`               | Composite key identifying the entity               |
| `parent_comment_id` | `bigint`             | Nullable, FK -> `comments.id` (for threading)      |
| `body`              | `text`               | Comment text, max 2000 chars enforced at app layer |
| `created_at`        | `timestamp`          | DEFAULT now()                                      |
| `updated_at`        | `timestamp`          | DEFAULT now()                                      |
| `deleted_at`        | `timestamp`          | Nullable, soft delete for threaded comments        |

**Indexes:**

- `(entity_type, entity_id, created_at)` -- fetch comments for an entity, ordered by time
- `(user_id, created_at)` -- "my comments" / user activity queries
- `(parent_comment_id)` -- fetch replies to a comment

**Notes:**

- Soft delete (`deleted_at`) so reply threads remain coherent. A deleted comment shows as "[deleted]" if it has replies.
- UI caps reply nesting at 1 level (flat replies, like YouTube/Reddit mobile).
- **Comments are editable in perpetuity** -- no time-based edit window. The `updated_at` column tracks edits, and the UI shows an "(edited)" indicator when `updated_at > created_at`.

### 1.4 `votes` table

```
packages/db/src/schema/app/votes.ts
```

| Column        | Type                 | Notes                               |
| ------------- | -------------------- | ----------------------------------- |
| `id`          | `bigserial`          | PK                                  |
| `user_id`     | `text`               | FK -> `users.id`, ON DELETE CASCADE |
| `entity_type` | `social_entity_type` | Same enum as comments               |
| `entity_id`   | `text`               | Same format as comments             |
| `value`       | `integer`            | `+1` (upvote) or `-1` (downvote)    |
| `created_at`  | `timestamp`          | DEFAULT now()                       |

**Constraints:**

- Unique index on `(user_id, entity_type, entity_id)` -- one vote per user per entity

**Indexes:**

- `(entity_type, entity_id)` -- aggregate vote count for an entity
- `(user_id)` -- "my votes" for fetching user's vote state in bulk

**Votes on comments:** Use `entity_type = 'comment'` with `entity_id = comment.uuid`. The votes table is fully self-referential.

### 1.5 `notifications` table

```
packages/db/src/schema/app/notifications.ts
```

| Column         | Type                 | Notes                                                             |
| -------------- | -------------------- | ----------------------------------------------------------------- |
| `id`           | `bigserial`          | PK                                                                |
| `uuid`         | `text`               | Unique                                                            |
| `recipient_id` | `text`               | FK -> `users.id`, ON DELETE CASCADE                               |
| `actor_id`     | `text`               | FK -> `users.id`, ON DELETE SET NULL (who triggered it)           |
| `type`         | `notification_type`  | Enum (see below)                                                  |
| `entity_type`  | `social_entity_type` | Nullable, what the notification is about                          |
| `entity_id`    | `text`               | Nullable, the specific entity                                     |
| `comment_id`   | `bigint`             | Nullable, FK -> `comments.id` (for comment-related notifications) |
| `read_at`      | `timestamp`          | Nullable, when the user read it                                   |
| `created_at`   | `timestamp`          | DEFAULT now()                                                     |

**`notification_type` enum values:**

- `new_follower` -- someone followed you
- `new_climb` -- someone you follow created a new climb
- `new_climb_global` -- a new climb was created on a board+layout you subscribe to (global feed)
- `comment_reply` -- someone replied to your comment
- `comment_on_tick` -- someone commented on your ascent
- `comment_on_climb` -- someone commented on a climb you created (global climb discussion)
- `vote_on_tick` -- someone voted on your ascent
- `vote_on_comment` -- someone voted on your comment
- `proposal_approved` -- a proposal you created or voted on was approved
- `proposal_rejected` -- a proposal you created was rejected by an admin/leader
- `proposal_vote` -- someone voted on your proposal

**Indexes:**

- `(recipient_id, read_at, created_at)` -- unread notifications for a user, ordered by time
- `(recipient_id, created_at)` -- all notifications for a user
- `(actor_id, recipient_id, type, entity_id)` -- deduplication check (e.g., don't send 100 vote notifications from same actor on same entity)

**Notes:**

- Notifications are persisted to DB for history (read/unread state survives disconnection).
- Real-time delivery is via WebSocket pub/sub (see Phase 5).
- Deduplication: For high-frequency events (votes), batch or deduplicate so a user doesn't get 50 notifications from 50 upvotes. Strategy: one notification per `(actor, type, entity)` tuple, updated on each new occurrence rather than inserting new rows.
- **Retention policy**: Hard delete notifications older than 90 days via a periodic cleanup job (scheduled task or cron). `DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '90 days'`. No distinction between read/unread -- after 90 days, all are pruned. This keeps the table bounded and the retention window is generous enough that users won't miss anything actionable.

### 1.6 `new_climb_subscriptions` table

```
packages/db/src/schema/app/new-climb-subscriptions.ts
```

Allows users to subscribe to the global "new climbs" feed for specific board + layout combinations. When a new climb is created on a subscribed board+layout, the user receives a notification.

| Column       | Type        | Notes                                                      |
| ------------ | ----------- | ---------------------------------------------------------- |
| `id`         | `bigserial` | PK                                                         |
| `user_id`    | `text`      | FK -> `users.id`, ON DELETE CASCADE                        |
| `board_type` | `text`      | Board type to subscribe to (e.g., `'kilter'`, `'tension'`) |
| `layout_id`  | `integer`   | Layout ID within the board type                            |
| `created_at` | `timestamp` | DEFAULT now()                                              |

**Constraints:**

- Unique index on `(user_id, board_type, layout_id)` -- one subscription per user per board+layout

**Indexes:**

- `(user_id)` -- "what am I subscribed to?" queries
- `(board_type, layout_id)` -- "who is subscribed to this board+layout?" (for notification fanout)

**Notes:**

- This is separate from the follow system. Following a user notifies you of _their_ new climbs. This subscription notifies you of _all_ new climbs on a board+layout, regardless of who created them.
- Users can subscribe to multiple board+layout combinations.
- The notification fanout for popular board+layouts could be large, so this goes through the Redis Streams broker (Phase 5).

### 1.7 `user_boards` table

```
packages/db/src/schema/app/boards.ts
```

Represents a specific physical board installation that a user creates, names, and optionally shares publicly. A board is defined by its hardware configuration (`board_type` + `layout_id` + `size_id` + `set_ids`) plus user-provided metadata (name, location).

This is distinct from Aurora's `board_walls` table (which tracks serial numbers and is keyed to Aurora users). `user_boards` is a Boardsesh-native entity for social features, leaderboards, and activity scoping.

| Column          | Type                     | Notes                                                                                                                                                                                                                                                 |
| --------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | `bigserial`              | PK                                                                                                                                                                                                                                                    |
| `uuid`          | `text`                   | Unique, client-generated UUID                                                                                                                                                                                                                         |
| `owner_id`      | `text`                   | FK -> `users.id`, ON DELETE CASCADE. The user who created this board entry.                                                                                                                                                                           |
| `board_type`    | `text`                   | `'kilter'`, `'tension'`, etc.                                                                                                                                                                                                                         |
| `layout_id`     | `integer`                | FK -> `board_layouts(board_type, id)`. The hold layout.                                                                                                                                                                                               |
| `size_id`       | `integer`                | FK -> `board_product_sizes(board_type, id)`. Physical dimensions.                                                                                                                                                                                     |
| `set_ids`       | `text`                   | Comma-separated hold set IDs (e.g., `"12,13"`). Matches the URL segment format.                                                                                                                                                                       |
| `name`          | `text`                   | User-assigned name (e.g., "Home Board", "Brooklyn Boulders Kilter")                                                                                                                                                                                   |
| `description`   | `text`                   | Nullable. Optional description or notes.                                                                                                                                                                                                              |
| `location_name` | `text`                   | Nullable. Gym name or location label (e.g., "Brooklyn Boulders Queensbridge")                                                                                                                                                                         |
| `latitude`      | `double precision`       | Nullable. GPS latitude for display and input convenience.                                                                                                                                                                                             |
| `longitude`     | `double precision`       | Nullable. GPS longitude for display and input convenience.                                                                                                                                                                                            |
| `location`      | `geography(Point, 4326)` | **Deferred to Milestone 8.** Nullable. PostGIS geography point derived from `latitude`/`longitude`. Used for efficient proximity queries. Not created in the initial Milestone 3 migration -- added via `ALTER TABLE` when proximity search is built. |
| `is_public`     | `boolean`                | DEFAULT true. Whether this board is discoverable by other users.                                                                                                                                                                                      |
| `is_owned`      | `boolean`                | DEFAULT true. Whether the user physically owns this board (vs. just climbs on it, e.g., a gym board).                                                                                                                                                 |
| `created_at`    | `timestamp`              | DEFAULT now()                                                                                                                                                                                                                                         |
| `updated_at`    | `timestamp`              | DEFAULT now()                                                                                                                                                                                                                                         |
| `deleted_at`    | `timestamp`              | Nullable. Soft-delete timestamp. When set, the board is excluded from all queries, search results, and feeds.                                                                                                                                         |

**Constraints:**

- Unique index on `(owner_id, board_type, layout_id, size_id, set_ids) WHERE deleted_at IS NULL` -- a user can't create duplicate boards with the same hardware config. If they climb at two gyms with identical setups, they can differentiate by name/location but the config must differ (or they use the same board entry). Soft-deleted boards don't count toward uniqueness.

**Indexes:**

- `(owner_id, is_owned) WHERE deleted_at IS NULL` -- "my boards" (owned boards first)
- `(board_type, layout_id, is_public) WHERE deleted_at IS NULL` -- discover public boards
- GiST index on `(location) WHERE is_public = true AND deleted_at IS NULL` -- PostGIS proximity search for nearby boards (**deferred to Milestone 8**, added alongside the `location` column)

**PostGIS note (Milestone 8):**

- The `location` column and GiST index are **not created in Milestone 3**. Initially, only `latitude` and `longitude` (plain `double precision`) are stored for display purposes. In Milestone 8, when unified search with proximity is built, a migration adds: `CREATE EXTENSION IF NOT EXISTS postgis;` then `ALTER TABLE user_boards ADD COLUMN location geography(Point, 4326)` plus the GiST index. A backfill query populates `location` from existing `latitude`/`longitude` values: `UPDATE user_boards SET location = ST_MakePoint(longitude, latitude)::geography WHERE latitude IS NOT NULL AND longitude IS NOT NULL`.
- Neon DB fully supports the PostGIS extension. The `location` column uses `geography(Point, 4326)` for accurate Earth-surface distance calculations. The resolver converts `latitude`/`longitude` input to the `location` column: `ST_MakePoint(longitude, latitude)::geography`.
- The `CreateBoardInput` and `UpdateBoardInput` GraphQL inputs accept `latitude`/`longitude` (the resolver converts to geography internally). The `UserBoard` GraphQL type returns `latitude`/`longitude` for display. Once Milestone 8 is deployed, the `createBoard`/`updateBoard` resolvers also populate the `location` geography column.

**Relationship to URL routing:**
The existing route pattern `/{board_name}/{layout_id}/{size_id}/{set_ids}/{angle}` maps directly to a `user_boards` row (minus angle, which varies per session). When the user navigates to a board path, the app can resolve which `user_board` they're using.

**Relationship to sessions:**
`board_sessions.board_path` encodes the same `/{board_type}/{layout_id}/{size_id}/{set_ids}` config. A session can be linked to a `user_board` by matching these fields.

**Relationship to ESP32 controllers:**
`esp32_controllers` already stores `board_name`, `layout_id`, `size_id`, `set_ids`. A controller can be associated with a `user_board` by matching config.

### 1.8 `community_roles` table

```
packages/db/src/schema/app/community-roles.ts
```

| Column       | Type                  | Notes                                              |
| ------------ | --------------------- | -------------------------------------------------- |
| `id`         | `bigserial`           | PK                                                 |
| `user_id`    | `text`                | FK -> `users.id`, ON DELETE CASCADE                |
| `role`       | `community_role_type` | Enum: `'admin'`, `'community_leader'`              |
| `board_type` | `text`                | Nullable. NULL = global, otherwise scoped to board |
| `granted_by` | `text`                | FK -> `users.id`, ON DELETE SET NULL               |
| `created_at` | `timestamp`           | DEFAULT now()                                      |

**`community_role_type` enum values:**

- `admin` -- Full platform admin. Can do everything: manage roles, configure settings, override proposals, freeze/unfreeze climbs globally.
- `community_leader` -- Elevated community member. Can configure proposal thresholds per climb, freeze/unfreeze climbs within their board scope, and their proposal votes carry extra weight.

**Constraints:**

- Unique index on `(user_id, role, board_type)` -- one role assignment per user per scope

**Indexes:**

- `(user_id)` -- look up a user's roles
- `(role, board_type)` -- find all leaders for a board

**Notes:**

- `board_type` scoping: A community leader with `board_type = 'kilter'` has authority only over Kilter climbs. An admin with `board_type = NULL` has global authority.
- Admins can grant/revoke both `admin` and `community_leader` roles. Community leaders cannot grant roles.

### 1.9 `community_settings` table

```
packages/db/src/schema/app/community-settings.ts
```

Global and per-climb configuration for the proposal system.

| Column       | Type        | Notes                                                                  |
| ------------ | ----------- | ---------------------------------------------------------------------- |
| `id`         | `bigserial` | PK                                                                     |
| `scope`      | `text`      | `'global'`, `'board'`, or `'climb'`                                    |
| `scope_key`  | `text`      | NULL for global, board_type for board, `{climbUuid}:{angle}` for climb |
| `key`        | `text`      | Setting name (see below)                                               |
| `value`      | `text`      | Setting value (stored as text, parsed by app)                          |
| `set_by`     | `text`      | FK -> `users.id`, ON DELETE SET NULL                                   |
| `created_at` | `timestamp` | DEFAULT now()                                                          |
| `updated_at` | `timestamp` | DEFAULT now()                                                          |

**Constraints:**

- Unique index on `(scope, scope_key, key)` -- one value per setting per scope

**Setting keys:**

| Key                           | Default | Description                                                                                                     |
| ----------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `proposal_approval_threshold` | `3`     | Number of upvotes required to approve a proposal                                                                |
| `admin_vote_weight`           | `3`     | How many votes an admin's vote counts as                                                                        |
| `leader_vote_weight`          | `2`     | How many votes a community leader's vote counts as                                                              |
| `climb_frozen`                | `false` | Whether proposals are blocked on this climb/angle                                                               |
| `freeze_reason`               | NULL    | Optional reason displayed when a climb is frozen                                                                |
| `outlier_min_ascents`         | `10`    | Minimum `ascensionist_count` at each adjacent angle for outlier detection to apply                              |
| `outlier_grade_diff`          | `2`     | Minimum grade difference (difficulty units) between the target angle and its neighbors to qualify as an outlier |

**Scope resolution order (most specific wins):**

1. `climb` scope with `scope_key = "{climbUuid}:{angle}"` -- per-climb-angle override
2. `board` scope with `scope_key = "{boardType}"` -- per-board default
3. `global` scope with `scope_key = NULL` -- platform-wide default

Example: A community leader can set `proposal_approval_threshold = 5` for a specific popular climb at a specific angle, overriding the global default of 3.

### 1.10 `climb_proposals` table

```
packages/db/src/schema/app/proposals.ts
```

| Column           | Type              | Notes                                                                                                                                                   |
| ---------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | `bigserial`       | PK                                                                                                                                                      |
| `uuid`           | `text`            | Unique                                                                                                                                                  |
| `climb_uuid`     | `text`            | FK -> `board_climbs.uuid`                                                                                                                               |
| `board_type`     | `text`            | Board type for the climb                                                                                                                                |
| `angle`          | `integer`         | **Nullable.** The angle this proposal applies to. NULL for classic proposals (which are angle-independent). Required for grade and benchmark proposals. |
| `proposer_id`    | `text`            | FK -> `users.id`, ON DELETE CASCADE                                                                                                                     |
| `type`           | `proposal_type`   | Enum: `'grade'`, `'classic'`, `'benchmark'`                                                                                                             |
| `proposed_value` | `text`            | The proposed new value (see below)                                                                                                                      |
| `current_value`  | `text`            | The value at the time of proposal (for context)                                                                                                         |
| `status`         | `proposal_status` | Enum: `'open'`, `'approved'`, `'rejected'`, `'superseded'`                                                                                              |
| `reason`         | `text`            | Optional explanation from proposer                                                                                                                      |
| `resolved_at`    | `timestamp`       | When the proposal was approved/rejected                                                                                                                 |
| `resolved_by`    | `text`            | Nullable. FK -> `users.id`. NULL = auto-approved by votes, user ID = manually resolved by admin/leader                                                  |
| `created_at`     | `timestamp`       | DEFAULT now()                                                                                                                                           |

**`proposal_type` enum values:**

- `grade` -- Propose a new difficulty grade for this climb at this angle. **Angle-specific.**
- `classic` -- Propose this climb be designated as a "classic". **Angle-independent** (a classic climb is classic at every angle). `angle` is NULL.
- `benchmark` -- Propose this climb be designated as a "benchmark" at this angle. **Angle-specific.** A benchmark designation means the community grade has strong consensus at that angle, so benchmark is inherently tied to the grade and angle.

**`proposal_status` enum values:**

- `open` -- Active, accepting votes
- `approved` -- Reached threshold or admin-approved. Effect has been applied.
- `rejected` -- Admin/leader rejected it
- `superseded` -- A newer proposal of the same type for the same climb+angle replaced this one

**`proposed_value` format by type:**

- `grade`: The difficulty grade ID as string (e.g., `"16"` for V5). Maps to `board_difficulty_grades.difficulty`.
- `classic`: `"true"` or `"false"` (toggle classic status)
- `benchmark`: `"true"` or `"false"` (toggle benchmark status)

**`current_value` format:** Same as `proposed_value` -- captures the state at proposal time so voters can see what's changing.

**Constraints:**

- Only one `open` proposal per `(climb_uuid, angle, type)` at a time. New proposals of the same type supersede the existing open one (set old one to `superseded`).
- For classic proposals (`angle = NULL`): only one open classic proposal per `(climb_uuid, type)`. Use a partial unique index or app-layer enforcement.

**Indexes:**

- `(climb_uuid, angle, type, status)` -- find open proposals for a climb at an angle (grade/benchmark)
- `(climb_uuid, type, status) WHERE angle IS NULL` -- find open classic proposals for a climb
- `(proposer_id, created_at)` -- "my proposals" query
- `(status, created_at)` -- browse open proposals
- `(board_type, status)` -- browse by board

### 1.11 `proposal_votes` table

```
packages/db/src/schema/app/proposals.ts
```

Separate from the general `votes` table because proposal votes have special semantics (weighted votes, threshold-based auto-approval).

| Column        | Type        | Notes                                                                |
| ------------- | ----------- | -------------------------------------------------------------------- |
| `id`          | `bigserial` | PK                                                                   |
| `proposal_id` | `bigint`    | FK -> `climb_proposals.id`, ON DELETE CASCADE                        |
| `user_id`     | `text`      | FK -> `users.id`, ON DELETE CASCADE                                  |
| `value`       | `integer`   | `+1` (support) or `-1` (oppose)                                      |
| `weight`      | `integer`   | Effective weight of this vote (default 1, higher for admins/leaders) |
| `created_at`  | `timestamp` | DEFAULT now()                                                        |

**Constraints:**

- Unique index on `(proposal_id, user_id)` -- one vote per user per proposal

**Indexes:**

- `(proposal_id)` -- aggregate votes for a proposal

**Notes:**

- `weight` is computed at vote time based on the voter's `community_roles`:
  - Regular user: `weight = 1`
  - Community leader (matching board scope): `weight = leader_vote_weight` setting (default 2)
  - Admin: `weight = admin_vote_weight` setting (default 3)
- The proposer automatically gets a +1 vote with their role's weight when creating the proposal.
- **Auto-approval check**: After each vote, compute `SUM(value * weight) WHERE value > 0` (weighted upvotes). If this meets or exceeds the `proposal_approval_threshold` for that climb+angle, the proposal is automatically approved and its effect applied.

### 1.12 `climb_community_status` table (angle-specific)

```
packages/db/src/schema/app/proposals.ts
```

Stores **angle-specific** community-determined metadata for climbs (separate from Aurora's `board_climb_stats` which comes from sync). This is where approved grade and benchmark proposals take effect.

| Column             | Type        | Notes                                                                                            |
| ------------------ | ----------- | ------------------------------------------------------------------------------------------------ |
| `id`               | `bigserial` | PK                                                                                               |
| `climb_uuid`       | `text`      | FK -> `board_climbs.uuid`                                                                        |
| `board_type`       | `text`      | Board type                                                                                       |
| `angle`            | `integer`   | Angle this status applies to                                                                     |
| `community_grade`  | `integer`   | Nullable. Community-voted difficulty grade ID                                                    |
| `is_benchmark`     | `boolean`   | DEFAULT false. Community benchmark designation. Tied to community grade consensus at this angle. |
| `updated_at`       | `timestamp` | DEFAULT now()                                                                                    |
| `last_proposal_id` | `bigint`    | FK -> `climb_proposals.id`. Most recent approved proposal that modified this row                 |

**Constraints:**

- Unique index on `(climb_uuid, board_type, angle)` -- one community status per climb per angle

**Notes:**

- This table is the "output" of the proposal system for **angle-specific** proposals (grade and benchmark).
- The climb detail UI shows both Aurora's official grade and the community grade (if different), allowing users to see both perspectives.
- `community_grade` is nullable -- NULL means no community override, use Aurora's grade.
- **Benchmark means strong grade consensus**: A climb is marked as a benchmark at a specific angle when the community is confident in the grade at that angle. Benchmark is inherently tied to the grade and angle.

### 1.13 `climb_classic_status` table (angle-independent)

```
packages/db/src/schema/app/proposals.ts
```

Stores **angle-independent** classic status for climbs. Classic means "this is a great climb worth doing" and applies to the climb as a whole, regardless of angle.

| Column             | Type        | Notes                                                                            |
| ------------------ | ----------- | -------------------------------------------------------------------------------- |
| `id`               | `bigserial` | PK                                                                               |
| `climb_uuid`       | `text`      | FK -> `board_climbs.uuid`                                                        |
| `board_type`       | `text`      | Board type                                                                       |
| `is_classic`       | `boolean`   | DEFAULT false. Community classic designation                                     |
| `updated_at`       | `timestamp` | DEFAULT now()                                                                    |
| `last_proposal_id` | `bigint`    | FK -> `climb_proposals.id`. Most recent approved proposal that modified this row |

**Constraints:**

- Unique index on `(climb_uuid, board_type)` -- one classic status per climb (not per angle)

**Notes:**

- Classic status is **angle-independent**: a classic climb is classic at every angle.
- This table is the "output" of the proposal system for classic proposals.
- Separated from `climb_community_status` because classic has no angle dimension.

### 1.14 `board_follows` table

```
packages/db/src/schema/app/board-follows.ts
```

Tracks which users follow which board entities. Separate from `user_follows` (user-to-user) because the target is a board, not a user.

| Column       | Type        | Notes                                       |
| ------------ | ----------- | ------------------------------------------- |
| `id`         | `bigserial` | PK                                          |
| `user_id`    | `text`      | FK -> `users.id`, ON DELETE CASCADE         |
| `board_uuid` | `text`      | FK -> `user_boards.uuid`, ON DELETE CASCADE |
| `created_at` | `timestamp` | DEFAULT now()                               |

**Constraints:**

- Unique index on `(user_id, board_uuid)` -- can't follow the same board twice

**Indexes:**

- `(user_id)` -- "which boards do I follow?" queries
- `(board_uuid)` -- "who follows this board?" / follower count queries

**Notes:**

- Hard delete on unfollow (follows are lightweight toggles, no soft-delete needed).
- Only public boards can be followed (enforced at app layer). If a board is made private, existing follows remain but no new activity is surfaced until the board is public again.

### 1.15 `vote_counts` materialized table (optional, Phase 10 optimization)

If `COUNT()` becomes slow:

| Column        | Type                            |
| ------------- | ------------------------------- |
| `entity_type` | `social_entity_type`            |
| `entity_id`   | `text`                          |
| `upvotes`     | `integer`                       |
| `downvotes`   | `integer`                       |
| `score`       | `integer` (upvotes - downvotes) |

Updated via trigger or periodic refresh. **Not needed for initial launch.**

### 1.16 Schema modifications to existing tables

**`boardsesh_ticks`** -- add `board_id` column:

| Column     | Type     | Notes                                                                                      |
| ---------- | -------- | ------------------------------------------------------------------------------------------ |
| `board_id` | `bigint` | Nullable. FK -> `user_boards.id`, ON DELETE SET NULL. The board this ascent was logged on. |

- Nullable because existing ticks predate the board entity, and users may log climbs without associating a board.
- New index: `(board_id, climbed_at)` -- per-board leaderboard queries, ordered by time.
- New index: `(board_id, user_id)` -- per-board per-user stats.
- When logging a tick from within a board context (the user has navigated to `/{board_type}/{layout_id}/{size_id}/{set_ids}/{angle}`), the app resolves the matching `user_board` and auto-populates `board_id`. If the user doesn't have a matching board entry, `board_id` is NULL (they can create one later).

**`board_sessions`** -- add `board_id` column:

| Column     | Type     | Notes                                                                                |
| ---------- | -------- | ------------------------------------------------------------------------------------ |
| `board_id` | `bigint` | Nullable. FK -> `user_boards.id`, ON DELETE SET NULL. Links session to a user board. |

- Resolved by matching `board_sessions.board_path` against `user_boards` config fields.
- Allows filtering sessions by board.

### 1.17 `feed_items` table (fan-out-on-write activity feed)

```
packages/db/src/schema/app/feed.ts
```

Materialized feed items. Each row represents one feed item visible to one recipient user. Created asynchronously by the notification worker when social events occur (ascent logged, climb created, comment posted, proposal approved, etc.).

| Column         | Type                 | Notes                                                                                    |
| -------------- | -------------------- | ---------------------------------------------------------------------------------------- |
| `id`           | `bigserial`          | PK                                                                                       |
| `recipient_id` | `text`               | FK -> `users.id`, ON DELETE CASCADE. Who sees this feed item.                            |
| `actor_id`     | `text`               | FK -> `users.id`, ON DELETE SET NULL. Who performed the action.                          |
| `type`         | `feed_item_type`     | Enum: `'ascent'`, `'new_climb'`, `'comment'`, `'proposal_approved'`                      |
| `entity_type`  | `social_entity_type` | What entity this is about                                                                |
| `entity_id`    | `text`               | The specific entity                                                                      |
| `board_uuid`   | `text`               | Nullable. For board-scoped feed filtering. FK -> `user_boards.uuid`.                     |
| `metadata`     | `jsonb`              | Type-specific denormalized data for rendering (climb name, grade, user avatar URL, etc.) |
| `created_at`   | `timestamp`          | DEFAULT now(). The event timestamp.                                                      |

**`feed_item_type` enum values:**

- `ascent` -- A followed user logged a completed ascent (flash/send)
- `new_climb` -- A followed user created a new climb
- `comment` -- A significant comment on a trending entity
- `proposal_approved` -- A community proposal was approved

**Indexes:**

- `(recipient_id, created_at DESC)` -- primary feed query
- `(recipient_id, board_uuid, created_at DESC)` -- board-scoped feed query
- `(actor_id, created_at DESC)` -- "my activity" / cleanup
- `(created_at)` -- retention cleanup

**How it works:**

- When a user logs an ascent, the notification worker fans out a `feed_item` row to each of that user's followers. Same for new climbs, significant comments, and approved proposals.
- The feed query becomes: `SELECT * FROM feed_items WHERE recipient_id = $me ORDER BY created_at DESC LIMIT 20` -- fast, indexed, no JOINs.
- Board-scoped feed: `WHERE recipient_id = $me AND board_uuid = $boardUuid ORDER BY created_at DESC`
- The `metadata` JSONB column stores denormalized rendering data (climb name, grade, user avatar URL, etc.) so the feed can render without JOINing back to source tables.
- Fan-out happens asynchronously via the Redis Streams notification worker (same pipeline as notifications), so mutation latency isn't affected.
- **Retention**: Hard delete feed items older than 180 days (6 months) via periodic cleanup. `DELETE FROM feed_items WHERE created_at < NOW() - INTERVAL '180 days'`

**Notes:**

- Cursor-based pagination uses `(created_at, id)` encoded as base64.
- For `top`/`hot`/`controversial` sort modes, vote data can be stored in `metadata` (updated periodically) or JOINed from `votes` at query time (acceptable since the result set is already filtered to one user's feed).

---

## Phase 2: GraphQL Schema Extensions

Extend `packages/shared-schema/src/schema.ts`.

### 2.1 New Types

```graphql
enum SocialEntityType {
  playlist_climb
  climb
  tick
  comment
  proposal
  board
}

type Comment {
  uuid: ID!
  userId: ID!
  userDisplayName: String
  userAvatarUrl: String
  entityType: SocialEntityType!
  entityId: String!
  parentCommentId: ID
  body: String!
  createdAt: String!
  updatedAt: String!
  isEdited: Boolean!
  isDeleted: Boolean!
  # Computed fields
  replyCount: Int!
  upvotes: Int!
  downvotes: Int!
  voteScore: Int! # upvotes - downvotes
  userVote: Int # +1, -1, or null if not voted (requires auth)
}

type CommentConnection {
  comments: [Comment!]!
  totalCount: Int!
  hasMore: Boolean!
}

type VoteSummary {
  entityType: SocialEntityType!
  entityId: String!
  upvotes: Int!
  downvotes: Int!
  score: Int!
  userVote: Int # +1, -1, or null
}

type FollowConnection {
  users: [PublicUserProfile!]!
  totalCount: Int!
  hasMore: Boolean!
}

type PublicUserProfile {
  id: ID!
  displayName: String
  avatarUrl: String
  followerCount: Int!
  followingCount: Int!
  isFollowedByMe: Boolean! # requires auth
}

# --- Notifications ---

enum NotificationType {
  new_follower
  new_climb # Someone you follow created a new climb
  new_climb_global # A new climb on a board+layout you subscribe to
  comment_reply
  comment_on_tick
  comment_on_climb # Someone commented on a climb you created
  vote_on_tick
  vote_on_comment
  proposal_approved
  proposal_rejected
  proposal_vote
}

type Notification {
  uuid: ID!
  type: NotificationType!
  actorId: ID
  actorDisplayName: String
  actorAvatarUrl: String
  entityType: SocialEntityType
  entityId: String
  commentBody: String # Preview text for comment notifications
  climbName: String # For new_climb / new_climb_global notifications
  climbUuid: String # For new_climb / new_climb_global notifications
  boardType: String # For new_climb / new_climb_global notifications
  isRead: Boolean!
  createdAt: String!
}

type NotificationConnection {
  notifications: [Notification!]!
  totalCount: Int!
  unreadCount: Int!
  hasMore: Boolean!
}

# --- New Climb Feed ---

type NewClimbFeedItem {
  climbUuid: String!
  boardType: String!
  layoutId: Int!
  climbName: String!
  setterDisplayName: String
  setterAvatarUrl: String
  grade: String # Display grade
  angle: Int
  createdAt: String!
}

type NewClimbFeedConnection {
  items: [NewClimbFeedItem!]!
  totalCount: Int!
  hasMore: Boolean!
}

type NewClimbSubscription {
  boardType: String!
  layoutId: Int!
  boardLayoutName: String # Human-readable name for display
}

# --- Activity Feed ---

type ActivityFeedItem {
  id: ID!
  type: ActivityFeedItemType!
  timestamp: String!
  # Union-like fields (only relevant ones populated per type)
  tick: AscentFeedItem
  comment: Comment
  user: PublicUserProfile
  # Context
  entityType: SocialEntityType
  entityId: String
  voteScore: Int
  userVote: Int
}

enum ActivityFeedItemType {
  ascent # Someone you follow logged an ascent
  new_climb # Someone you follow created a new climb
  comment # A recent comment on a trending entity
  playlist_vote # A climb in a playlist received significant votes
}

type ActivityFeedResult {
  items: [ActivityFeedItem!]!
  cursor: String # Opaque cursor for next page
  hasMore: Boolean!
}

# --- Community Proposals ---

enum ProposalType {
  grade
  classic
  benchmark
}

enum ProposalStatus {
  open
  approved
  rejected
  superseded
}

enum CommunityRole {
  admin
  community_leader
}

type Proposal {
  uuid: ID!
  climbUuid: String!
  boardType: String!
  angle: Int # Nullable. NULL for classic proposals (angle-independent). Required for grade/benchmark.
  proposerId: ID!
  proposerDisplayName: String
  proposerAvatarUrl: String
  type: ProposalType!
  proposedValue: String!
  currentValue: String
  status: ProposalStatus!
  reason: String
  createdAt: String!
  resolvedAt: String
  resolvedByDisplayName: String
  # Computed
  weightedUpvotes: Int! # SUM(weight) for value=+1
  weightedDownvotes: Int! # SUM(weight) for value=-1
  requiredUpvotes: Int! # The threshold for this climb+angle
  userVote: Int # +1, -1, or null
  commentCount: Int! # Comments on this proposal (entity_type=proposal)
  # For grade proposals: human-readable grade names
  proposedGradeName: String
  currentGradeName: String
}

type ProposalConnection {
  proposals: [Proposal!]!
  totalCount: Int!
  hasMore: Boolean!
}

type OutlierAnalysis {
  isOutlier: Boolean! # Whether the current grade qualifies as an outlier
  neighborAngles: [Int!]! # Adjacent angles used for comparison (e.g., [30, 40])
  neighborAscents: [Int!]! # Ascensionist count at each neighbor angle
  neighborGrade: Int! # Weighted average difficulty of neighbors (rounded)
  neighborGradeName: String! # Human-readable grade name for the neighbor consensus
  currentGrade: Int! # Current difficulty at the analyzed angle
  currentGradeName: String! # Human-readable grade name
  diffFromNeighbors: Float! # How far off the current grade is (in difficulty units)
}

type ProposalVoteSummary {
  proposalUuid: ID!
  weightedUpvotes: Int!
  weightedDownvotes: Int!
  requiredUpvotes: Int!
  userVote: Int
  status: ProposalStatus!
}

type ClimbCommunityStatus {
  climbUuid: String!
  boardType: String!
  angle: Int!
  communityGrade: Int # Difficulty grade ID, null if no override
  communityGradeName: String # Human-readable grade name
  isBenchmark: Boolean! # Tied to community grade consensus at this angle
  isClassic: Boolean! # Angle-independent (from climb_classic_status), included here for convenience
  isFrozen: Boolean!
  freezeReason: String
  openProposalCount: Int! # Grade + benchmark proposals at this angle, plus any classic proposals
  isCurrentUserSetter: Boolean! # Whether the authenticated user is the climb creator (enables setter controls)
  gradeOutlierAnalysis: OutlierAnalysis # Non-null if the grade at this angle appears to be an outlier vs adjacent angles
}

type ClimbClassicStatus {
  climbUuid: String!
  boardType: String!
  isClassic: Boolean! # Angle-independent classic designation
  lastProposalUuid: ID # Most recent approved classic proposal
}

type CommunityRoleAssignment {
  userId: ID!
  userDisplayName: String
  role: CommunityRole!
  boardType: String # null = global
  grantedByDisplayName: String
  createdAt: String!
}

type CommunitySetting {
  scope: String!
  scopeKey: String
  key: String!
  value: String!
}

# --- Unified Search ---

enum SearchCategory {
  climbs # Default on climb list page
  users # Default on home page
  playlists # Playlist discovery
  boards # Board discovery (by name, location, proximity)
}

type UserSearchResult {
  user: PublicUserProfile!
  recentAscentCount: Int! # Ascents in last 30 days
  matchReason: String # "name match", "email match", etc.
}

type PlaylistSearchResult {
  uuid: ID!
  name: String!
  description: String
  boardType: String!
  ownerDisplayName: String
  ownerAvatarUrl: String
  climbCount: Int!
  followerCount: Int! # Users who favorited/followed this playlist
  isPublic: Boolean!
  thumbnailClimbUuid: String # First climb UUID for thumbnail
}

type UserSearchConnection {
  results: [UserSearchResult!]!
  totalCount: Int!
  hasMore: Boolean!
}

type PlaylistSearchConnection {
  results: [PlaylistSearchResult!]!
  totalCount: Int!
  hasMore: Boolean!
}

# --- Board Entity ---

type UserBoard {
  uuid: ID!
  ownerId: ID!
  ownerDisplayName: String
  ownerAvatarUrl: String
  boardType: String!
  layoutId: Int!
  sizeId: Int!
  setIds: String! # Comma-separated hold set IDs
  name: String!
  description: String
  locationName: String # Gym name or location label
  latitude: Float
  longitude: Float
  isPublic: Boolean!
  isOwned: Boolean! # Whether the owner physically owns this board
  createdAt: String!
  # Computed fields
  layoutName: String # Human-readable layout name (from board_layouts)
  sizeName: String # Human-readable size name (from board_product_sizes)
  sizeDescription: String # Size description (e.g., "LED Kit")
  setNames: [String!] # Human-readable set names (from board_sets)
  totalAscents: Int! # Total ticks logged on this board
  uniqueClimbers: Int! # Distinct users who have logged ticks
  followerCount: Int! # Users who follow/subscribe to this board's feed
  # Social
  commentCount: Int! # Comments on this board (entity_type=board)
  isFollowedByMe: Boolean! # Whether the authenticated user follows this board
}

type UserBoardConnection {
  boards: [UserBoard!]!
  totalCount: Int!
  hasMore: Boolean!
}

type BoardLeaderboardEntry {
  userId: ID!
  userDisplayName: String
  userAvatarUrl: String
  rank: Int!
  totalSends: Int! # Completed climbs (flash + send)
  totalFlashes: Int! # First-try sends
  hardestGrade: Int # Difficulty ID of hardest send
  hardestGradeName: String # Human-readable
  totalSessions: Int! # Distinct session days
}

type BoardLeaderboard {
  boardUuid: ID!
  entries: [BoardLeaderboardEntry!]!
  totalCount: Int!
  hasMore: Boolean!
  periodLabel: String # e.g., "All Time", "This Month"
}
```

### 2.2 New Inputs

```graphql
input AddCommentInput {
  entityType: SocialEntityType!
  entityId: String!
  parentCommentId: ID
  body: String!
}

input UpdateCommentInput {
  commentUuid: ID!
  body: String!
}

input VoteInput {
  entityType: SocialEntityType!
  entityId: String!
  value: Int! # +1 or -1; sending the same value again removes the vote
}

input CommentsInput {
  entityType: SocialEntityType!
  entityId: String!
  limit: Int
  offset: Int
  sortBy: SortMode # new (default), top, controversial, hot
  topPeriod: TimePeriod # Only used when sortBy=top. Defaults to 'all'
}

input ActivityFeedInput {
  cursor: String
  limit: Int # default 20, max 50
  boardUuid: String # optional filter: only show activity on a specific board entity
}

input FollowInput {
  userId: ID!
}

input FollowListInput {
  userId: ID!
  limit: Int
  offset: Int
}

input BulkVoteSummaryInput {
  entityType: SocialEntityType!
  entityIds: [String!]!
}

input NotificationsInput {
  limit: Int
  offset: Int
  unreadOnly: Boolean
}

# --- Proposal Inputs ---

input CreateProposalInput {
  climbUuid: String!
  boardType: String!
  angle: Int # Required for grade/benchmark proposals. NULL for classic proposals.
  type: ProposalType!
  proposedValue: String! # Grade ID for grade, "true"/"false" for classic/benchmark
  reason: String # Optional explanation
}

input VoteOnProposalInput {
  proposalUuid: ID!
  value: Int! # +1 or -1
}

input ResolveProposalInput {
  proposalUuid: ID!
  action: String! # "approve" or "reject"
  reason: String # Optional reason for rejection
}

input GetClimbProposalsInput {
  climbUuid: String!
  boardType: String!
  angle: Int # Filter by angle. NULL returns classic proposals + all angle-specific proposals.
  status: ProposalStatus # Filter by status, null = all
  type: ProposalType # Filter by type, null = all
  limit: Int
  offset: Int
}

input BrowseProposalsInput {
  boardType: String # Optional filter
  status: ProposalStatus # Default: open
  type: ProposalType # Optional filter
  sortBy: SortMode # new, top (by weighted upvotes), hot
  limit: Int
  offset: Int
}

input SetCommunitySettingInput {
  scope: String! # 'global', 'board', or 'climb'
  scopeKey: String # null for global, boardType for board, "climbUuid:angle" for climb
  key: String!
  value: String!
}

input SetterOverrideInput {
  climbUuid: String!
  boardType: String!
  angle: Int! # Required. The angle at which to override the grade.
  communityGrade: Int! # The new grade. Setter override only applies to grade (not benchmark or classic).
}

input FreezeClimbInput {
  climbUuid: String!
  boardType: String!
  angle: Int!
  frozen: Boolean!
  reason: String # Optional reason
}

input GrantRoleInput {
  userId: ID!
  role: CommunityRole!
  boardType: String # null = global
}

input RevokeRoleInput {
  userId: ID!
  role: CommunityRole!
  boardType: String # null = global
}

# --- Unified Search Inputs ---

input SearchUsersInput {
  query: String! # Search by display name or email prefix
  boardType: String # Optional: filter to users active on this board
  limit: Int # Default 20, max 50
  offset: Int
}

input SearchPlaylistsInput {
  query: String! # Search by playlist name or description
  boardType: String # Optional: filter by board type
  publicOnly: Boolean # Default true
  limit: Int # Default 20, max 50
  offset: Int
}

# --- New Climb Feed Inputs ---

input NewClimbFeedInput {
  boardType: String! # Required: which board
  layoutId: Int! # Required: which layout
  limit: Int # Default 20, max 50
  offset: Int
}

input SubscribeNewClimbsInput {
  boardType: String!
  layoutId: Int!
}

# --- Board Entity Inputs ---

input CreateBoardInput {
  boardType: String!
  layoutId: Int!
  sizeId: Int!
  setIds: String! # Comma-separated hold set IDs
  name: String!
  description: String
  locationName: String
  latitude: Float
  longitude: Float
  isPublic: Boolean # Default true
  isOwned: Boolean # Default true
}

input UpdateBoardInput {
  boardUuid: ID!
  name: String
  description: String
  locationName: String
  latitude: Float
  longitude: Float
  isPublic: Boolean
  isOwned: Boolean
}

input SearchBoardsInput {
  query: String # Search by name or location
  boardType: String # Optional: filter by board type
  nearLatitude: Float # Optional: proximity search
  nearLongitude: Float
  radiusKm: Float # Optional: search radius (default 50km)
  limit: Int # Default 20, max 50
  offset: Int
}

input BoardLeaderboardInput {
  boardUuid: ID!
  period: TimePeriod # week, month, year, all (default: all)
  limit: Int # Default 20, max 100
  offset: Int
}

input MyBoardsInput {
  limit: Int
  offset: Int
}

input FollowBoardInput {
  boardUuid: ID!
}
```

### 2.3 New Queries

```graphql
extend type Query {
  # Comments
  comments(input: CommentsInput!): CommentConnection!
  commentReplies(commentUuid: ID!, limit: Int, offset: Int): CommentConnection!

  # Votes
  voteSummary(entityType: SocialEntityType!, entityId: String!): VoteSummary!
  bulkVoteSummaries(input: BulkVoteSummaryInput!): [VoteSummary!]!

  # Follows
  followers(input: FollowListInput!): FollowConnection!
  following(input: FollowListInput!): FollowConnection!
  isFollowing(userId: ID!): Boolean!

  # User profile (public, extended)
  publicProfile(userId: ID!): PublicUserProfile

  # Notifications (requires auth)
  notifications(input: NotificationsInput): NotificationConnection!

  # Activity feed (requires auth)
  activityFeed(input: ActivityFeedInput): ActivityFeedResult!

  # Proposals
  climbProposals(input: GetClimbProposalsInput!): ProposalConnection!
  browseProposals(input: BrowseProposalsInput!): ProposalConnection!
  climbCommunityStatus(climbUuid: String!, boardType: String!, angle: Int!): ClimbCommunityStatus!
  bulkClimbCommunityStatus(climbUuids: [String!]!, boardType: String!, angle: Int!): [ClimbCommunityStatus!]!

  # Admin / Community Settings
  communitySettings(scope: String!, scopeKey: String): [CommunitySetting!]!
  communityRoles(boardType: String): [CommunityRoleAssignment!]!
  myRoles: [CommunityRoleAssignment!]!

  # Classic status (angle-independent)
  climbClassicStatus(climbUuid: String!, boardType: String!): ClimbClassicStatus

  # Unified Search
  searchUsers(input: SearchUsersInput!): UserSearchConnection!
  searchPlaylists(input: SearchPlaylistsInput!): PlaylistSearchConnection!

  # New Climb Feed
  newClimbFeed(input: NewClimbFeedInput!): NewClimbFeedConnection!
  myNewClimbSubscriptions: [NewClimbSubscription!]! # List of board+layout pairs the user subscribes to
  # Board Entity
  board(boardUuid: ID!): UserBoard # Get a single board by UUID
  myBoards(input: MyBoardsInput): UserBoardConnection! # User's boards (owned first, then most-used)
  searchBoards(input: SearchBoardsInput!): UserBoardConnection! # Discover public boards
  boardLeaderboard(input: BoardLeaderboardInput!): BoardLeaderboard!
  defaultBoard: UserBoard # Resolve user's "default" board (owned > most ascents)
}
```

### 2.4 New Mutations

```graphql
extend type Mutation {
  # Comments
  addComment(input: AddCommentInput!): Comment!
  updateComment(input: UpdateCommentInput!): Comment!
  deleteComment(commentUuid: ID!): Boolean!

  # Votes
  vote(input: VoteInput!): VoteSummary!

  # Follows
  followUser(input: FollowInput!): Boolean!
  unfollowUser(input: FollowInput!): Boolean!

  # Notifications
  markNotificationRead(notificationUuid: ID!): Boolean!
  markAllNotificationsRead: Boolean!

  # Proposals
  createProposal(input: CreateProposalInput!): Proposal!
  voteOnProposal(input: VoteOnProposalInput!): ProposalVoteSummary!
  resolveProposal(input: ResolveProposalInput!): Proposal! # Admin/leader only
  # Setter override (climb creator can bypass proposals -- grade only)
  setterOverrideCommunityStatus(input: SetterOverrideInput!): ClimbCommunityStatus!

  # Admin / Community Settings
  setCommunitySettings(input: SetCommunitySettingInput!): CommunitySetting! # Admin/leader only
  freezeClimb(input: FreezeClimbInput!): ClimbCommunityStatus! # Admin/leader only
  grantRole(input: GrantRoleInput!): CommunityRoleAssignment! # Admin only
  revokeRole(input: RevokeRoleInput!): Boolean! # Admin only
  # New Climb Feed subscriptions
  subscribeNewClimbs(input: SubscribeNewClimbsInput!): NewClimbSubscription! # Subscribe to a board+layout
  unsubscribeNewClimbs(input: SubscribeNewClimbsInput!): Boolean! # Unsubscribe from a board+layout
  # Board Entity
  createBoard(input: CreateBoardInput!): UserBoard!
  updateBoard(input: UpdateBoardInput!): UserBoard!
  deleteBoard(boardUuid: ID!): Boolean! # Only owner can delete
  followBoard(input: FollowBoardInput!): Boolean! # Follow a public board's activity
  unfollowBoard(input: FollowBoardInput!): Boolean!
}
```

### 2.5 New Subscriptions

```graphql
extend type Subscription {
  # Real-time notifications for the authenticated user
  notificationReceived: NotificationEvent!

  # Live comment updates for an entity being viewed
  commentUpdates(entityType: SocialEntityType!, entityId: String!): CommentEvent!

  # Live new climb feed for a board+layout (public, no auth required)
  newClimbCreated(boardType: String!, layoutId: Int!): NewClimbFeedItem!
}

union NotificationEvent = NotificationCreated

type NotificationCreated {
  notification: Notification!
}

union CommentEvent = CommentAdded | CommentUpdated | CommentDeleted

type CommentAdded {
  comment: Comment!
}

type CommentUpdated {
  comment: Comment!
}

type CommentDeleted {
  commentUuid: ID!
}
```

---

## Phase 3: Backend Resolvers

### 3.1 Comments Resolvers

New file: `packages/backend/src/graphql/resolvers/social/comments.ts`

**`comments` query:**

- Fetch comments for `(entity_type, entity_id)` with pagination
- JOIN `users` + `user_profiles` for `displayName`, `avatarUrl`
- Subquery for `reply_count` (COUNT of children)
- Subquery for `upvotes` and `downvotes` counts (from votes where `entity_type = 'comment'`)
- If authenticated, LEFT JOIN to get `user_vote`
- Apply ranking algorithm based on `sortBy` parameter:
  - `new`: ORDER BY `created_at DESC`
  - `top`: ORDER BY `(upvotes - downvotes) DESC`, with optional `topPeriod` time window filter on `created_at`
  - `controversial`: ORDER BY controversy formula (see Ranking Algorithms section)
  - `hot`: ORDER BY hot score formula (see Ranking Algorithms section)
- Filter out soft-deleted comments unless they have replies (show as "[deleted]")

**`addComment` mutation:**

- Auth required
- Validate `entity_type`/`entity_id` refers to a real entity:
  - `playlist_climb`: playlist exists, is public, climb exists in it
  - `climb`: climb exists in any board
  - `tick`: tick exists
- Validate `body` length (1-2000 chars)
- If `parentCommentId` provided, validate parent exists and shares the same `entity_type`/`entity_id`
- Rate limit: max 10 comments per minute per user
- Insert into `comments` table
- **Publish `CommentAdded` event** via pubsub to `comments:{entity_type}:{entity_id}` channel
- **Create notification** for entity owner (if commenting on someone else's tick) or parent comment author (if replying)
- **Publish `NotificationCreated` event** to recipient's notification channel
- Return created comment

**`updateComment` mutation:**

- Auth required, must be comment author
- **No time limit on edits** -- comments are editable in perpetuity
- Update `body` and `updated_at`
- Validate `body` length (1-2000 chars)
- **Publish `CommentUpdated` event** via pubsub
- Return updated comment

**`deleteComment` mutation:**

- Auth required, must be comment author
- If comment has replies: set `deleted_at` (soft delete), body displayed as "[deleted]"
- If comment has no replies: hard delete
- **Publish `CommentDeleted` event** via pubsub

### 3.2 Votes Resolvers

New file: `packages/backend/src/graphql/resolvers/social/votes.ts`

**`vote` mutation:**

- Auth required
- Validate `value` is +1 or -1
- Rate limit: max 30 votes per minute per user
- UPSERT logic:
  - If vote with same `(user_id, entity_type, entity_id)` exists:
    - If same value: DELETE the vote (toggle off)
    - If different value: UPDATE to new value
  - If no existing vote: INSERT
- **Create notification** for entity owner (for ticks and comments, not playlist_climb)
  - Deduplicate: don't create a new notification if one already exists for `(actor, type, entity)` within the last hour -- update the existing one's timestamp instead
- Return updated `VoteSummary`

**`voteSummary` query:**

- COUNT upvotes (`value = 1`) and downvotes (`value = -1`) for entity
- If authenticated, fetch user's vote

**`bulkVoteSummaries` query:**

- Batch version for list views (all climbs in a playlist)
- Single query with `WHERE entity_id IN (...)` and GROUP BY
- If authenticated, LEFT JOIN user's votes

### 3.3 Follows Resolvers

New file: `packages/backend/src/graphql/resolvers/social/follows.ts`

**`followUser` mutation:**

- Auth required
- Can't follow yourself (enforced at app + DB level)
- Rate limit: max 20 follows per minute per user
- INSERT into `user_follows`, ON CONFLICT DO NOTHING (idempotent)
- **Create `new_follower` notification** for the followed user
- **Publish `NotificationCreated` event** to followed user's channel

**`unfollowUser` mutation:**

- Auth required
- DELETE from `user_follows`
- No notification (unfollows are silent)

**`followers` / `following` queries:**

- Paginated list with user profile info
- Include `isFollowedByMe` if authenticated (for follow-back indication)

**`publicProfile` query:**

- Fetch user profile + follower/following counts
- `isFollowedByMe` if authenticated

### 3.4 Notifications Resolvers

New file: `packages/backend/src/graphql/resolvers/social/notifications.ts`

**`notifications` query:**

- Auth required
- Paginated, ordered by `created_at DESC`
- Optional `unreadOnly` filter
- JOIN actor profile for `displayName`, `avatarUrl`
- JOIN comment for body preview (when applicable)
- Return with `unreadCount` for badge display

**`markNotificationRead` mutation:**

- Auth required, must be recipient
- Set `read_at = now()`

**`markAllNotificationsRead` mutation:**

- Auth required
- UPDATE all unread notifications for user

### 3.5 Activity Feed Resolver

New file: `packages/backend/src/graphql/resolvers/social/feed.ts`

**`activityFeed` query:**

- Auth required (for personalized feed)
- Reads from the `feed_items` table (fan-out-on-write, see section 1.17). No multi-source aggregation at query time.
- **Primary query**: `SELECT * FROM feed_items WHERE recipient_id = $me ORDER BY created_at DESC LIMIT $limit`
- **Board scoping**: When `boardUuid` is provided, filter to `WHERE recipient_id = $me AND board_uuid = $boardUuid ORDER BY created_at DESC`. On the home page, this defaults to the user's `defaultBoard`.
- The `metadata` JSONB column contains denormalized rendering data (climb name, grade, user avatar URL, etc.) so the feed renders without JOINing back to source tables.
- **Sort**: Always chronological (`ORDER BY session_last_tick DESC`).
- **Cursor**: Offset-based cursor encoded as base64.
- **Default limit**: 20 items per page, max 50

**For unauthenticated users:**

- Show globally trending content via a small fan-out-on-read query (top-voted public playlist climbs, most-commented climbs). This is a bounded query that doesn't involve per-user follow graphs.
- Prompt to sign in for personalized feed

### 3.6 Proposals Resolvers

New file: `packages/backend/src/graphql/resolvers/social/proposals.ts`

**`createProposal` mutation:**

- Auth required
- Validate climb exists for `(climbUuid, boardType)`
- For `grade`/`benchmark` proposals: validate `angle` is provided and valid for the climb's board
- For `classic` proposals: `angle` must be NULL (classic is angle-independent)
- Check climb is not frozen (query `community_settings` for `climb_frozen`; for grade/benchmark check at the specific angle, for classic check at any scope)
- For `grade` proposals: validate `proposedValue` is a valid difficulty ID in `board_difficulty_grades`
- For `classic`/`benchmark` proposals: validate `proposedValue` is `"true"` or `"false"`
- Capture `currentValue`:
  - Grade: from `climb_community_status` (if exists) or `board_climb_stats.display_difficulty`
  - Benchmark: from `climb_community_status.is_benchmark`
  - Classic: from `climb_classic_status.is_classic` (or false if no row)
- If an open proposal of the same `(climb_uuid, angle, type)` already exists: set its status to `superseded`. For classic proposals, match on `(climb_uuid, type)` where `angle IS NULL`.
  - **Superseded proposal votes**: Votes on the superseded proposal remain in `proposal_votes` for historical record but have no further effect. Votes do NOT carry over to the new proposal -- users must re-vote. This is intentional: the new proposal may have a different `proposedValue` or `reason`. The superseded proposal's vote summary remains visible in proposal history for context.
- Insert into `climb_proposals`
- Auto-insert a +1 proposal vote from the proposer (with their role weight)
- **Adjacent-angle outlier check** (grade proposals only): Before checking the normal vote threshold, run the outlier detection algorithm (see below). If the proposed grade aligns with adjacent-angle data and the current grade is a statistical outlier, **auto-approve immediately** regardless of vote count.
- **Check threshold immediately** (an admin creating a proposal might auto-approve if their weight alone meets the threshold)
- Return created proposal

#### Adjacent-Angle Outlier Detection (Auto-Approval for Grade Proposals)

When a grade proposal is created, the system checks whether the current grade at that angle is a statistical outlier compared to adjacent angles. If it is, and the proposed grade moves the grade _toward_ the consensus of neighboring angles, the proposal is **auto-approved immediately** -- no voting required.

This addresses a common real-world problem: a climb graded V2 at 35° while 30° has it at V4 and 40° at V5. The V2 is clearly wrong, and the adjacent angle data from many ascensionists is strong evidence.

**Algorithm:**

```
function checkAdjacentAngleOutlier(climbUuid, boardType, angle, proposedDifficulty):
  # 1. Fetch stats for the target angle and its neighbors
  targetStats = board_climb_stats WHERE climb_uuid AND angle
  lowerStats  = board_climb_stats WHERE climb_uuid AND angle = (angle - 5)
  upperStats  = board_climb_stats WHERE climb_uuid AND angle = (angle + 5)

  # 2. Resolve configurable thresholds
  minAscents = resolve_setting('outlier_min_ascents', climb+angle scope)  # default 10
  minGradeDiff = resolve_setting('outlier_grade_diff', climb+angle scope)  # default 2

  # 3. Need at least ONE adjacent angle with sufficient ascent data
  #    (climbs at the edge of the angle range may only have one neighbor)
  eligibleNeighbors = []
  if lowerStats AND lowerStats.ascensionist_count >= minAscents:
    eligibleNeighbors.push(lowerStats)
  if upperStats AND upperStats.ascensionist_count >= minAscents:
    eligibleNeighbors.push(upperStats)

  if eligibleNeighbors.length == 0:
    return { isOutlier: false }  # Not enough data to determine

  # 4. Compute the neighbor consensus grade
  #    Weighted average by ascensionist count
  neighborGrade = SUM(neighbor.display_difficulty * neighbor.ascensionist_count)
                / SUM(neighbor.ascensionist_count)

  # 5. Check if the current grade is an outlier
  currentDifficulty = targetStats.display_difficulty
  diffFromNeighbors = ABS(currentDifficulty - neighborGrade)

  if diffFromNeighbors < minGradeDiff:
    return { isOutlier: false }  # Grade is within acceptable range of neighbors

  # 6. Check the proposed grade moves TOWARD the neighbor consensus
  #    (we don't auto-approve proposals that move AWAY from consensus)
  proposedDiffFromNeighbors = ABS(proposedDifficulty - neighborGrade)
  if proposedDiffFromNeighbors >= diffFromNeighbors:
    return { isOutlier: false }  # Proposed grade doesn't improve alignment

  # 7. All checks pass: this is a legitimate outlier correction
  return {
    isOutlier: true,
    currentDifficulty,
    neighborGrade: ROUND(neighborGrade),
    neighborAngles: eligibleNeighbors.map(n => n.angle),
    neighborAscents: eligibleNeighbors.map(n => n.ascensionist_count),
    diffFromNeighbors
  }
```

**When outlier is detected:**

1. The proposal is **auto-approved immediately** (status = `approved`, `resolved_at = now()`)
2. `resolved_by` is set to `NULL` (system-approved, not a user)
3. The effect is applied to `climb_community_status` at that angle
4. The proposal's `reason` field is augmented with a system note:
   `"[Auto-approved: grade outlier detected. Adjacent angles grade {neighborGrade} with {totalAscents} ascents vs current {currentGrade} at this angle.]"`
5. Any open grade proposal at this climb+angle is superseded
6. Notifications are still sent (proposer gets `proposal_approved`)

**What the UI shows:**

- The proposal card shows an "Auto-approved" badge with the explanation
- The climb detail view shows a system note: "Grade adjusted from V2 to V4 based on adjacent angle consensus (V4 at 30° with 47 ascents, V5 at 40° with 32 ascents)"
- In the proposal history, auto-approved proposals are visually distinct (system icon instead of user avatar)

**Edge cases:**

- **Edge angles** (0° or 70°): Only one adjacent angle exists. Still works -- a single well-attested neighbor is enough evidence if the diff is large enough.
- **Target angle has many ascents too**: The algorithm still applies. Even if the target has 50 ascents, if neighbors with 200+ ascents disagree by 3+ grades, the correction should still be fast-tracked. The ascent count threshold only applies to _neighbors_.
- **Community status override exists**: If `climb_community_status` already has a `community_grade` at this angle, use that instead of `board_climb_stats.display_difficulty` as the "current" grade.
- **Climb is frozen**: Outlier auto-approval is blocked on frozen climbs (same as normal proposals). Admins must unfreeze first.

**Configurable behavior (via `community_settings`):**

- `outlier_min_ascents` (default 10): Minimum ascensionist count at each adjacent angle. Higher values = more conservative. Can be adjusted per board or globally.
- `outlier_grade_diff` (default 2): Minimum difficulty unit difference to trigger outlier detection. A value of 2 means roughly 1 V-grade difference (V-grades span ~2 difficulty units). Set to 3 for stricter detection.

**GraphQL additions:**

```graphql
# Added to Proposal type:
type Proposal {
  # ... existing fields ...
  isAutoApproved: Boolean! # True if auto-approved by outlier detection
  outlierAnalysis: OutlierAnalysis # Non-null when outlier detection was triggered
}

type OutlierAnalysis {
  isOutlier: Boolean!
  neighborAngles: [Int!]! # Adjacent angles used for comparison
  neighborAscents: [Int!]! # Ascensionist count at each neighbor angle
  neighborGrade: Int! # Weighted average difficulty of neighbors
  neighborGradeName: String! # Human-readable grade
  currentGrade: Int! # Current difficulty at the proposed angle
  currentGradeName: String! # Human-readable grade
  diffFromNeighbors: Float! # How far off the current grade is
}
```

**`OutlierAnalysis` is returned on every grade proposal** (even non-outliers), so the UI can always show the user how the proposed angle compares to its neighbors. This provides context for voters even when the auto-approval threshold isn't met.

**`voteOnProposal` mutation:**

- Auth required
- Validate proposal exists and is `open`
- Validate `value` is +1 or -1
- Compute voter's weight from `community_roles`:
  - Check for `admin` role (global or matching board_type) → `admin_vote_weight`
  - Check for `community_leader` role (matching board_type) → `leader_vote_weight`
  - Otherwise → weight 1
- UPSERT: same toggle semantics as general votes (same value = remove, different = flip)
- **Threshold check**: After vote, compute `SUM(weight) WHERE value = +1`. If >= `proposal_approval_threshold` for this climb (+ angle for grade/benchmark):
  1. Set proposal status to `approved`, `resolved_at = now()`
  2. Apply the effect:
     - Grade/benchmark: UPSERT `climb_community_status` at the proposal's angle
     - Classic: UPSERT `climb_classic_status` (angle-independent)
  3. Create `proposal_approved` notification for the proposer
- Create `proposal_vote` notification for the proposer (deduplicated)
- Return updated `ProposalVoteSummary`

**`resolveProposal` mutation:**

- Auth required, must have `admin` or `community_leader` role for the proposal's board
- Accept `action`: `"approve"` or `"reject"`
- If `approve`: same effect-application as auto-approval, but `resolved_by` is set to the admin/leader
- If `reject`: set status to `rejected`, `resolved_at = now()`, `resolved_by` = admin/leader
- Create `proposal_approved` or `proposal_rejected` notification for the proposer
- Return updated proposal

**`setterOverrideCommunityStatus` mutation:**

- Auth required
- Verify the authenticated user is the climb's creator. Setter identity is determined by:
  1. `board_climbs.userId` -- Boardsesh user who created the climb locally (set for locally-created climbs)
  2. Fallback: `board_climbs.setterId` matched via `user_board_mappings` to the authenticated user's account (for Aurora-synced climbs where the user has linked their Aurora account)
- If neither match, reject with "Only the climb setter can use this action"
- **Setter override applies to grade only** -- benchmark and classic status are community-driven and cannot be overridden by the setter
- Reject if `isBenchmark` or `isClassic` fields are provided (return error: "Setter override only applies to grade")
- Validate `communityGrade` is a valid difficulty ID if provided
- Require `angle` when setting `communityGrade`
- UPSERT into `climb_community_status` with the grade field at the specified angle
- If there are any `open` grade proposals for this climb+angle, set them to `superseded` (the setter's word takes precedence on grade)
- Record in `climb_community_status.last_proposal_id = NULL` to indicate this was a setter override, not a proposal result
- Return updated `ClimbCommunityStatus`

**Notes on setter privilege:**

- The setter can adjust **grade only** at any angle without going through the proposal system
- **Benchmark and classic status are community-driven**: even the setter must go through the proposal system for these
- This works even if the climb is frozen (setters are not blocked by freeze for grade adjustments)
- The setter override is logged in `climb_community_status.updated_at` for audit purposes
- Other users can still create grade proposals to contest the setter's choice -- proposals work normally alongside setter overrides
- Admins and community leaders also have override ability via `resolveProposal` (for all proposal types)

**`climbProposals` query:**

- Fetch proposals for a specific `(climbUuid, boardType, angle)`
- Optional filters: `status`, `type`
- JOIN proposer profile
- Compute weighted vote totals and threshold from settings
- If authenticated, include user's vote

**`browseProposals` query:**

- Global browse of proposals across all climbs
- Filter by `boardType`, `status`, `type`
- Sort by `new`, `top` (most weighted upvotes), or `hot`
- Paginated

**`climbCommunityStatus` query:**

- Fetch community status for a climb at an angle
- Returns community grade, classic status, benchmark status, frozen state
- Also returns `openProposalCount` for badge display

**`bulkClimbCommunityStatus` query:**

- Batch version for list views
- Single query for multiple climb UUIDs at one angle

### 3.7 Admin / Community Settings Resolvers

New file: `packages/backend/src/graphql/resolvers/social/admin.ts`

**`setCommunitySettings` mutation:**

- Auth required, must be `admin` (for global/board scope) or `community_leader` (for climb scope within their board)
- UPSERT the setting
- For `proposal_approval_threshold`: validate value is a positive integer
- For `admin_vote_weight` / `leader_vote_weight`: validate value is >= 1

**`freezeClimb` mutation:**

- Auth required, must be `admin` or `community_leader` for the climb's board
- UPSERT `climb_frozen` = `"true"` and `freeze_reason` into `community_settings` at climb scope
- When freezing: all `open` proposals for this climb+angle are set to `rejected` with `resolved_by` = the admin/leader
- When unfreezing: just removes the setting (no effect on existing proposals)
- Return updated `ClimbCommunityStatus`

**`grantRole` mutation:**

- Auth required, must be `admin`
- INSERT into `community_roles`
- Return the assignment

**`revokeRole` mutation:**

- Auth required, must be `admin`
- DELETE from `community_roles`

**`communitySettings` query:**

- Fetch all settings for a scope+scopeKey
- No auth required for reading (settings are public)

**`communityRoles` query:**

- List role assignments, optionally filtered by board
- No auth required (roles are public -- users should know who the moderators are)

**`myRoles` query:**

- Auth required
- Fetch the authenticated user's role assignments

### 3.8 New Climb Feed Resolvers

New file: `packages/backend/src/graphql/resolvers/social/new-climbs.ts`

**`newClimbFeed` query:**

- No auth required (public feed)
- Fetch recently created climbs for a specific `(boardType, layoutId)`
- Query `board_climbs` WHERE `board_type = boardType` AND `layout_id = layoutId`, ordered by creation time DESC
- JOIN user profiles for setter info
- JOIN `board_climb_stats` for grade info
- Paginated with limit/offset

**`myNewClimbSubscriptions` query:**

- Auth required
- Fetch all `new_climb_subscriptions` for the authenticated user
- JOIN layout info for human-readable display names

**`subscribeNewClimbs` mutation:**

- Auth required
- INSERT into `new_climb_subscriptions`, ON CONFLICT DO NOTHING (idempotent)
- Return the subscription

**`unsubscribeNewClimbs` mutation:**

- Auth required
- DELETE from `new_climb_subscriptions`

**New climb event publishing (triggered when a climb is created):**

- When a new climb is created (via Aurora sync or locally), publish a `climb.created` event to the Redis Streams broker
- The event includes: `climbUuid`, `boardType`, `layoutId`, `setterId`
- The notification worker resolves recipients:
  1. **Followers**: Users who follow the climb creator → `new_climb` notification
  2. **Board+layout subscribers**: Users subscribed to this `(boardType, layoutId)` → `new_climb_global` notification
- **Deduplication**: Don't notify the same user twice if they both follow the setter AND subscribe to the board+layout
- **Publish to WebSocket**: `newClimbCreated` subscription for live feed updates

### 3.9 Board Entity Resolvers

New file: `packages/backend/src/graphql/resolvers/social/boards.ts`

**`createBoard` mutation:**

- Auth required
- Validate `boardType` is valid
- Validate `layoutId`, `sizeId` exist for this board type (check `board_layouts`, `board_product_sizes`)
- Validate `setIds` are valid set IDs for this board type (check `board_sets`)
- Validate name length (1-100 chars)
- Check unique constraint: user can't already have a board with the same `(boardType, layoutId, sizeId, setIds)` config
- INSERT into `user_boards`
- Return created board

**`updateBoard` mutation:**

- Auth required, must be board owner
- Only metadata fields can be updated (name, description, locationName, lat/lng, isPublic, isOwned)
- Hardware config (boardType, layoutId, sizeId, setIds) is immutable after creation -- delete and recreate if the physical board changes
- Return updated board

**`deleteBoard` mutation:**

- Auth required, must be board owner
- **Soft delete**: Set `deleted_at = now()` on the `user_boards` row (do NOT hard delete)
- Tick and session `board_id` references remain intact (the FK is to `user_boards.id`, and the row still exists)
- Comments and votes on the board are preserved (viewable if someone has a direct link, but the board won't appear in search/feeds)
- The board is excluded from all queries (`myBoards`, `searchBoards`, `board`, `defaultBoard`) via `WHERE deleted_at IS NULL`
- Board owner can "restore" a soft-deleted board via `updateBoard` (which clears `deleted_at`)

**`followBoard` / `unfollowBoard` mutations:**

- Auth required
- Uses the `board_follows` table (section 1.14) -- a dedicated junction table for user-to-board follows, separate from `user_follows` (user-to-user)
- Following a board means you see its activity in your feed
- Public boards only (reject follow on private boards unless you're the owner)

**`board` query:**

- Fetch a single board by UUID
- JOIN `board_layouts`, `board_product_sizes`, `board_sets` for human-readable names
- Compute `totalAscents` and `uniqueClimbers` from `boardsesh_ticks` where `board_id = this board`
- If authenticated, include `isFollowedByMe`

**`myBoards` query:**

- Auth required
- Fetch all `user_boards` where `owner_id = currentUser`
- **Sort order**: `is_owned DESC` (owned boards first), then by most recent tick activity (board with most recent ascent logged on it comes first)
- Paginated

**`searchBoards` query:**

- Search `user_boards` WHERE `is_public = true`
- Text search: `name` ILIKE `%query%` OR `location_name` ILIKE `%query%`
- Optional `boardType` filter
- Optional proximity search using PostGIS: `WHERE ST_DWithin(location, ST_MakePoint($nearLongitude, $nearLatitude)::geography, $radiusKm * 1000)`. Distance ordering: `ORDER BY ST_Distance(location, ST_MakePoint($nearLongitude, $nearLatitude)::geography)`. Uses the GiST index on `location` for efficient spatial queries.
- ORDER BY relevance (proximity if searching by location), then by `totalAscents` DESC
- Paginated

**`boardLeaderboard` query:**

- Fetch leaderboard for a specific board
- Query `boardsesh_ticks` WHERE `board_id = boardId` AND `status IN ('flash', 'send')`
- Optional time period filter on `climbed_at`
- Aggregate per user: total sends, total flashes, hardest grade, distinct session days
- ORDER BY `totalSends DESC, hardestGrade DESC`
- Paginated

**`defaultBoard` query:**

- Auth required
- Resolution order:
  1. The user's board where `is_owned = true`, ordered by `created_at ASC` (first owned board)
  2. Fallback: the board (owned or not) with the most `boardsesh_ticks` for this user (most-used board)
  3. Fallback: NULL (user has no boards -- prompt to create one)
- Returns a single `UserBoard` or null

**Board resolution from URL path:**

- Helper function (not a GraphQL resolver, used internally):
  ```
  resolveBoardFromPath(userId, boardType, layoutId, sizeId, setIds) → UserBoard | null
  ```
- Matches `user_boards` where `owner_id = userId AND board_type AND layout_id AND size_id AND set_ids` match
- Used when logging ticks to auto-populate `board_id`
- Also used by party mode to link sessions to boards

---

## Phase 4: PubSub Extensions for Real-Time

Extend the existing pub/sub system in `packages/backend/src/pubsub/`.

### 4.1 New PubSub Channels

Add to `packages/backend/src/pubsub/index.ts`:

| Channel Pattern                               | Scope            | Events                                             |
| --------------------------------------------- | ---------------- | -------------------------------------------------- |
| `boardsesh:notifications:{userId}`            | Per-user         | `NotificationCreated`                              |
| `boardsesh:comments:{entityType}:{entityId}`  | Per-entity       | `CommentAdded`, `CommentUpdated`, `CommentDeleted` |
| `boardsesh:new-climbs:{boardType}:{layoutId}` | Per-board+layout | `NewClimbCreated`                                  |

New subscriber maps in PubSub class:

```typescript
private notificationSubscribers: Map<string, Set<NotificationSubscriber>> = new Map();
private commentSubscribers: Map<string, Set<CommentSubscriber>> = new Map();
```

New methods:

```typescript
subscribeNotifications(userId: string, callback: (event: NotificationEvent) => void): Promise<() => void>
publishNotificationEvent(userId: string, event: NotificationEvent): void

subscribeComments(entityType: string, entityId: string, callback: (event: CommentEvent) => void): Promise<() => void>
publishCommentEvent(entityType: string, entityId: string, event: CommentEvent): void

subscribeNewClimbs(boardType: string, layoutId: number, callback: (item: NewClimbFeedItem) => void): Promise<() => void>
publishNewClimbEvent(boardType: string, layoutId: number, item: NewClimbFeedItem): void
```

### 4.2 Redis Adapter Extensions

Add to `packages/backend/src/pubsub/redis-adapter.ts`:

- `subscribeNotificationChannel(userId)` / `unsubscribeNotificationChannel(userId)`
- `subscribeCommentChannel(entityType, entityId)` / `unsubscribeCommentChannel(...)`
- `subscribeNewClimbChannel(boardType, layoutId)` / `unsubscribeNewClimbChannel(...)`
- `publishNotificationEvent(userId, event)` / `publishCommentEvent(entityType, entityId, event)` / `publishNewClimbEvent(boardType, layoutId, item)`

Same pattern as queue/session channels:

- Include `instanceId` in messages for duplicate prevention
- Auto-subscribe Redis channel on first local subscriber, unsubscribe on last

### 4.3 Subscription Resolvers

**`notificationReceived` subscription:**

```
packages/backend/src/graphql/resolvers/social/subscriptions.ts
```

- Auth required (`requireAuthenticated(ctx)`)
- Subscribe to `notifications:{ctx.userId}` channel
- Use lazy async iterator (no initial state push; client fetches unread count via `notifications` query separately)
- Authorization: Only the authenticated user receives their own notifications

**`commentUpdates` subscription:**

```
packages/backend/src/graphql/resolvers/social/subscriptions.ts
```

- No auth required (public entities have public comments)
- Subscribe to `comments:{entityType}:{entityId}` channel
- Use lazy async iterator
- Client subscribes when mounting a comment section component, unsubscribes on unmount
- Entity validation: verify the entity exists and is commentable (playlist is public, etc.)

**`newClimbCreated` subscription:**

- No auth required (public feed)
- Subscribe to `new-climbs:{boardType}:{layoutId}` channel
- Use lazy async iterator
- Client subscribes when viewing the new climb feed page for a board+layout, unsubscribes on unmount
- Emits a `NewClimbFeedItem` whenever a new climb is created on the subscribed board+layout

### 4.4 Event Flow Examples

**New comment on a playlist climb:**

```
User A posts comment on playlist_climb "abc:xyz"
  → INSERT into comments table
  → pubsub.publishCommentEvent("playlist_climb", "abc:xyz", { __typename: "CommentAdded", comment })
    → Local subscribers notified immediately
    → Redis publishes to boardsesh:comments:playlist_climb:abc:xyz
    → Other instances receive and notify their local subscribers
  → INSERT notification for playlist owner (if different user)
  → pubsub.publishNotificationEvent(ownerUserId, { __typename: "NotificationCreated", notification })
    → Owner receives real-time notification
```

**Someone follows you:**

```
User A follows User B
  → INSERT into user_follows
  → INSERT notification (type: new_follower, recipient: B, actor: A)
  → pubsub.publishNotificationEvent(B.id, { __typename: "NotificationCreated", notification })
    → User B sees notification in real time (badge increments, toast appears)
```

**New climb created:**

```
User A creates a new climb on Kilter, layout 1
  → INSERT into board_climbs
  → pubsub.publishNewClimbEvent("kilter", 1, newClimbFeedItem)
    → Anyone viewing the new climb feed for kilter/layout 1 sees it live
  → eventBroker.publish({ type: 'climb.created', actorId: A.id, metadata: { climbUuid, boardType: "kilter", layoutId: 1 } })
    → Notification worker resolves recipients:
      1. Users following A → new_climb notification
      2. Users subscribed to kilter/layout 1 → new_climb_global notification
      3. Deduplicate: if user follows A AND subscribes to kilter/1, send only one notification (new_climb takes priority)
```

---

## Phase 5: Notification Pipeline (Message Broker)

Notifications have fundamentally different scalability characteristics than comments or votes. A single action (e.g., a popular user posting an ascent) could fan out to thousands of followers. To avoid coupling mutation latency to notification delivery, we use **Redis Streams** as a lightweight message broker.

### 5.1 Architecture

```
┌──────────────────────┐
│ Mutation              │
│ (addComment, vote,    │
│  followUser, etc.)    │
└──────────┬───────────┘
           │ (1) Publish lightweight event
           ▼
┌──────────────────────┐
│ Redis Stream          │
│ boardsesh:events      │
│ (durable, ordered)    │
└──────────┬───────────┘
           │ (2) Consumer group reads events
           ▼
┌──────────────────────────────────────────────┐
│ Notification Worker (consumer group)          │
│                                               │
│  ┌─────────────┐  ┌───────────────────────┐  │
│  │ Deduplication│  │ Recipient Resolution  │  │
│  │ Check Redis  │  │ (who should be        │  │
│  │ for recent   │  │  notified? lookup     │  │
│  │ duplicates   │  │  followers, authors)  │  │
│  └──────┬──────┘  └───────────┬───────────┘  │
│         │                     │               │
│         ▼                     ▼               │
│  ┌─────────────────────────────────────────┐  │
│  │ (3a) Persist to notifications table     │  │
│  │ (3b) Publish to WebSocket pubsub        │  │
│  │      for real-time delivery              │  │
│  └─────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

### 5.2 Why Redis Streams (not a separate broker)

- **Already in the stack**: Redis is used for pub/sub, session cache, and distributed state. No new infrastructure.
- **Durable**: Unlike pub/sub, Redis Streams persist messages. If the consumer is down, events aren't lost -- they're replayed when it comes back.
- **Consumer groups**: Built-in consumer group support means multiple backend instances can cooperatively process events without duplicating work.
- **Ordered**: Events are processed in order within a stream.
- **Low latency**: Sub-millisecond for publish, <10ms for consumer pickup.

If the system ever outgrows Redis Streams (millions of events/second), the same interface can be swapped for a dedicated broker (e.g., NATS, Kafka) without changing the producer or consumer APIs.

### 5.3 Event Schema

Events published to the stream are lightweight -- they contain just enough to identify what happened. The consumer resolves the full context (recipient lookup, dedup check, etc.).

```typescript
interface SocialEvent {
  type: SocialEventType;
  actorId: string; // Who triggered this
  entityType: SocialEntityType;
  entityId: string; // What it's about
  timestamp: number; // Unix ms
  metadata: Record<string, string>; // Type-specific extra data
}

type SocialEventType =
  | 'comment.created'
  | 'comment.reply'
  | 'vote.cast'
  | 'follow.created'
  | 'climb.created'
  | 'proposal.created'
  | 'proposal.voted'
  | 'proposal.approved'
  | 'proposal.rejected';
```

**Metadata examples:**

- `comment.created`: `{ commentUuid, parentCommentId? }`
- `vote.cast`: `{ value: "+1" | "-1" }`
- `climb.created`: `{ climbUuid, boardType, layoutId, climbName }`
- `proposal.approved`: `{ proposalUuid, proposalType }`
- `follow.created`: `{ followedUserId }`

### 5.4 Producer (mutation side)

Mutations publish events to the stream **after** completing the primary write. This is fire-and-forget from the mutation's perspective:

```typescript
// In addComment mutation, after INSERT:
await eventBroker.publish({
  type: 'comment.created',
  actorId: ctx.userId,
  entityType: 'tick',
  entityId: tickUuid,
  timestamp: Date.now(),
  metadata: { commentUuid: comment.uuid },
});
// Mutation returns immediately -- notification creation is async
```

The `eventBroker.publish()` call is a single `XADD` to Redis -- sub-millisecond, no fanout at this stage.

### 5.5 Consumer (worker side)

The consumer runs as part of each backend instance using Redis consumer groups:

```typescript
// Stream: boardsesh:events
// Consumer group: notification-workers
// Each backend instance is a consumer within the group
```

**Processing pipeline per event:**

1. **Recipient resolution**: Determine who should be notified
   - `comment.reply` → parent comment author
   - `comment.created` on a tick → tick owner (`comment_on_tick` notification)
   - `comment.created` on a climb → climb setter (`comment_on_climb` notification). Setter identity resolved via `board_climbs.userId` or `setterId` matched through `user_board_mappings` (same logic as `setterOverrideCommunityStatus`). Note: `board_climbs` is shorthand for the board-specific climb table (e.g., `kilterClimbs`, `tensionClimbs`).
   - `vote.cast` on a tick → tick owner
   - `follow.created` → the followed user
   - `climb.created` → followers of the setter (via `user_follows`) + subscribers of the board+layout (via `new_climb_subscriptions`). Deduplicate: if a user is both a follower and subscriber, send only one notification (prefer `new_climb` type).
   - `proposal.approved` → proposal creator + all voters

2. **Deduplication**: Check Redis for recent notifications with the same `(actorId, type, entityId, recipientId)`. If one exists within the dedup window (1 hour for votes, 24h for follows), update its timestamp instead of creating a new one.

3. **Persist**: INSERT or UPDATE the `notifications` table.

4. **Real-time delivery**: Call `pubsub.publishNotificationEvent(recipientId, notification)` to push to any active WebSocket subscribers.

5. **Acknowledge**: `XACK` the event in the consumer group so it's not reprocessed.

### 5.6 Consumer Group Configuration

```typescript
const STREAM_KEY = 'boardsesh:events';
const CONSUMER_GROUP = 'notification-workers';
const CONSUMER_NAME = `instance-${instanceId}`; // Unique per backend instance
const BATCH_SIZE = 50; // Process up to 50 events per read
const BLOCK_MS = 5000; // Block for 5s waiting for new events
const CLAIM_IDLE_MS = 30000; // Reclaim events from dead consumers after 30s
```

**Startup:**

```
XGROUP CREATE boardsesh:events notification-workers $ MKSTREAM
```

(Idempotent -- runs on each instance start, fails silently if group exists)

**Read loop:**

```
XREADGROUP GROUP notification-workers instance-{id} COUNT 50 BLOCK 5000 STREAMS boardsesh:events >
```

**Dead consumer recovery:**

```
XAUTOCLAIM boardsesh:events notification-workers instance-{id} 30000 0-0 COUNT 10
```

(Periodically reclaim events from consumers that crashed without ACKing)

### 5.7 Scaling Properties

- **Horizontal scaling**: Each backend instance is a consumer in the group. Adding instances automatically distributes event processing across them.
- **No duplicate processing**: Consumer groups ensure each event is delivered to exactly one consumer.
- **Crash recovery**: Unacknowledged events are automatically reclaimed by other consumers after the idle timeout.
- **Backpressure**: If consumers can't keep up, events queue in the stream. Set `MAXLEN ~10000` to cap memory usage and trim old events.
- **Monitoring**: Track consumer lag via `XINFO GROUPS boardsesh:events` to detect processing bottlenecks.

### 5.8 What Stays Synchronous

Not everything goes through the broker. These stay inline in mutations because they need immediate feedback:

- **Comment event broadcasting** (`CommentAdded`/`Updated`/`Deleted` via pubsub) -- the viewer needs to see new comments immediately. These are already scoped to active viewers and don't fan out.
- **Proposal auto-approval** -- the vote response should reflect the new status immediately, not after async processing.

Only **notifications** (which are fire-and-forget from the user's perspective) go through the broker.

---

## Phase 6: Frontend Components

### 6.1 Component Hierarchy

```
packages/web/app/components/social/
  vote-button.tsx           # Client component: upvote/downvote toggle
  vote-summary.tsx          # Display score with up/down counts
  comment-list.tsx          # Renders comment list with live updates
  comment-item.tsx          # Single comment with vote, reply, edit, delete actions
  comment-form.tsx          # Client component: textarea + submit
  comment-section.tsx       # Combines comment-list + comment-form + subscription
  follow-button.tsx         # Client component: follow/unfollow toggle
  follower-count.tsx        # Display follower/following counts
  notification-bell.tsx     # Client component: bell icon with unread badge
  notification-list.tsx     # Dropdown/drawer list of notifications

packages/web/app/components/proposals/
  proposal-card.tsx          # Single proposal with vote, status, progress bar
  proposal-list.tsx          # List of proposals for a climb (filtered by angle)
  create-proposal-form.tsx   # Client component: grade picker / classic-benchmark toggle
  proposal-section.tsx       # Full proposal panel for climb detail view
  proposal-vote-bar.tsx      # Visual progress bar showing weighted votes vs threshold
  community-status-badge.tsx # Shows community grade/classic/benchmark badges on climb cards
  freeze-indicator.tsx       # Shows frozen state with reason

packages/web/app/components/admin/
  role-management.tsx        # Admin panel for granting/revoking roles
  community-settings.tsx     # Admin/leader panel for configuring thresholds
  freeze-climb-dialog.tsx    # Dialog for freezing a climb with reason

packages/web/app/components/activity-feed/
  activity-feed.tsx         # Server component: main feed container
  feed-item.tsx             # Renders one feed item based on type
  feed-item-ascent.tsx      # Ascent card (reuses existing grouped ascent UI)
  feed-item-new-climb.tsx   # New climb card (climb name, setter, grade)
  feed-item-comment.tsx     # Comment highlight card
  feed-item-playlist.tsx    # Trending playlist climb card

packages/web/app/components/new-climb-feed/
  new-climb-feed.tsx         # Live feed of new climbs for a board+layout
  new-climb-feed-item.tsx    # Single new climb card
  subscribe-button.tsx       # Subscribe/unsubscribe to board+layout notifications

# Search components (modifications to existing + new)
packages/web/app/components/search-drawer/
  search-category-pills.tsx  # NEW: Category pill bar (Climbs | Users | Playlists)
  user-search-results.tsx    # NEW: User search result list
  playlist-search-results.tsx # NEW: Playlist search result list
  search-dropdown.tsx        # MODIFIED: Add category pill at top, switch form per category
  accordion-search-form.tsx  # MODIFIED: Only render when category = 'climbs'
  search-drawer-bridge-context.tsx # EXISTING: Bridge context that exposes search drawer open/summary/filter state to GlobalHeader

packages/web/app/components/board-page/
  header.tsx                 # MODIFIED: Search bar also appears on home page

packages/web/app/components/board-entity/
  create-board-form.tsx      # Client component: create a board (pre-fill from URL context)
  edit-board-form.tsx        # Client component: edit board metadata
  board-card.tsx             # Board card for lists (name, location, stats)
  board-detail.tsx           # Board detail view (stats, leaderboard, comment section)
  board-leaderboard.tsx      # Leaderboard table for a board
  board-selector-pills.tsx   # Pill bar on home page for switching board context
  board-creation-banner.tsx  # Non-intrusive banner prompting board creation
  follow-board-button.tsx    # Follow/unfollow a public board
```

### 6.2 Vote Button (`vote-button.tsx`)

Client component. Renders upvote/downvote arrows with the score between them.

**Props:**

- `entityType: SocialEntityType`
- `entityId: string`
- `initialScore: number`
- `initialUserVote: number | null`

**Behavior:**

- Optimistic UI: immediately update score and arrow state on click
- Call `vote` mutation in background
- On error, revert to previous state
- Unauthenticated users see the score but clicking prompts login

**Design:**

- MUI `IconButton` with `ArrowUpward`/`ArrowDownward` icons
- Active upvote: `colors.success` (#6B9080)
- Active downvote: `colors.error` (#B8524C)
- Neutral: `neutral[400]`
- Score between arrows in `fontSize.sm` (14px), `neutral[800]`

### 6.3 Comment Section (`comment-section.tsx`)

Client component that manages a WebSocket subscription for live updates.

Used on:

- Public playlist climb detail view (entity_type: `playlist_climb`)
- Climb detail / global discussion (entity_type: `climb`)
- Ascent detail in the activity feed (entity_type: `tick`)

**Structure:**

```
[Comment count header]
[Sort toggle: New | Top | Controversial | Hot]
[Comment list]
  [Comment item]
    [Avatar] [Name] [Timestamp] [(edited) if updated_at > created_at]
    [Body text]
    [Vote button] [Reply button] [Edit button if author] [Delete button if author]
    [Replies (collapsed, "Show N replies")]
      [Reply items...]
  ...
[Load more button]
[Comment input form] (if authenticated)
```

**Live updates:**

- On mount, subscribe to `commentUpdates(entityType, entityId)`
- `CommentAdded` → prepend to list (or append depending on sort)
- `CommentUpdated` → update comment in place, show "(edited)"
- `CommentDeleted` → replace body with "[deleted]" or remove if no replies
- On unmount, unsubscribe

**Design notes:**

- One level of replies (flat, like YouTube mobile)
- `TextField` with "Post" button for comment input
- Max 2000 characters with character counter
- MUI `Avatar` with `avatarUrl`, fallback to initials
- Edit mode: inline, replaces body text with a TextField + Save/Cancel

### 6.4 Follow Button (`follow-button.tsx`)

Client component. Appears on user profile pages and in the activity feed.

**States:**

- Not following: outlined button "Follow"
- Following: filled button "Following", hover reveals "Unfollow"
- Loading: disabled with spinner

### 6.5 Notification Bell (`notification-bell.tsx`)

Client component. Lives in the app header/navigation.

**Behavior:**

- Shows bell icon with badge for unread count
- On mount, fetch `notifications(unreadOnly: true)` for count
- Subscribe to `notificationReceived` subscription
- On new notification: increment badge, optionally show toast/snackbar
- On click: open notification dropdown/drawer
- Mark notifications as read when viewed

**Notification list items:**

- "[Actor avatar] [Actor name] followed you" → links to actor's profile
- "[Actor avatar] [Actor name] replied to your comment" → links to comment in context
- "[Actor avatar] [Actor name] commented on your ascent of [climb name]" → links to tick
- "[Actor avatar] [Actor name] upvoted your [comment/ascent]" → links to entity

### 6.6 Activity Feed (`activity-feed.tsx`)

Extends the home page for authenticated users.

**Layout:**

```
[Home page]
  [Board selector (existing)]
  [Activity Feed section]
    [Feed items, strictly chronological...]
      [Ascent card: user avatar, name, climb thumbnail, grade, status, vote]
      [Comment highlight: quoted text, context link, vote]
      [Trending playlist climb: playlist name, climb info, vote count]
    [Load more / infinite scroll]
  [Empty state if no follows: "Follow climbers to see their activity here"]
```

**For unauthenticated users:**

- Show trending/popular content globally
- Prompt to sign in for personalized feed

### 6.7 Unified Search System

The search drawer is extended with a **search category pill bar** at the top, allowing users to switch between searching climbs, users, and playlists. The same search bar component appears on both the climb list page and the home page.

#### Current Architecture (reference)

The existing search system consists of:

- `SearchDrawerBridgeInjector` (in `header.tsx`) -- registers the search drawer opener with `GlobalHeader` via bridge context
- `SearchDropdown` -- full-screen swipeable drawer with `AccordionSearchForm`
- `AccordionSearchForm` -- 3 collapsible filter panels (Quality, Progress, Holds) with a primary Climb filter section
- `UISearchParamsProvider` -- manages filter state with 500ms debounce
- `ClimbsList` -- renders climb results with infinite scroll

All of these are currently climb-specific and live in the climb list page route.

#### Search Category Pill Bar (`search-category-pills.tsx`)

Client component. Renders a horizontal row of MUI `Chip` components at the top of the search drawer, above the search form.

**Props:**

- `activeCategory: SearchCategory` -- currently selected category
- `onCategoryChange: (category: SearchCategory) => void`
- `defaultCategory: SearchCategory` -- set by the host page (home page → `users`, climb list → `climbs`)

**Design:**

```
[  Climbs  |  Users  |  Playlists  ]
```

- MUI `Chip` with `variant="filled"` for active, `variant="outlined"` for inactive
- Horizontal scrollable on small screens
- Sticky at the top of the search drawer

#### Search Drawer Changes (`search-dropdown.tsx`)

The search dropdown is modified to:

1. Accept a `defaultCategory` prop from the host page
2. Render `SearchCategoryPills` at the top (before any search form)
3. **Category-specific content below the pills:**
   - `climbs`: Render existing `AccordionSearchForm` + `ClimbsList` (unchanged)
   - `users`: Render a simple text search input + `UserSearchResults`
   - `playlists`: Render a simple text search input with optional board filter + `PlaylistSearchResults`
4. Recent search pills adapt to show category-relevant recent searches

#### User Search Results (`user-search-results.tsx`)

Client component. Renders a list of user search results with follow buttons.

**Layout per item:**

```
[Avatar] [Display Name]                    [Follow Button]
         [@handle or email prefix]
         [Recent ascents: 12 this month]
```

**Behavior:**

- Fetches from `searchUsers` GraphQL query on text input change (debounced 300ms)
- Minimum 2 characters before searching
- Shows recent search history when input is empty
- Infinite scroll with `hasMore` pagination
- Clicking a user navigates to their profile page

#### Playlist Search Results (`playlist-search-results.tsx`)

Client component. Renders a list of playlist search results.

**Layout per item:**

```
[Thumbnail] [Playlist Name]                [Climb Count]
            [by Owner Name]
            [Board Type badge] [Public/Private badge]
```

**Behavior:**

- Fetches from `searchPlaylists` GraphQL query on text input change (debounced 300ms)
- Minimum 2 characters before searching
- Optional board type filter chip below the search input
- Clicking a playlist navigates to the playlist detail view

#### User Search Form

The user search category shows a simplified form (no accordion):

```
[Search input: "Search users..."]
[Optional: Board type filter chips]
[Results list]
```

The text input searches across `display_name` (fuzzy/prefix match) and `email` (prefix match, only shows match reason, not the email itself for privacy).

#### Playlist Search Form

The playlist search category shows a simplified form:

```
[Search input: "Search playlists..."]
[Board type filter chips: Kilter | Tension | All]
[Results list]
```

#### Home Page Integration

The home page (`packages/web/app/(app)/page.tsx` or equivalent) is modified to:

1. Use the `SearchDrawerBridgeInjector` to register a search drawer opener with `GlobalHeader` via the bridge context
2. Pass `defaultCategory="users"` to the search drawer
3. The search summary in `GlobalHeader` shows "Search users..." as placeholder text when on the home page
4. Tapping the search area in the header opens the unified search drawer with the Users category pre-selected

#### Climb List Page Integration

The existing climb list page (`packages/web/app/(app)/[board_name]/...`) is modified to:

1. Pass `defaultCategory="climbs"` to the search drawer
2. The existing behavior is preserved -- Climbs category shows the same `AccordionSearchForm`
3. Users can switch to Users or Playlists category from within the search drawer

#### Backend: Search Resolvers

New file: `packages/backend/src/graphql/resolvers/social/search.ts`

**`searchUsers` query:**

- Search `users` JOIN `user_profiles` on `display_name` ILIKE `%query%` or `email` ILIKE `query%`
- Optional `boardType` filter: JOIN `user_board_mappings` to filter users active on a specific board
- Compute `recentAscentCount` via subquery on `boardsesh_ticks` in last 30 days
- ORDER BY relevance: exact prefix match first, then fuzzy, then by activity (recent ascent count)
- Paginated with limit/offset
- Rate limit: 20 searches per minute per user

**`searchPlaylists` query:**

- Search `playlists` WHERE `name` ILIKE `%query%` OR `description` ILIKE `%query%`
- Filter: `is_public = true` by default
- Optional `boardType` filter on `playlists.board_type`
- JOIN `users`/`user_profiles` for owner info
- Compute `climbCount` via subquery on `playlist_climbs`
- ORDER BY relevance, then by `climbCount` DESC
- Paginated with limit/offset

---

## Phase 7: Integration Points

### 7.1 Playlist Detail View

Additions to the existing playlist detail:

- **Per-climb vote buttons** inline in the climb list
- **Comment section** below each climb when expanded (or slide-up drawer on mobile)
- **Sort modes** for the climb list: Position (existing manual order), New, Top, Controversial, Hot -- in addition to existing position sort
- **Vote count** badge on each climb card
- **Comment count** badge on each climb card
- Use `bulkVoteSummaries` to batch-load scores for all visible climbs

### 7.2 Climb Detail View

The climb detail page (when viewing from search results, not within a playlist):

- **Global comment section** using `entity_type = 'climb'`, `entity_id = climbUuid`
- **Vote buttons** on the climb
- This is the climb's own discussion, independent of any playlist context
- **Community status badges** showing community grade (if different from Aurora), classic, benchmark
- **Grade outlier warning**: If `gradeOutlierAnalysis.isOutlier` is true, show a prominent banner:
  "This grade may be inaccurate. Adjacent angles (30° and 40°) suggest V4 based on 79 ascents. [Propose correction]"
  The "Propose correction" button pre-fills a grade proposal with the neighbor consensus grade and auto-approves it.
- **Proposal section** (below or in a tab alongside comments):
  - Shows open proposals for this climb: grade/benchmark proposals at the current angle, plus any classic proposals (which are angle-independent)
  - "Propose grade change" / "Propose as benchmark" (angle-specific) / "Propose as classic" (angle-independent) buttons
  - Each proposal card shows: type, proposed value, current value, reason, vote progress bar, comment count
  - Vote buttons on each proposal (support/oppose)
  - Click through to full proposal discussion (comments via `entity_type = 'proposal'`)
  - **Frozen indicator** if the climb is frozen at this angle (with reason, no "propose" buttons)
  - **Proposal history** toggle: show approved/rejected proposals for context
- **Setter controls** (only visible if the authenticated user is the climb's creator):
  - Direct grade adjustment dropdown (bypasses proposal system for grade only)
  - Setter cannot override classic or benchmark status -- those are community-driven
  - Applies immediately via `setterOverrideCommunityStatus` mutation
  - Supersedes any open grade proposals at the affected angle

### 7.3 Ascent/Tick Detail

When viewing an ascent (activity feed or user profile):

- **Vote buttons** on the ascent card
- **Comment section** below the ascent using `entity_type = 'tick'`

### 7.4 User Profile Page

Additions to `/crusher/[user_id]/`:

- **Follower/following counts** in the profile header
- **Follow button** for other users' profiles
- **Followers / Following tabs** showing user lists with follow-back buttons

### 7.5 Home Page

The home page currently redirects to a board. For authenticated users:

- Show the activity feed before/alongside the board redirect
- The feed is the new "landing experience" for returning users

**Board-scoped feed on home page:**

- On load, resolve the user's `defaultBoard` (owned board > most-used board)
- The activity feed pill selector at the top shows board options: `[My Board (default)] [All Boards] [Board 2] ...`
- The default pill pre-selects the user's default board, scoping the feed to activity on that board
- Users can switch to "All Boards" for a global feed, or select a specific board
- If the user has no boards, show "All Boards" and a prompt: "Create a board to see local activity and leaderboards"
- The pill list comes from `myBoards` query (owned boards + boards the user follows)

**Board creation prompt:**

- If the user navigates to a `/{board_type}/{layout_id}/{size_id}/{set_ids}` path and has no matching `user_board`, show a non-intrusive banner: "Climbing here? Save this board for leaderboards and a personalized feed."
- Tapping the banner opens a quick creation form (pre-filled with board config, user just adds name and optional location)

### 7.6 Board Detail View

New page (accessible from search, board cards, or the home page board selector):

- **Board header**: Name, location, board type badge, owner info
- **Board stats**: Total ascents, unique climbers, most popular grade range
- **Leaderboard tab**: Sortable table of top climbers on this board (sends, flashes, hardest grade, session count). Filter by time period (week, month, year, all).
- **Activity tab**: Feed scoped to this board (`boardUuid` filter on `activityFeed`)
- **Comment section**: Using `entity_type = 'board'`, `entity_id = boardUuid`. General discussion about this board (conditions, tips, etc.)
- **Follow button**: For public boards (adds to your board selector and feed sources)
- **Edit button**: For board owner (edit name, location, visibility)

### 7.7 App Navigation

- **Notification bell** in the top navigation bar
- Unread badge synced via WebSocket subscription
- Notification dropdown/drawer accessible from any page

---

## Phase 8: Data Validation and Security

### 8.1 Entity Validation

Before accepting a comment or vote, validate the entity exists:

| `entity_type`    | Validation                                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playlist_climb` | Playlist exists, is public, climb exists in playlist                                                                                                                                                |
| `climb`          | Climb exists in any board's climb table                                                                                                                                                             |
| `tick`           | Tick exists                                                                                                                                                                                         |
| `comment`        | Comment exists and is not deleted (for votes on comments)                                                                                                                                           |
| `proposal`       | Proposal exists (no status restriction -- users can comment on rejected/superseded proposals for discussion, e.g., "why was this rejected?"). Voting on proposals still requires `status = 'open'`. |
| `board`          | Board exists and is public (or requester is the owner)                                                                                                                                              |

### 8.2 Rate Limits

| Action           | Limit                  |
| ---------------- | ---------------------- |
| `addComment`     | 10 per minute per user |
| `updateComment`  | 10 per minute per user |
| `vote`           | 30 per minute per user |
| `followUser`     | 20 per minute per user |
| `createProposal` | 5 per minute per user  |
| `voteOnProposal` | 30 per minute per user |

Implement via Redis (backend is multi-instance) using the existing rate limiter pattern, or a simple sliding window counter in Redis.

### 8.3 Content Moderation (future)

Design supports it but not in initial scope:

- `deleted_at` for removal
- Future: `reported_at` / `reported_by` columns for user reports
- Future: Admin tools built on soft-delete

### 8.4 Privacy

- Follows are public (standard for fitness apps)
- Vote totals are public; individual votes are private (only you see your own vote)
- Comments are public on public entities
- Notifications are private (only the recipient can see them)

### 8.5 Notification Deduplication

To avoid notification spam:

- **Votes**: Don't create a new notification for every vote. Use UPSERT: one notification per `(actor, type, entity)` tuple per hour. If a notification already exists, update its `created_at` instead of inserting a new row.
- **Follows**: One notification per `(actor, recipient)` -- unfollowing and re-following doesn't create a new notification if one exists within 24h.

---

## Implementation Order

Each milestone creates only the DB tables and types it needs, and delivers testable, user-visible value. Migrations are additive -- each one adds new tables/columns without touching prior ones. Postgres enums can be extended with `ALTER TYPE ADD VALUE` if needed in later milestones.

**Dependency chain (M1-M9)**: M1 → M4 (follows → notifications), M1+M2 → M4 → M5 (follows + comments → notifications → feed), M5 → M6 (feed → proposals with notification wiring).

**Dependency chain (M10-M14)**: M10 → M11 (gyms → enhanced sessions), M11 → M12 (sessions → multi-session/board display), M11 → M13 (sessions → feed improvements), M12 → M14 (multi-session → ESP32 display). See [Milestone Dependency Chain](#milestone-dependency-chain) for details.

### Milestone 1: User Profiles & Follow System [COMPLETED]

**User value**: "I can find other climbers, view their profiles, and follow them."

**DB schema (created in this milestone):**

- `user_follows` table (section 1.2)

**GraphQL types:**

- `PublicUserProfile`, `FollowConnection`, `FollowInput`, `FollowListInput`

**Backend:**

1. `followUser` / `unfollowUser` mutations
2. `followers` / `following` / `isFollowing` queries
3. `publicProfile` query with follower/following counts + `isFollowedByMe`
4. `searchUsers` query (basic user search -- needed to find people to follow)

**Frontend:** 5. `FollowButton` component 6. `FollowerCount` display 7. User profile page additions (follower/following counts, follow button, tabs) 8. Basic user search (text input + results list, can be a simple page or drawer)

**Testable outcomes:**

- Search for a user by name → see their profile → follow them
- View your followers/following lists
- Follower counts update correctly

### Milestone 2: Comments & Votes [COMPLETED]

**User value**: "I can discuss climbs and playlists, and upvote/downvote content."

**DB schema (created in this milestone):**

- `social_entity_type` Postgres enum (section 1.1) -- create with all planned values upfront (cheap, avoids future ALTER TYPE)
- `comments` table (section 1.3)
- `votes` table (section 1.4)

**GraphQL types:**

- `Comment`, `CommentConnection`, `VoteSummary`, `SortMode`, `TimePeriod`
- `AddCommentInput`, `UpdateCommentInput`, `VoteInput`, `CommentsInput`, `BulkVoteSummaryInput`

**Backend:**

1. `addComment` / `updateComment` / `deleteComment` mutations
2. `comments` / `commentReplies` queries (with sort modes: new, top, controversial, hot)
3. `vote` mutation with toggle behavior
4. `voteSummary` / `bulkVoteSummaries` queries
5. Entity validation for comments/votes (section 8.1, for entity types available so far: `climb`, `playlist_climb`, `tick`, `comment`)
6. Rate limiting on comment and vote mutations (section 8.2)

**Frontend:** 7. `VoteButton` component with optimistic UI 8. `VoteSummary` display 9. `CommentSection` (form + list + item) with sort toggle 10. `CommentItem` with vote, reply, edit, delete actions 11. Integration: playlist climb detail (per-climb votes + `playlist_climb` comments) 12. Integration: climb detail view (global `climb` comments + votes) 13. Integration: ascent/tick detail (`tick` comments + votes)

**Testable outcomes:**

- Open a climb → post a comment → edit it → delete it
- Upvote/downvote a climb or comment → see score change
- Sort comments by new/top/controversial/hot
- Reply to a comment (1-level threading)
- Bulk vote summaries load for playlist climb lists

### Milestone 3: Board Entity + Leaderboards [COMPLETED]

**User value**: "I can name my physical board, see who climbs on it, and compete on leaderboards."

**DB schema (created in this milestone):**

- `user_boards` table (section 1.7) -- **without PostGIS `location` column initially** (uses `latitude`/`longitude` as plain doubles; PostGIS proximity search deferred to Milestone 8 when search is built)
- `board_follows` table (section 1.14)
- Add `board_id` column to `boardsesh_ticks` (section 1.16)
- Add `board_id` column to `board_sessions` (section 1.16)

**GraphQL types:**

- `UserBoard`, `UserBoardConnection`, `BoardLeaderboardEntry`, `BoardLeaderboard`
- `CreateBoardInput`, `UpdateBoardInput`, `BoardLeaderboardInput`, `MyBoardsInput`, `FollowBoardInput`

**Backend:**

1. `createBoard` / `updateBoard` / `deleteBoard` mutations
2. `board` / `myBoards` / `defaultBoard` queries
3. `followBoard` / `unfollowBoard` mutations
4. `boardLeaderboard` query (ranked by sends, flashes, hardest grade)
5. `resolveBoardFromPath` helper (match URL path → user board)
6. Wire tick logging to auto-populate `board_id`
7. Board comment section (entity_type = `board`)

**Frontend:** 8. `CreateBoardForm` (pre-fill from current URL context) 9. `EditBoardForm` 10. `BoardCard` for lists 11. `BoardDetailView` (stats, leaderboard, comment section) 12. `BoardLeaderboard` with time period filter 13. `BoardSelectorPills` on home page 14. `BoardCreationBanner` on climb list page (when no matching board exists) 15. `FollowBoardButton`

**Testable outcomes:**

- Navigate to a board URL → see "Create board" banner → create board with name/location
- View board detail page → see leaderboard (sends, flashes, hardest grade)
- Filter leaderboard by week/month/year/all
- Follow a public board → see it in your board selector
- Post comments on a board's discussion thread

### Milestone 4: Notification Pipeline + Real-Time Updates [COMPLETED]

**User value**: "I get notified when someone follows me, replies to my comment, or votes on my content. Comments appear live."

**DB schema (created in this milestone):**

- `notification_type` Postgres enum (section 1.5)
- `notifications` table (section 1.5)

**Infrastructure (built once, supports all future milestones):**

1. `EventBroker` using Redis Streams (section 5.1-5.7) -- `XADD`, `XREADGROUP`, `XACK`, consumer groups
2. `SocialEvent` type and all event types (section 5.3) -- define the full set upfront including `climb.created`, `proposal.*` events (even if producers aren't wired yet)
3. Notification worker consumer pipeline: recipient resolution, deduplication, persistence, real-time delivery
4. Consumer group setup with dead-consumer recovery (`XAUTOCLAIM`)
5. PubSub extensions: notification channels + comment channels + new climb channels (section 4.1-4.2) -- wire all channel patterns now even if some aren't used yet
6. Notification retention cleanup job (90-day hard delete)

**Wire existing mutations to publish events:** 7. `addComment` → `comment.created` / `comment.reply` events → notifications for entity owner / parent comment author 8. `vote` → `vote.cast` event → notification for entity owner (deduplicated) 9. `followUser` → `follow.created` event → `new_follower` notification 10. Comment mutations → `CommentAdded`/`Updated`/`Deleted` pubsub events for live updates

**GraphQL types:**

- `Notification`, `NotificationConnection`, `NotificationType`, `NotificationEvent`
- `CommentEvent` union (`CommentAdded`, `CommentUpdated`, `CommentDeleted`)
- `notificationReceived` subscription
- `commentUpdates` subscription

**Backend:** 11. `notifications` query (paginated, unread filter) 12. `markNotificationRead` / `markAllNotificationsRead` mutations 13. `notificationReceived` subscription resolver 14. `commentUpdates` subscription resolver

**Frontend:** 15. `NotificationBell` (bell icon + unread badge in app header) 16. `NotificationList` (dropdown/drawer) 17. Update `CommentSection` to subscribe to live comment updates 18. Toast/snackbar on new notification

**Testable outcomes:**

- User A follows User B → B sees notification in bell
- User A comments on User B's tick → B gets notified
- User A replies to User B's comment → B gets notified
- Two users viewing same climb → comments appear live for both
- Mark notification as read → badge count decrements
- Mark all as read

### Milestone 5: Activity Feed [COMPLETED]

**User value**: "My home page shows what my friends are climbing."

**DB schema (created in this milestone):**

- `feed_item_type` Postgres enum
- `feed_items` table (section 1.17)

**Infrastructure:**

1. Feed fan-out in notification worker: when ascent logged, climb created, or significant comment posted, fan out `feed_item` rows to each follower of the actor (async via Redis Streams)
2. Feed retention cleanup job (180-day hard delete)

**GraphQL types:**

- `ActivityFeedItem`, `ActivityFeedItemType`, `ActivityFeedResult`
- `ActivityFeedInput` (cursor-based pagination, board scoping, sort modes)

**Backend:** 3. `activityFeed` query reading from `feed_items` table 4. Cursor-based pagination with `(created_at, id)` encoding 5. Board-scoped feed: filter by `board_uuid` 6. Sort modes: new (default), top, controversial, hot 7. Unauthenticated trending feed (fan-out-on-read for global trending content)

**Frontend:** 8. `ActivityFeed` server component 9. `FeedItem` components: `FeedItemAscent`, `FeedItemNewClimb`, `FeedItemComment` 10. Home page integration with board-scoped feed (default to user's `defaultBoard`) 11. Board selector pills to switch feed scope 12. Empty state: "Follow climbers to see their activity here" 13. Unauthenticated: trending content + sign-in prompt 14. Infinite scroll / load more

**Testable outcomes:**

- Follow User A → A logs an ascent → see it in your feed
- Follow User A → A creates a climb → see it in your feed
- Filter feed by board → only see activity on that board
- Switch sort mode → items re-sort
- Unauthenticated: see trending content

### Milestone 6: Community Proposals + Admin Roles [COMPLETED]

**User value**: "I can propose grade changes and vote on them. Admins can manage the community."

**DB schema (created in this milestone):**

- `community_role_type` Postgres enum
- `proposal_type`, `proposal_status` Postgres enums
- `community_roles` table (section 1.8)
- `community_settings` table (section 1.9)
- `climb_proposals` table (section 1.10)
- `proposal_votes` table (section 1.11)
- `climb_community_status` table (section 1.12)
- `climb_classic_status` table (section 1.13)

**Backend:**

1. `grantRole` / `revokeRole` mutations (admin only)
2. `communityRoles` / `myRoles` queries
3. `setCommunitySettings` mutation with scope resolution
4. `communitySettings` query
5. `createProposal` mutation (with supersede logic, auto-vote, angle-awareness)
6. Adjacent-angle outlier detection algorithm (auto-approve grade outliers)
7. `voteOnProposal` mutation (weighted votes, auto-approval threshold)
8. `resolveProposal` mutation (admin/leader manual approve/reject)
9. `setterOverrideCommunityStatus` mutation (grade-only setter privilege)
10. `freezeClimb` mutation
11. `climbProposals` / `browseProposals` queries
12. `climbCommunityStatus` / `bulkClimbCommunityStatus` / `climbClassicStatus` queries
13. Wire proposal events to notification pipeline (proposal_approved, proposal_rejected, proposal_vote)

**Frontend:** 14. `ProposalCard` with vote progress bar + "Auto-approved" badge 15. `ProposalSection` for climb detail view (with outlier warning banner) 16. `CreateProposalForm` (grade picker, classic toggle, benchmark toggle) 17. `ProposalVoteBar` (visual weighted vote progress) 18. `CommunityStatusBadge` on climb cards 19. `FreezeIndicator` 20. Setter controls in climb detail (direct grade adjustment for creators) 21. Admin panel: `RoleManagement`, `CommunitySettings` 22. `FreezeClimbDialog`

**Testable outcomes:**

- Open a climb → propose a grade change → see vote progress bar
- Another user votes on your proposal → weighted votes update → auto-approve at threshold
- Create a grade proposal where adjacent angles disagree → auto-approved immediately
- Setter can directly adjust grade without proposal
- Admin grants community leader role → leader's votes count double
- Admin freezes a climb → no new proposals allowed
- Community status badges appear on climb cards

### Milestone 7: New Climb Feed + Subscriptions [COMPLETED]

**User value**: "I can see new climbs being set on my board type and get notified."

**DB schema (created in this milestone):**

- `new_climb_subscriptions` table (section 1.6)

**Backend:**

1. `newClimbFeed` query (recent climbs for board+layout)
2. `myNewClimbSubscriptions` query
3. `subscribeNewClimbs` / `unsubscribeNewClimbs` mutations
4. `newClimbCreated` WebSocket subscription
5. Wire climb creation to notification pipeline:
   - Followers of setter → `new_climb` notification
   - Board+layout subscribers → `new_climb_global` notification
   - Deduplication (follower + subscriber → one notification)

**Frontend:** 6. `NewClimbFeed` (live-updating list) 7. `NewClimbFeedItem` card 8. `SubscribeButton` (subscribe/unsubscribe to board+layout)

**Testable outcomes:**

- View new climb feed for kilter/layout 1 → see recent climbs
- Subscribe to kilter/layout 1 → someone creates a climb → get notified
- Follow a setter → they create a climb → get `new_climb` notification
- Live: viewing the feed → new climb appears in real-time

### Milestone 8: Unified Search + Discovery [PARTIAL]

**Partial coverage note:** Search category pills (frontend items 4-5) and board search (backend item 2, frontend item 8) are partially covered by the existing board entity work in M3. User search (backend item 3) exists from M1. The remaining items (PostGIS proximity, playlist search, home page search default) are not yet implemented. Gym search will be added in M10.

**User value**: "I can search for users, playlists, and boards from one search bar."

**DB schema (created in this milestone):**

- Add PostGIS `location` column to `user_boards` (section 1.7) + GiST index for proximity search
- Migration: `CREATE EXTENSION IF NOT EXISTS postgis;` then `ALTER TABLE user_boards ADD COLUMN location geography(Point, 4326)`

**Backend:**

1. `searchPlaylists` query
2. `searchBoards` query (with PostGIS proximity search: `ST_DWithin`, `ST_Distance`)
3. Enhance `searchUsers` (already exists from M1, add board type filtering)

**Frontend:** 4. `SearchCategoryPills` (Climbs | Users | Playlists | Boards) 5. Modify `SearchDropdown` to accept `defaultCategory` and render category-specific content 6. `UserSearchResults` (enhanced from M1 with follow buttons inline) 7. `PlaylistSearchResults` 8. `BoardSearchResults` with follow buttons 9. Home page: search bar defaults to "Users" category 10. Climb list page: search bar defaults to "Climbs" category

**Testable outcomes:**

- On home page, tap search → see "Users" pre-selected → search for a user → follow them
- Switch to "Playlists" pill → search playlists by name → navigate to one
- Switch to "Boards" pill → search by name or proximity → follow a board
- On climb list, search defaults to existing climb search (no regression)

### Milestone 9: Polish & Performance

1. `vote_counts` materialized table (section 1.15) if COUNT queries are slow
2. Notification batching/grouping in UI ("3 people upvoted your ascent")
3. Infinite scroll refinements for feed and comment lists
4. Comprehensive rate limiting audit via Redis
5. Feed sort mode performance (materialized hot scores if needed)

### Milestone 10: Gym Entity & Board-Gym Relationship

**User value**: "I can create a gym for my boards, manage members, and let others discover and follow my gym."

**DB schema (created in this milestone):**

`gyms` table (`packages/db/src/schema/app/gyms.ts`):

| Column          | Type               | Notes                            |
| --------------- | ------------------ | -------------------------------- |
| `id`            | `bigserial`        | PK                               |
| `uuid`          | `text`             | Unique                           |
| `name`          | `text`             | NOT NULL                         |
| `slug`          | `text`             | Unique, URL-friendly             |
| `owner_id`      | `text`             | FK → users.id, ON DELETE CASCADE |
| `address`       | `text`             | Nullable                         |
| `contact_email` | `text`             | Nullable                         |
| `contact_phone` | `text`             | Nullable                         |
| `latitude`      | `double precision` | Nullable                         |
| `longitude`     | `double precision` | Nullable                         |
| `is_public`     | `boolean`          | DEFAULT true                     |
| `description`   | `text`             | Nullable                         |
| `image_url`     | `text`             | Nullable                         |
| `created_at`    | `timestamp`        | DEFAULT now()                    |
| `updated_at`    | `timestamp`        | DEFAULT now()                    |
| `deleted_at`    | `timestamp`        | Nullable, soft delete            |

`gym_members` table (`packages/db/src/schema/app/gyms.ts`):

| Column       | Type              | Notes                            |
| ------------ | ----------------- | -------------------------------- |
| `id`         | `bigserial`       | PK                               |
| `gym_id`     | `bigint`          | FK → gyms.id, ON DELETE CASCADE  |
| `user_id`    | `text`            | FK → users.id, ON DELETE CASCADE |
| `role`       | `gym_member_role` | Enum: 'admin', 'member'          |
| `created_at` | `timestamp`       | DEFAULT now()                    |

Constraints: Unique `(gym_id, user_id)`. Owner is implicit via `gyms.owner_id`, not in this table.

`gym_follows` table (`packages/db/src/schema/app/gyms.ts`):

| Column       | Type        | Notes                            |
| ------------ | ----------- | -------------------------------- |
| `id`         | `bigserial` | PK                               |
| `gym_id`     | `bigint`    | FK → gyms.id, ON DELETE CASCADE  |
| `user_id`    | `text`      | FK → users.id, ON DELETE CASCADE |
| `created_at` | `timestamp` | DEFAULT now()                    |

Constraints: Unique `(gym_id, user_id)`.

Schema modification to `user_boards`:

- Add `gym_id` column: `bigint`, nullable, FK → gyms.id ON DELETE SET NULL
- Index on `gym_id`

Add `gym` to `social_entity_type` enum: `ALTER TYPE social_entity_type ADD VALUE 'gym';`

**GraphQL types:**

- `Gym`, `GymConnection`, `GymMember`, `GymMemberRole` enum (`admin`, `member`)
- `CreateGymInput` (name, description, address, latitude, longitude, isPublic, imageUrl)
- `UpdateGymInput` (same fields, optional)
- `AddGymMemberInput` (gymUuid, userId, role)
- `RemoveGymMemberInput` (gymUuid, userId)
- `FollowGymInput` (gymUuid)
- `MyGymsInput` (includeFollowed: Boolean)
- `SearchGymsInput` (query: String, latitude, longitude, radiusKm)

**Backend:**

1. `createGym` mutation -- auto-link board if creating from board context
2. `updateGym` / `deleteGym` mutations -- owner only
3. `addGymMember` / `removeGymMember` mutations -- owner/admin only
4. `followGym` / `unfollowGym` mutations
5. `gym` / `myGyms` / `searchGyms` queries
6. `gymMembers` / `gymFollowers` queries
7. Auto-create gym flow: when creating a board, if user has no gym → create gym + link board. If user has 1+ gym → prompt "Add to existing gym?"
8. Wire `gym` entity_type into comments and votes resolvers

**Frontend:** 9. `GymCreationFlow` -- integrated into board creation wizard 10. `GymProfilePage` -- name, boards list, members, followers, comment section 11. `GymCard` for search results and lists 12. `GymMemberManagement` -- add/remove members, change roles 13. `FollowGymButton` 14. `GymSelector` in board creation form (for users with existing gyms)

**Testable outcomes:**

- Create a board → auto-created gym appears in "My Gyms"
- Create a second board → prompted to add to existing gym or create new
- Add a member to gym → they see gym in their list
- Follow a public gym → see it in followed gyms
- Search for gyms by name
- Gym profile page shows boards, members, follower count

### Milestone 11: Enhanced Sessions

> **Note**: Sessions are explicit `board_sessions` rows. The old inferred-session system and edit mutations were removed; the plan below covers additional party mode enhancements not yet built.

**User value**: "I can set goals for my session, see a summary when I'm done, and sessions automatically end when everyone leaves."

**DB schema changes to `board_sessions`** (`packages/db/src/schema/app/sessions.ts`):

| Column         | Type        | Notes                                         |
| -------------- | ----------- | --------------------------------------------- |
| `goal`         | `text`      | Nullable, session goal text                   |
| `is_public`    | `boolean`   | DEFAULT true                                  |
| `started_at`   | `timestamp` | Nullable, explicit start time                 |
| `ended_at`     | `timestamp` | Nullable, explicit or auto end time           |
| `is_permanent` | `boolean`   | DEFAULT false, exempt from auto-end           |
| `color`        | `text`      | Nullable, hex color for multi-session display |

New `session_boards` junction table (`packages/db/src/schema/app/sessions.ts`):

| Column       | Type        | Notes                                     |
| ------------ | ----------- | ----------------------------------------- |
| `id`         | `bigserial` | PK                                        |
| `session_id` | `text`      | FK → board_sessions.id, ON DELETE CASCADE |
| `board_id`   | `bigint`    | FK → user_boards.id, ON DELETE CASCADE    |
| `created_at` | `timestamp` | DEFAULT now()                             |

Constraints: Unique `(session_id, board_id)`. All boards must belong to the same gym (enforced at app layer).

**GraphQL types:**

- Update `Session` type with new fields: `goal`, `isPublic`, `startedAt`, `endedAt`, `isPermanent`, `color`
- `SessionSummary` -- grade distribution (array of `{grade, count}`), total sends/attempts, hardest climb (uuid + name + grade), participant list
- `CreateSessionInput` -- add `goal`, `isPermanent`, `boardIds[]`, `color`
- `EndSessionInput` (sessionId)
- `SessionSummaryInput` (sessionId)

**Backend:**

1. Add new columns via migration
2. Session auto-end job: periodic cleanup (every 5 min), end sessions where `last_activity < NOW() - interval` AND `is_permanent = false` AND `status = 'inactive'`
3. `endSession` mutation -- sets `ended_at`, changes status to 'ended', generates summary
4. `sessionSummary` query -- aggregates `boardsesh_ticks` by `session_id`: grade distribution, participant stats, hardest climbs
5. Update `createSession` to accept `goal`, `color`, `boardIds`
6. Validate multi-board: all boards must share the same `gym_id` (requires M10)

**Frontend:** 7. Session creation form: add goal input, color picker, board multi-select (if gym has >1 board) 8. Session end summary view: reuse grade bar chart from `profile-stats-charts.tsx`, show participants, hardest climbs 9. Session detail in activity feed: summary card with chart + participant avatars 10. Permanent session toggle in admin/settings

**Testable outcomes:**

- Create session with goal → goal displays in session header
- End session → see grade distribution summary with bar chart
- Session auto-ends after 30min inactivity (configurable)
- Permanent session stays active indefinitely
- Create multi-board session → queue accepts climbs from all boards in the session

### Milestone 12: Multi-Session & Multi-Board Display

**User value**: "Multiple groups can share one board with their own sessions, and I can climb across multiple boards in one session."

**Backend:**

1. Allow multiple active sessions per `board_id` (remove any single-session assumptions)
2. "My turn" signaling: new `claimTurn` mutation -- sets the active session for the board's display
3. Session color assignment: auto-assign distinct colors when multiple sessions exist on a board
4. `activeSessions` query for a board -- returns all active sessions with colors
5. Cross-board climb search: `searchClimbs` accepts multiple board configs (`boardType`/`layoutId`/`sizeId`/`setIds` combos)
6. Extend `ClimbQueueItem` with optional `boardId` and `boardPath` for multi-board queues

**Shared types updates** (`packages/shared-schema/src/types.ts`):

- Add `boardId?: number` and `boardPath?: string` to `ClimbQueueItem` and `ClimbQueueItemInput`
- Add `ActiveBoardSession` type: `{ sessionId: string; name: string; color: string; participantCount: number; isMyTurn: boolean }`

**Frontend:** 7. Multi-session indicator on board page (shows colored dots for active sessions) 8. "Claim turn" button in session UI when board has multiple sessions 9. Session color display throughout UI (queue bar, session list) 10. Multi-board session: board switcher tabs when session spans multiple boards 11. Cross-board search results: show which board each climb belongs to

**Testable outcomes:**

- Two sessions on one board → display shows two colored indicators
- Press "My turn" → board LEDs switch to my session's current climb
- Create session with 2 boards → search finds climbs from both
- Add climb from board A and board B to same queue → works correctly

### Milestone 13: Activity Feed Improvements

**User value**: "My feed shows session summaries instead of individual ascents, supports deep linking, and I can @mention friends."

**DB schema:**

- Add `mention` to `notification_type` enum: `ALTER TYPE notification_type ADD VALUE 'mention';`
- Add `session_id` column to `feed_items` table: `text`, nullable, FK → board_sessions.id ON DELETE SET NULL
- Add `session_summary` to `feed_item_type` enum: `ALTER TYPE feed_item_type ADD VALUE 'session_summary';`

**Backend:**

1. Session summary aggregation: when generating feed items for ascents, group by explicit `session_id` only. Solo ticks without a session stay out of session summaries.
2. `sessionFeedSummary` query -- returns grouped ascent data for a session/time-window: grade distribution, participant list, hardest climbs
3. @mention parsing: extract `@username` from comment body, resolve to `user_id`
4. @mention notifications: new `mention` notification type, wire to notification pipeline
5. Activity feed SSR endpoint: accept URL search params for `boardUuid` and `tab` (sessions/proposals/comments)
6. Proposal feed items: include proposals from boards/climbs the user follows in feed fanout

**Frontend:** 7. SSR activity feed: move filtering to URL search params, server-render initial page 8. `SessionSummaryFeedItem` component:

- Participant avatars row ("Bob, Marco, and Anton had a session")
- Grade distribution bar chart (reuse from `profile-stats-charts.tsx`)
- Slideshow of 5 hardest climb previews (board renderer thumbnails)
- Total sends/attempts count

9. @mention autocomplete in `CommentForm`: `@` trigger → dropdown of followed users
10. @mention rendering: clickable links to user profiles
11. "Jump back in" horizontal slider on home page:
    - Shows boards user has recently used (from recent ticks/sessions)
    - Each card: board name, last session date, quick "Start session" action
    - Horizontal scroll with snap points
12. URL-based feed filtering: board selector updates URL, sort selector updates URL
13. Deep linking: feed URLs are shareable and SSR-rendered

**Testable outcomes:**

- View feed → see session summaries instead of individual ascents
- Session summary shows grade chart and participant avatars
- Click through slideshow of hardest climbs in a session
- Type `@` in comment → see autocomplete dropdown → mention resolves to profile link
- Mentioned user receives notification
- Share feed URL → recipient sees same filtered view (SSR)
- Home page shows "Jump back in" slider with recent boards

### Milestone 14: Boardsesh Display Modes (ESP32)

**User value**: "My Boardsesh display automatically adapts to show the right layout for my session setup."

**Backend:**

1. Display mode detection: when controller connects, check number of active sessions on board
2. Send `ControllerDisplayConfig` event on controller connection and when session count changes
3. Session button press handling: controller reports which session was selected → backend processes turn claim via `claimTurn` mutation (M12)

**Shared types** (`packages/shared-schema/src/types.ts`):

- `DisplayMode = 'single_session' | 'multi_session'`
- `ControllerDisplayConfig = { mode: DisplayMode; sessions: ActiveBoardSession[] }`
- `ControllerSessionClaim = { __typename: 'SessionClaim'; sessionId: string }`
- Add `ControllerDisplayConfig` and `ControllerSessionClaim` to `ControllerEvent` union

**ESP32 firmware:** 4. Single-session layout renderer: board preview (2/3 width) + scrollable queue list (1/3 width) 5. Multi-session layout renderer: board preview (2/3 width) + colored session buttons (1/3 width) 6. Session button interaction: touch handler → WebSocket message → turn claimed 7. Display mode switching: smooth transition when sessions are added/removed 8. Queue list rendering: climb name, grade (with grade color), setter

**Testable outcomes:**

- Single session on board → display shows climb + queue
- Second session created → display switches to multi-session mode with colored buttons
- Press session button → board LEDs update to that session's climb
- Session ends → display returns to single-session mode (or idle)

### Milestone Dependency Chain

Milestones 10-14 have the following dependency graph:

```
M10 (Gyms) → M11 (Enhanced Sessions) → M12 (Multi-Session/Board) → M14 (ESP32 Display)
                                      → M13 (Feed Improvements)
```

- **M10 (Gyms)** -- independent, can start immediately
- **M11 (Enhanced Sessions)** -- depends on M10 (multi-board sessions need gym to validate boards belong to same gym)
- **M12 (Multi-Session/Board Display)** -- depends on M11
- **M13 (Feed Improvements)** -- depends on M11 (session summaries need enhanced sessions)
- **M14 (ESP32 Display)** -- depends on M12

---

## Future Considerations

Features and improvements not in the initial scope but worth designing toward:

- **Email digest notifications** -- daily/weekly summary of activity (new followers, comment replies, proposal outcomes) for users who don't check the app daily
- **Push notifications** -- mobile web / PWA push notifications for time-sensitive events (proposal approved, new follower, comment reply)
- **Content moderation** -- report system for flagging inappropriate comments, automated filtering, and admin review queue
- **Comment reactions** -- emoji reactions on comments alongside up/downvotes (lightweight engagement without full voting semantics)
- **Direct messaging** -- private messaging between users for coordination (send a climb, share a playlist)
- **Collaborative playlists** -- multiple editors on a single playlist with invitation and permission management
- **Feed recommendations** -- algorithmic feed alongside the chronological feed, surfacing content based on climbing ability, board preferences, and engagement patterns
- **Per-board leaderboard seasons** -- time-boxed leaderboard periods (monthly/quarterly) with historical rankings and achievements
- **Gym analytics dashboard** -- usage stats, popular climbs, peak hours, member engagement metrics for gym owners
- **Cross-gym events** -- competitions or challenges that span multiple gyms, with shared leaderboards
- **Session replays** -- record and replay a session's climb sequence for training analysis or sharing
