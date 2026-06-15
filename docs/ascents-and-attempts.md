# Ascents and Attempts

This document describes how Boardsesh models a user's interactions with a climb — the per-tick "I tried this" and "I sent this" records — across schema, write paths, read paths, Aurora sync, and stats aggregation. Read this before touching any code that creates, queries, or aggregates `boardsesh_ticks`.

## Table of Contents

1. [Mental Model](#mental-model)
2. [The Single Table: `boardsesh_ticks`](#the-single-table-boardsesh_ticks)
3. [Status Taxonomy](#status-taxonomy)
4. [`difficulty` Is Nullable — and That's Intentional](#difficulty-is-nullable--and-thats-intentional)
5. [Quality Is Nullable Too](#quality-is-nullable-too)
6. [Write Paths](#write-paths)
7. [Read Paths and the Consensus Fallback](#read-paths-and-the-consensus-fallback)
8. [Aurora Sync Mapping](#aurora-sync-mapping)
9. [Sessions](#sessions)
10. [Rules for Future Code](#rules-for-future-code)

---

## Mental Model

A **tick** is a single row in `boardsesh_ticks`. It records that a user did _something_ on a climb at a specific angle at a specific time. There are exactly three things a tick can represent:

- **flash** — user completed the climb on the first attempt
- **send** — user completed the climb after one or more failed attempts
- **attempt** — user tried and did _not_ complete the climb (a "bid")

A flash and a send are collectively "ascents". Attempts are "bids". The same user can log many ticks against the same climb at the same angle over time — ticks are not deduplicated; their natural key is `(uuid)` (a Boardsesh-generated UUID), with `aurora_id` as the cross-system anchor when the tick has been synced.

Everything about ascents is single-table: one PostgreSQL table (`boardsesh_ticks`), one TypeScript type (`BoardseshTick`), one GraphQL type (`Tick`).

---

## The Single Table: `boardsesh_ticks`

Schema lives at `packages/db/src/schema/app/ascents.ts`. Key fields:

| Field                       | Type                          | Purpose                                                                                                                      |
| --------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `uuid`                      | `text` (unique)               | Boardsesh-generated UUID, the stable identifier we expose externally                                                         |
| `user_id`                   | `text` → `users.id`           | Owner of this tick; cascades on user delete                                                                                  |
| `board_type`                | `text`                        | `'kilter'`, `'tension'`, or `'moonboard'`                                                                                    |
| `climb_uuid`                | `text`                        | References `board_climbs.uuid` (logically — there's intentionally no FK; see schema comments)                                |
| `angle`                     | `int`                         | Wall angle at climb time, in degrees                                                                                         |
| `is_mirror`                 | `bool`                        | Whether the user climbed the mirrored variant                                                                                |
| `status`                    | `tick_status` enum            | `'flash'` / `'send'` / `'attempt'`                                                                                           |
| `attempt_count`             | `int`                         | Number of attempts for this entry. **Always `1` for flash.** For sends and attempts, it's the count the user reported        |
| `quality`                   | `int?`                        | 1–5 user star rating. **Null for attempts**, optionally null for ascents                                                     |
| `difficulty`                | `int?`                        | User's personal grade override (a `difficulty_id`, not a name). **Null means "use the climb's consensus grade"** — see below |
| `is_benchmark`              | `bool`                        | Whether the user marked the climb as a benchmark                                                                             |
| `comment`                   | `text`                        | Free-form note                                                                                                               |
| `climbed_at`                | `timestamp`                   | When the climb happened (user-supplied, not server-time)                                                                     |
| `created_at` / `updated_at` | `timestamp`                   | Row audit                                                                                                                    |
| `session_id`                | `text?` → `board_sessions.id` | If logged inside an explicitly-created session                                                                               |
| `board_id`                  | `bigint?` → `user_boards.id`  | The physical board the tick was recorded on, when known                                                                      |
| `aurora_type`               | `aurora_table_type?` enum     | `'ascents'` / `'bids'`; null until synced to Aurora                                                                          |
| `aurora_id`                 | `text?`                       | Aurora's UUID once synced (uniquely indexed)                                                                                 |
| `aurora_synced_at`          | `timestamp?`                  | When the sync succeeded                                                                                                      |
| `aurora_sync_error`         | `text?`                       | Last sync error if a sync attempt failed                                                                                     |

The `tick_status` and `aurora_table_type` enums are defined alongside the table. Don't introduce new enum values without coordinating with the Aurora API mapping in `packages/aurora-sync/src/sync/user-sync.ts`.

---

## Status Taxonomy

```
                    completed?
                       │
              ┌────────┴────────┐
              │                 │
             yes                no
              │                 │
        attempt_count?      'attempt'
        ┌────┴────┐         (Aurora: bids)
        │         │
        1     >1
        │         │
     'flash'   'send'
            (Aurora: ascents)
```

Two write paths derive status differently:

- **QuickTickBar** (compact in-app tick bar — `packages/web/app/components/logbook/quick-tick-bar.tsx`) derives status from `(hasPriorHistory, attemptCount)`:
  - If `attemptCount === 1` _and_ the user has no prior logbook entry for this climb → `flash`
  - Otherwise an ascent → `send`
  - Explicit attempt button → `attempt`
- **LogAscentForm** (the full form — `packages/web/app/components/logbook/logascent-form.tsx`) uses the simpler `getAscentStatus(attempts) = attempts === 1 ? 'flash' : 'send'` plus an explicit `LogType` toggle for attempts.

These rules can diverge — keep them in mind when adding a new save UI. The status field is the source of truth; don't re-derive it on the read side.

> **Legacy heuristic:** `chart-data-builders.buildFlashRedpointBars` still falls back to `attempts === 1 ? flash : send` when `status` is null. That's only for very old pre-status rows; new code must set `status` explicitly.

---

## `difficulty` Is Nullable — and That's Intentional

`boardsesh_ticks.difficulty` is the user's _personal_ grade for this ascent. It is **not** the climb's consensus grade.

A user logging a tick may:

1. **Manually pick a grade** in the picker → `difficulty = the picked difficulty_id`
2. **Tap "tick" without opening the grade picker** → `difficulty = null`
3. **Log a `attempt`** → `difficulty = null` (by convention; attempts don't carry a grade)

Option 2 is the common case. `QuickTickBar` initializes `difficulty` state to `undefined` and only sets it if the user explicitly picks one. The consensus grade is offered as a _focus hint_ in the picker (`focusGradeId={consensusGradeId}`) but is intentionally **not** baked into the saved row. This keeps the stored data honest: `null` means "use whatever the current consensus is", so the tick's effective grade tracks the climb's consensus over time even if it gets re-graded later.

**Aurora imports are also allowed to be null.** `packages/aurora-sync/src/sync/user-sync.ts:176` does `item.difficulty ? Number(item.difficulty) : null` — if Aurora doesn't send a difficulty (e.g. some older rows), we store null and lean on the read-side fallback.

### The consequence: read paths must fall back to consensus

Any aggregation, display, or filter that touches grade **must** COALESCE `boardsesh_ticks.difficulty` with the climb's consensus difficulty from `board_climb_stats`. Otherwise ungraded ticks silently disappear from charts or fall outside grade-range filters.

The pattern (`packages/backend/src/graphql/resolvers/ticks/queries.ts`):

```ts
COALESCE(boardseshTicks.difficulty, consensusDifficultyExpr);
```

where `consensusDifficultyExpr = ROUND(boardClimbStats.displayDifficulty)`, defined in `packages/backend/src/graphql/resolvers/shared/sql-expressions.ts`. Reusing this expression in any new tick-aggregation query also keeps the `board_climb_stats` join shape consistent — it's joined on `(climbUuid, boardType, angle)` (its primary key, so the join doesn't multiply rows).

### `difficulty` and `effectiveDifficulty` — two separate GraphQL fields

The `Tick` GraphQL type exposes both:

- `difficulty: Int` — the **raw** stored value. NULL when the user didn't attach a personal override. Use this when you care about the user's intent (e.g. an "edit my grade" UI, or an Aurora sync write-back).
- `effectiveDifficulty: Int` — the COALESCE'd value. Use this for charts, leaderboards, filters, and any per-grade bucketing. Still nullable when neither the tick nor the climb has a grade yet.

Splitting them prevents an optimistic write (`useSaveTick` puts the raw user input on a temp row) from flickering when the server hydration comes back: optimistic and server `difficulty` agree (both null for ungraded), and `effectiveDifficulty` simply fills in once the server knows the consensus.

### Resolvers that fall back to consensus

| Resolver                                                      | Surface                                            | How                                                                                                                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `userTicks` (`queries.ts:126`)                                | profile stats charts, hardest send/flash, V-points | LEFT JOIN `board_climb_stats`, expose both `difficulty` and `effectiveDifficulty`                                                                                        |
| `userProfileStats` (`queries.ts:773`)                         | per-layout grade buckets, layout %s                | Same JOIN, `groupBy(layoutId, COALESCE(...))`, plus a separate per-layout distinct sub-query so `distinctClimbCount` is correct when a climb appears in multiple buckets |
| `userAscentsFeed` (`queries.ts:176`)                          | activity feed                                      | `minDifficulty` / `maxDifficulty` filter on `COALESCE(...)` so ungraded ticks whose consensus is in range still appear                                                   |
| `followingLeaderboard.hardestGrade` (`social/boards.ts:1035`) | follow-leaderboard                                 | `MAX(COALESCE(...))` so ungraded sends still raise a user's hardest grade                                                                                                |

If neither the tick nor `board_climb_stats` has a difficulty (e.g. a brand-new unrated climb), the effective difficulty remains `null` and the row is excluded from grade buckets but still counts toward total ascent counts. That's the correct behavior — there's no way to bucket it.

---

## Quality Is Nullable Too

Same rules as difficulty, with one simplification: there's no community-wide "consensus star rating" to fall back to (`board_climb_stats.qualityAverage` exists but isn't used as a substitute for the user's rating). A null quality on an ascent simply means "user didn't rate this one". Attempts always have null quality by convention.

---

## Write Paths

There are exactly three production code paths that insert into `boardsesh_ticks`:

### 1. `saveTick` GraphQL mutation

`packages/backend/src/graphql/resolvers/ticks/mutations.ts:276`. Inserts one row.

- `difficulty: validatedInput.difficulty ?? null` — undefined → null
- `quality: validatedInput.quality ?? null`
- Aurora fields all set to `null`; they get populated later by the periodic sync daemon.
- Publishes `ascent.logged` event for the feed (only for `flash`/`send`, not `attempt`).
- If `videoUrl` was attached to a successful ascent, also inserts a
  `board_beta_links` row tied directly to the new tick via `tick_uuid` and to
  the resolved wall via `board_id` when one is known. Attempts ignore
  `videoUrl`.
- Beta-link inserts store a `video_identity` canonicalized from the platform
  media id when possible. That keeps one canonical beta row per video and one
  beta row per tick; a same-climb duplicate on `saveTick` skips only the beta
  side effect and still saves the tick.
- Calls `queueClimbStatsRecompute(boardType, climbUuid, angle)`. The debounced job
  (2 s window, `packages/backend/src/graphql/resolvers/ticks/debounced-climb-stats-publisher.ts`)
  recomputes `board_climb_stats.boardsesh_ascensionist_count` from the
  current ticks for that `(board_type, climb_uuid, angle)` triplet, and —
  for Boardsesh-originated climbs only — also rewrites
  `quality_average`, `difficulty_average`, and `display_difficulty` from
  the same ticks. See [`aurora-sync.md`](aurora-sync.md) for the
  two-writer model that the recompute coordinates with.

Two client hooks call it:

- `useSaveTick` (`packages/web/app/hooks/use-save-tick.ts`) — low-level React Query mutation; optimistically updates the logbook cache.
- `useTickSave` (`packages/web/app/hooks/use-tick-save.ts`) — higher-level wrapper used by `QuickTickBar` and `InlineListTickBar`; handles status derivation, confetti, and IndexedDB drafts for offline retry.

### 2. Aurora sync — ascents

`packages/aurora-sync/src/sync/user-sync.ts:162`. Bulk inserts (upserts on `aurora_id`) from Aurora's `ascents` table. Maps `attempt_id === 1 → flash`, else → `send`. Preserves Aurora's `difficulty` if present, otherwise null.

### 3. Aurora sync — bids

`packages/aurora-sync/src/sync/user-sync.ts:214`. Bulk inserts attempts. Status is hardcoded to `'attempt'`. Quality and difficulty are always null.

**No other code path may insert into `boardsesh_ticks`.** If you need to bulk-create ticks (a test, an import script), route through the same code or write a script in `packages/aurora-sync` that mirrors this shape.

### Stats recompute on edits and deletes

`updateTick` and `deleteTick` (same `mutations.ts` file) don't insert new
ticks but they do change the answer to "how many distinct users sent this
climb at this angle, who was first, and — for Boardsesh-owned climbs —
what the average quality and difficulty are." Both call
`queueClimbStatsRecompute` after their write commits, so a deleted ascent
correctly demotes `board_climb_stats.fa_*` to the next earliest sender (or
to `NULL` if no senders remain), a status edit from `attempt` → `send`
bumps the count, and a quality / difficulty edit (or delete-last-tick) on a
Boardsesh-originated climb shifts `quality_average` / `difficulty_average`
/ `display_difficulty` accordingly. If you add a new mutation that touches
ticks, queue a recompute too.

---

## Read Paths and the Consensus Fallback

| Surface                                                       | Resolver / fetch                      | Joins `board_climb_stats`?                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Profile stats (per-grade chart, hardest send/flash, V-points) | `userTicks` (`queries.ts:126`)        | ✅ uses consensus fallback                                                                                                   |
| Profile stats summary (layout %, grade buckets)               | `userProfileStats` (`queries.ts:773`) | ✅ uses consensus fallback                                                                                                   |
| Profile activity feed                                         | `userAscentsFeed` (`queries.ts:176`)  | ✅ joins `board_climb_stats` — exposes both `tick.difficulty` (raw) and `consensusDifficulty` (rounded) for the UI to choose |
| Logbook (`/you/logbook`)                                      | `userAscentsFeed` via React Query     | Inherits from feed resolver                                                                                                  |
| Climb pages (counters per-user)                               | various climb queries                 | n/a — they count rows, not grades                                                                                            |
| Percentile ranking                                            | `userClimbPercentile` (`queries.ts`)  | Doesn't need it — counts distinct climbs, not grade buckets                                                                  |

When you add a new chart, leaderboard, or stat that groups ticks by grade, follow the join-and-coalesce pattern. Don't query `boardsesh_ticks.difficulty` directly.

### Client-side filtering

Once the resolver provides the effective difficulty, client code (e.g. `packages/web/app/profile/[user_id]/utils/chart-data-builders.ts`) still includes a defensive `if (entry.difficulty === null) return` guard. That guard is intentional — it handles the case where neither the user nor the consensus has a grade (new climbs, no `board_climb_stats` row yet) — but it should rarely fire in practice. **Do not pre-filter in the resolver** to "save bytes": the client guard is the right place.

---

## Aurora Sync Mapping

```
Aurora `ascents` table  ───►  boardsesh_ticks.status ∈ {'flash','send'}
                              boardsesh_ticks.aurora_type = 'ascents'

Aurora `bids` table      ───►  boardsesh_ticks.status = 'attempt'
                              boardsesh_ticks.aurora_type = 'bids'
```

`aurora_id` is the cross-system anchor. It's unique (Postgres allows multiple nulls), so the periodic sync daemon can upsert without dup-key risk. Reverse direction (Boardsesh → Aurora) is the responsibility of a separate sync job that picks up rows with `aurora_id IS NULL` and posts them to Aurora. After success, `aurora_id`, `aurora_type`, and `aurora_synced_at` are written back to the row. See [`aurora-sync.md`](aurora-sync.md) for the full sync architecture.

---

## Sessions

Ticks only belong to a session when they were logged inside an explicitly-created `board_sessions` row via `session_id`. Solo ticks are not auto-grouped into sessions.

---

## Rules for Future Code

1. **Don't treat `tick.difficulty` as required.** If you see a non-null assertion, a Zod schema marking it required, or a `.filter(t => t.difficulty != null)` that's being used to _exclude_ ascents from a count, that's a bug.
2. **Don't pre-bake the consensus grade into the saved row.** The whole point of the nullable column is that it tracks consensus changes over time. If a user genuinely meant to override, they would have picked a grade.
3. **Always join `board_climb_stats` and COALESCE** when grouping ticks by grade. Reuse `consensusDifficultyExpr` from `packages/backend/src/graphql/resolvers/shared/sql-expressions.ts`.
4. **Status is the source of truth, not `attempt_count`.** New code must check `status === 'flash'` / `'send'` / `'attempt'`, not infer from attempt counts. The attempt-count heuristic in `buildFlashRedpointBars` is a legacy fallback for pre-status rows only.
5. **All inserts go through `saveTick` or the Aurora sync.** Don't write ad-hoc inserts elsewhere; you'll skip the `ascent.logged` event, beta-link attach, and the IndexedDB draft cleanup.
6. **Tick-specific beta links belong on `board_beta_links.tick_uuid`.** The legacy climb-level lookup still exists for old rows, but new successful tick attachments should carry `tick_uuid`, `board_id` when known, and `video_identity`. A tick can have at most one beta link, and a canonical video can belong to only one beta row.
7. **Aurora fields are owned by the sync daemon.** Don't set `aurora_id`, `aurora_type`, or `aurora_synced_at` from a write path other than the sync job.
8. **Attempts never carry a `quality` or `difficulty`.** If you add an "attempt with grade override" UX, document it here first — every aggregation in this doc assumes the convention.

If you change any of these invariants, update this document in the same PR.
