# Aurora Sync

This document describes how Aurora board data (Kilter, Tension) is synced from the Aurora Climbing API to the Boardsesh database.

## Overview

The `@boardsesh/aurora-sync` package provides the shared sync implementation. It can run:

1. **CLI** - For local debugging and manual sync runs
2. **Daemon CLI on a VM** - `aurora-sync daemon` as a long-lived process: picks one user per cycle, syncs their per-user tables, then runs a board-wide shared sync using their fresh Aurora token. This is the production deployment.
3. **Backend / Vercel cron** - (Removed) Previously a `POST /sync-cron` backend handler and a `/api/internal/user-sync-cron` Vercel route; both removed in favour of the long-lived daemon. The shared-sync cooldown is persisted in Postgres, so deploys and overlapping daemon instances share the same per-board gate.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│  aurora-sync    │────▶│   Postgres      │
│  daemon (VM)    │     │   (prod)        │
└─────────────────┘     └─────────────────┘
        │
        ▼
┌──────────────────┐
│   Aurora API     │
│  (Kilter/Tension)│
└──────────────────┘
```

## How Sync Works

### 1. Credential Retrieval

- Fetch all users with stored Aurora credentials from `aurora_credentials` table
- Decrypt username/password using `AURORA_CREDENTIALS_SECRET`

### 2. Authentication

- Login to Aurora API to get fresh session token
- Store encrypted token for future use

### 3. Incremental Sync

- Request data from Aurora `/sync` endpoint with last sync timestamps
- Aurora returns only data changed since last sync
- Uses `_complete` flag for pagination of large datasets

### 4. Database Writes

- **Batched inserts** (100 rows per batch) for performance
- **Fresh pool per sync** to avoid Neon WebSocket timeouts
- **Dual-write** for certain tables:
  - `ascents` → `kilter_ascents` + `boardsesh_ticks`
  - `bids` → `kilter_bids` + `boardsesh_ticks`
  - `circuits` → `kilter_circuits` + `playlists` + `playlist_climbs`

### Logbook writes (`ascents`/`bids`): timezone, claim, soft-delete

Both pull implementations (the daemon `packages/aurora-sync/src/sync/user-sync.ts`
and the web cron `packages/web/app/lib/data-sync/aurora/user-sync.ts`) route
`ascents`/`bids` through the shared `applyAuroraAscents` / `applyAuroraBids`
(`packages/aurora-sync/src/sync/apply-user-logbook.ts`):

- **Timezone.** Aurora's naive `"YYYY-MM-DD HH:MM:SS"` is written through
  `normalizeTimestamp`, not `new Date(...)` (which V8 would parse as
  server-local and shift by the deployment offset). That makes a pulled ascent
  land on the same instant the JSON import wrote for the same climb.

  **What the naive string MEANS is an open question ([#3909]).**
  `normalizeTimestamp` currently pins it to UTC, and for ascents Boardsesh
  itself pushed back that round-trips consistently — we send UTC and read the
  same value out. But ascents logged in the official Kilter/Tension app measure
  as the CLIMBER's local wall clock relabelled UTC: that is what
  `packages/db/src/queries/tick-offset-inference.ts` was written to work around,
  and #3909's production measurement found per-USER offsets (−1h×799, +8h×354,
  −10h×319, +5h×153) rather than the single fleet-wide offset a server-local
  parse would produce. If that reading is right, every pull today still writes a
  shifted row. Measure it with `vp run db:report-tick-timezones` (read-only) —
  its control-cohort section splits each origin around the PR4 deploy — and see
  [docs/tick-timezone-correction.md](./tick-timezone-correction.md).

  The by-aurora-id update path carries a guard (`preserveCorrectedClimbedAt`) so
  a legacy row whose `climbed_at` has been corrected is not rewritten with the
  shifted upstream value on the next pull.

[#3909]: https://github.com/boardsesh/boardsesh/issues/3909

- **Cross-source claim.** On an `aurora_id` miss, before inserting, the incoming
  ascent natural-key-matches the user's existing `json_import`/`native` rows
  (widened window + per-user offset inference) and, on a hit, stamps
  `aurora_id`/`aurora_type`/`aurora_synced_at` onto that row (keeping `origin`)
  instead of inserting a twin.
- **Soft-delete.** Aurora `is_listed=false` tombstones a deleted logbook entry:
  a pull-owned row is deleted; a claimed `native`/`json_import` row keeps the tick
  and just drops its aurora markers.
- **Edit-clobber guard.** A by-`aurora_id` re-sync skips a row edited locally
  since the last sync (`updated_at > aurora_synced_at`) and any no-op (unchanged
  payload).

### Tables Synced

#### Per-user tables

| Aurora Table | Local Table                        | Dual Write                 |
| ------------ | ---------------------------------- | -------------------------- |
| users        | kilter_users / tension_users       | -                          |
| walls        | kilter_walls / tension_walls       | -                          |
| ascents      | kilter_ascents / tension_ascents   | boardsesh_ticks            |
| bids         | kilter_bids / tension_bids         | boardsesh_ticks            |
| tags         | kilter_tags / tension_tags         | -                          |
| circuits     | kilter_circuits / tension_circuits | playlists, playlist_climbs |
| draft_climbs | kilter_climbs / tension_climbs     | -                          |

#### Shared (board-wide) tables

After every successful per-user sync, the daemon also runs a shared sync for that user's board, reusing the user's just-refreshed Aurora token. This replaces the old Vercel `/api/internal/shared-sync/<board>` cron and the per-board `*_SYNC_TOKEN` env vars (`KILTER_SYNC_TOKEN`, `TENSION_SYNC_TOKEN`, `DECOY_SYNC_TOKEN`, `TOUCHSTONE_SYNC_TOKEN`, `GRASSHOPPER_SYNC_TOKEN`) — those env vars can be removed from the Vercel project settings.

| Aurora Table               | Local Table                        |
| -------------------------- | ---------------------------------- |
| products                   | board_products                     |
| sets                       | board_sets                         |
| product_sizes              | board_product_sizes                |
| holes                      | board_holes                        |
| layouts                    | board_layouts                      |
| placement_roles            | board_placement_roles              |
| leds                       | board_leds                         |
| placements                 | board_placements                   |
| product_sizes_layouts_sets | board_product_sizes_layouts_sets   |
| climbs                     | board_climbs (+ board_climb_holds) |
| climb_stats                | board_climb_stats (+ history)      |
| beta_links                 | board_beta_links                   |
| attempts                   | board_attempts                     |
| kits                       | board_kits                         |

When the climbs upsert sees previously-unseen UUIDs, the daemon also writes `new_climbs_synced` rows into the `notifications` table for each follower of the climb's setter (`setter_follows` and any linked `user_follows` accounts).

The board-wide pull is gated by a synthetic cursor in `board_shared_syncs`.
PostgreSQL writes the UTC marker and a fresh UUID atomically; each claim returns
that complete value as its ownership token, and completion updates use it as a
compare-and-set fence. Client clock skew and duplicate millisecond timestamps
cannot reuse an identity. If a stalled daemon finishes after another daemon has
reclaimed the board, the stale finisher cannot replace the newer marker.

The normal cooldown is one hour from the end of the run (configurable through
`sharedSyncCooldownMs`). Successful runs and permanent or unknown failures keep
that full cooldown. A canonical `AuroraRequestError` caused by a timeout,
network failure, rate limit, HTTP 429, or HTTP 500–599 retries after five minutes
or the configured full cooldown, whichever is shorter. Other 4xx responses,
invalid credentials, invalid responses, statusless HTTP failures, database
errors, and arbitrary throws keep the full cooldown. Location refresh failures
use the same classification because they are part of the board-wide run.

#### Public board locations

For non-Kilter Aurora boards, the shared sync also refreshes public gym/board locations through `GET /pins?gyms=1`. The location writer lives in `@boardsesh/location-sync`; it upserts a deterministic system-owned `gyms` row per source gym and one public, unowned `user_boards` row per board install. It does not delete gyms or boards that disappear upstream.

A human edit or deletion freezes that row by setting `sync_frozen_at`, so later source pulls cannot overwrite it. A global admin can release the freeze from `/admin/location-sync`; the action clears only the marker, requires a recorded reason, and writes `location_sync_unfreeze_audit`. It does not launch a sync. The next matching source pull may refresh or resurrect the row, while the separate gym-owner/approved-claim guard still prevents an upstream takeover of an owner-curated gym.

Run it directly with:

```bash
aurora-sync locations --board all
aurora-sync locations --board tension -v
```

The direct command supports the Aurora boards that still use Aurora's API for location pins: Tension, Decoy, So iLL, Touchstone, and Grasshopper. Kilter Grips locations are handled by `kilter-sync`, and MoonBoard locations are handled by `moonboard-sync`.

### `board_climb_stats`: multi-writer model

`ascensionist_count` is the materialized count derived from two owned columns,
each written by a single class of writer:

| Column                         | Owner                            | Updated by                                                                                                                                                                                                                                  |
| ------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upstream_ascensionist_count`  | The board's single upstream sync | Tension via the Aurora API sync (`upsertClimbStats`, this file's daemon); Kilter via the Kilter Grips catalog sync (`packages/kilter-sync`); MoonBoard via the app-catalog repeat count (`packages/db/scripts/import-moonboard-catalog.ts`) |
| `boardsesh_ascensionist_count` | Boardsesh `recomputeClimbStats`  | `packages/db/src/queries/climb-stats/recompute.ts` (shared by the backend resolver and the sync daemons) — distinct users with ≥1 flash/send tick at the key and **no upstream-represented tick** (`boardsesh_ticks.origin != 'native'`)    |
| `ascensionist_count`           | All writers, kept in lockstep    | recomputed as `COALESCE(upstream_ascensionist_count, 0) + COALESCE(boardsesh_ascensionist_count, 0)`                                                                                                                                        |

`upstream_ascensionist_count` is the board's single manufacturer/upstream count,
and every board has exactly one live upstream writer. The Aurora API sync takes
the incoming cursored value verbatim (Aurora only re-sends rows it changed, so
the value is current truth and legitimate decreases propagate; a NULL from
upstream preserves the stored count — "no data", not zero). The Kilter Grips
catalog sync still uses `GREATEST(existing, incoming)` between runs of its
`repair-stats` path, which overwrites it as an authoritative reconciliation to
the live Grips catalog (see kilter-sync.md). The Aurora API sync no longer
syncs the Kilter board (Kilter syncs only via Kilter Grips); it serves Tension
and the other direct-Aurora boards. Boardsesh ticks add on top of upstream. Migration 0141 folded the old
per-source `aurora_`/`kilter_` columns into this single `upstream_` column.

Provenance: `boardsesh_ticks.origin` (`native | aurora_pull | kilter_pull |
json_import`) records where a tick row was FIRST created — sync/import writers
stamp it at insert and never overwrite it on conflict. A user whose ticks at a
(climb, angle) were pulled/imported is already inside the upstream count and
contributes 0 to the Boardsesh term; a user with only native ticks counts, and
keeps counting after push-back (immediate-tally requirement). Every import
path (this daemon's user-sync, the web duplicate, kilter `applyLogs`,
json-import) bulk-recomputes affected keys after each batch. Upstream stats
writers also stamp `board_climb_stats.upstream_synced_at` on every upsert
(freshness watermark; the tick recompute never touches it).

The search hot path reads `ascensionist_count` through the covering index from
migration 0067, so it stays a regular column (not `GENERATED`) — every writer
must update it whenever they touch their own share.

`fa_username` / `fa_at` follow a related but asymmetric rule. Aurora's upsert
writes them verbatim (including `null`, which is how Aurora signals an FA
correction). `recomputeClimbStats` only re-derives FA for
Boardsesh-originated climbs (`board_climbs.user_id IS NOT NULL`); on non-owned
(manufacturer) climbs it NEVER derives FA from ticks — any existing value is
preserved verbatim, and boards whose upstream supplies no FA (MoonBoard)
correctly stay `NULL`. Boardsesh-created climbs aren't synced from Aurora, so
the two paths can't collide.

`quality_average` follows the same Boardsesh-owned rule: Aurora's upsert
clobbers it on every sync from the much larger Aurora ascent population, so
`recomputeClimbStats` writes it only for Boardsesh-originated climbs (where
Aurora never syncs) and blends it everywhere else.

`difficulty_average` and `display_difficulty` follow a wider rule since #4798,
and `tick_graded_at` is the marker that makes it safe. The marker means **"the
`display_difficulty` stored on this row was written from Boardsesh ticks"**.
`recomputeClimbStats` writes the grade when the climb is Boardsesh-originated,
**or** when the row's grade is ours to write: the board is not MoonBoard **and**
either `display_difficulty IS NULL` (nothing to protect) or `tick_graded_at IS
NOT NULL`. It stamps `tick_graded_at = now() AT TIME ZONE 'UTC'` on every such
write and clears it when the last graded tick disappears. A graded row with
`tick_graded_at IS NULL` is always upstream's — prod carries 134k unstamped
graded Tension rows, so "no `upstream_synced_at`" cannot be read as "ours".

**Marker presence, never a timestamp comparison.** The rule is a partnership:
_an upstream writer that supplies a grade clears `tick_graded_at`; one that
supplies none leaves both the grade and the marker._ Asking instead whether
`tick_graded_at` was newer than `upstream_synced_at` looked equivalent and was
not — kilter-sync COALESCEs the grade but stamps `upstream_synced_at` on **every**
pass, so the first pass that shipped no grade left our grade in place with a
newer stamp, and that row could never again be updated by a tick or cleared by a
delete. `upstream_synced_at` records when upstream last touched the row, which is
a different question from who wrote the grade.

The explicit UTC on the stamp is a write convention, not part of the comparison:
`tick_graded_at` is a zoneless `timestamp` sitting beside `upstream_synced_at`,
which every upstream writer fills with a JS ISO string, so a bare `now()` would
store session-local wall time in a column everything else reads as UTC.

MoonBoard is fenced out of both non-owned legs. Ungraded MoonBoard catalog rows
are legitimate, and `packages/db/scripts/moonboard-grade-repair.ts` and
`repair-moonboard-8c-grades.ts` fill them from the Moon catalog under a
`display_difficulty IS NULL` guard; a tick-derived grade would make both skip the
row permanently and would flip `statsRowCarriesRealCatalogData` (the predicate
the #3529 wrong-angle fix rests on) TRUE on a row holding no catalog data. Owned
MoonBoard climbs still derive.

Each upstream writer sets the marker in the same statement that writes the grade:

| Writer                                                                | Grade on conflict                       | `tick_graded_at` on conflict                                       |
| --------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| Aurora shared-sync (`packages/aurora-sync/src/sync/shared-sync.ts`)   | `excluded.display_difficulty`, verbatim | `NULL` — Aurora owns the row's grade now                            |
| kilter-sync catalog-sync + stats-repair (`kilterStatsGradeConflictSet`) | `COALESCE(excluded, existing)`          | `CASE WHEN excluded.display_difficulty IS NULL THEN existing ELSE NULL END` |
| Woods importer (`packages/db/scripts/import-woods-catalog.ts`)         | `COALESCE(excluded, existing)`          | same `CASE` as kilter-sync                                          |
| `import-aurora-board-unified.ts` (decoy, touchstone, grasshopper, So iLL) | clears the table, re-inserts         | n/a — a fresh row carries no marker                                 |
| MoonBoard importers + grade-repair scripts                            | catalog values                          | n/a — MoonBoard is fenced out of the derive rule entirely           |

`import-aurora-board-unified.ts` also gained an `upstream_synced_at` stamp it
never had; unrelated to the marker rule, but it was the one upstream writer whose
rows carried no freshness watermark at all.

Aurora clearing the marker unconditionally is deliberate, and covers the one
accepted edge: its upsert writes `display_difficulty = excluded.display_difficulty`
including `NULL`, which is Aurora saying "no grade here". That wipes a grade we
derived — and clears the marker with it, so the row reads plainly ungraded and
the next recompute re-derives it. There is never a state where the grade is gone
but the marker claims otherwise.

**Adding a writer that sets `display_difficulty`?** Two lines, not one. Stamp
`upstream_synced_at` (insert *and* conflict), and set `tick_graded_at` on
conflict to match how you treat the grade — `NULL` if you replace it
unconditionally, the mirroring `CASE` if you COALESCE it. Nothing else in the
system will notice if you forget; the symptom is a Boardsesh tick silently
overwriting your grade, or your grade freezing where no tick can reach it.

Aurora accepts a valid `display_difficulty` independently and
otherwise falls back to `difficulty_average`; the Boardsesh writer uses the
same guarded tick average for both columns.

Every Aurora difficulty field (average, display, and benchmark) is accepted
only when it is finite and greater than 1; an invalid or missing display value
falls back to a valid average. New zero-ascent stats payloads with no valid
difficulty, quality, or first-ascent data are skipped. The same empty payload
for an existing key is still applied authoritatively, clearing upstream-owned
fields without deleting the row or changing Boardsesh counts and quality votes.
Only a non-negative safe-integer `ascensionist_count` is authoritative; an
explicit numeric zero clears the stored upstream count, while an omitted, null,
negative, fractional, non-finite, or wrong-type value is preserved as `NULL` so
an existing count and its quality-blend weight survive the conflict update. The
new-row emptiness check alone treats that `NULL` as zero: a fully empty new row
is skipped, while a new row with other meaningful stats is inserted with a null
upstream count.

Tick-driven recomputation seeds a new stats row only when the climb exists and
the exact key has a non-detached flash/send tick. Tick existence gates INSERT
only: existing rows are always recomputed, so deleting or detaching the last
send clears Boardsesh-owned aggregates while retaining upstream data. Owned
climb averages accept difficulty values greater than 1 and quality values from
1 through 5; the latest-native quality-vote path uses the same 1–5 bounds.

Aurora reports `quality_average` on a 1–3 scale, but Kilter Grips / MoonBoard
use 1–5. Aurora's upsert normalises to 1–5 (`normalizeQualityTo5`, affine
`2q−1` — the same map as the per-tick `convertQuality`) so
`board_climb_stats.quality_average` is one scale across every board. The
one-time re-backfill of previously `×5/3`-scaled rows ships with the
star-scale repair (migration 0149; see kilter-sync.md).

The two providers deliberately handle sub-one positive noise differently:
Aurora clamps a value in `(0, 1)` to its valid one-star floor before converting
the 1–3 scale, while Kilter rejects it because Kilter's input is already on the
1–5 scale. Zero, negative, and non-finite values remain unrated on both paths.

Migration 0151 repaired only Aurora `difficulty_average = 0`; it did not cover
the `= 1` sentinel or `display_difficulty` / `benchmark_difficulty` sentinels.
Cursored shared syncs now overwrite those values with guarded fields as each row
returns, so the remaining production tail self-heals without a broad cleanup
write. Operators can quantify that lag with a read-only grouped count over those
three predicates before deciding whether a separate cleanup migration is worth
the write risk.

If you add a new writer to `board_climb_stats`, decide which side it owns and
recompute `ascensionist_count` in the same statement that updates that side.

## CLI Usage

### Installation

The CLI is available via the `@boardsesh/aurora-sync` package:

```bash
# From repo root
vp exec tsx packages/aurora-sync/src/cli/index.ts <command>

# Or from packages/backend, immediately after vp install (no build needed)
vp exec aurora-sync <command>
```

### Commands

```bash
# Sync all users with active credentials
aurora-sync all
aurora-sync all -v  # Verbose output

# Run the one-user daemon with Sydney quiet hours
aurora-sync daemon
aurora-sync daemon -v  # Verbose output

# Sync specific user
aurora-sync user <nextauth-user-id> -b kilter
aurora-sync user <nextauth-user-id> -b tension -v

# List stored credentials
aurora-sync list

# Refresh public gym and board locations from Aurora pins
aurora-sync locations --board all
aurora-sync locations --board tension -v
```

### Environment Variables

```bash
DATABASE_URL="postgresql://..."
AURORA_CREDENTIALS_SECRET="<encryption key>"
```

### Using 1Password CLI

`.env.1password` is already tracked for both sync packages
(`packages/aurora-sync/`, `packages/kilter-sync/`) — it holds `op://` references
only, never a secret:

```
DATABASE_URL="op://Boardsesh/DATABASE_URL/notesPlain"
AURORA_CREDENTIALS_SECRET="op://Boardsesh/Encryption key/password"
```

The `DATABASE_URL` item is the one the homelab sync daemons read
(`roles/boardsesh_sync/` in blackheathdc-ansible), so both paths point at the
same production connection string. The older `Postgres PROD` item is a Neon-era
leftover — it still resolves, but authenticates as the retired `default` role
and fails against Railway with `password authentication failed for user
'default'`.

Run with:

```bash
op run --env-file=packages/aurora-sync/.env.1password -- vp exec aurora-sync all -v
op run --env-file=packages/aurora-sync/.env.1password -- vp exec aurora-sync daemon -v
```

### Daemon Mode

- `aurora-sync daemon` runs forever and syncs exactly one user per cycle.
- The daemon picks the user with the oldest `lastSyncAt`, with `NULL` values first.
- Between cycles it waits a random `1` to `15` minutes.
- It does not sync between `10:00 PM` and `7:00 AM` in `Australia/Sydney`, but the process stays alive and checks again every minute.
- Aurora HTTP, timeout, network, and rate-limit failures are treated as transient and retried later without marking the credential as errored.

## Deployment (daemon CLI on a VM)

Run `aurora-sync daemon` as a long-lived process (systemd unit, a small VM, or a
Railway/Fly worker). It loops internally — there is no HTTP endpoint and no
`CRON_SECRET`; nothing fronts it. The per-board shared-sync cooldown lives in
Postgres and remains effective across daemon restarts and overlapping deploys.

### 1. Environment Variables

| Variable                    | Description                                          |
| --------------------------- | ---------------------------------------------------- |
| `DATABASE_URL`              | Postgres connection string                           |
| `AURORA_CREDENTIALS_SECRET` | Same key as the web app (for decrypting credentials) |

### 2. Run it

```bash
op run --env-file=packages/aurora-sync/.env.1password -- vp exec aurora-sync daemon
```

### 3. Monitoring

Check the process logs for sync output:

```
[Sync] Starting sync cron job...
[SyncRunner] Found 3 users with Aurora credentials to sync
[SyncRunner] ✓ Successfully synced user xxx for kilter
[SyncRunner] ✓ Successfully synced user xxx for tension
[Sync] Completed: 3/3 users synced successfully
```

## Performance Optimizations

### Batched Inserts

Instead of inserting rows one-by-one, we batch 100 rows per INSERT:

```sql
INSERT INTO kilter_ascents (uuid, climb_uuid, ...)
VALUES (...), (...), (...)
ON CONFLICT (uuid) DO UPDATE SET ...
```

### Fresh Pool Per Sync

Neon's serverless WebSocket connections can timeout on long operations. We create a fresh connection pool for each user sync and close it immediately after:

```typescript
const pool = createFreshPool();
try {
  await syncUserData(pool, ...);
} finally {
  await pool.end();
}
```

### HTTP Driver for Simple Queries

For simple SELECT/UPDATE queries that don't need transactions, we use Neon's HTTP driver which is more reliable:

```typescript
const db = createHttpDb();
await db.select().from(auroraCredentials)...
```

## Troubleshooting

### Connection Timeout Errors

```
Error: Connection terminated unexpectedly
```

- Usually caused by stale WebSocket connections
- The fresh pool pattern should prevent this
- If persists, check Neon dashboard for connection limits

### Decryption Errors

```
Failed to decrypt credentials
```

- Verify `AURORA_CREDENTIALS_SECRET` matches the key used to encrypt
- Check that the secret hasn't been rotated

### No Data Synced

- Check `aurora-sync list` to verify credentials exist
- Verify user has `syncStatus: active` or `error` (not `disabled`)
- Check Aurora API is accessible from the environment

### Skipped logbook rows (`logbook_sync_skips`)

Some upstream ascents/bids can't be written at all — a non-numeric `angle`, a
comment carrying a NUL byte, or anything else Postgres refuses. Rather than let
one of those abort the whole cross-table sync transaction and freeze the user's
logbook forever (#3871, the DB-execution-time sibling of #3520), the sync skips
the offending row and records it in `logbook_sync_skips` with its payload
intact, so the send is quarantined and replayable rather than silently dropped.

The table is **state, not a log**: a row is deleted the moment that `aurora_id`
syncs cleanly, so anything still in it is currently broken.

Who is affected, and why:

```sql
SELECT reason,
       count(*)                AS rows_skipped,
       count(DISTINCT user_id) AS users_affected,
       max(last_seen_at)       AS last_hit
  FROM logbook_sync_skips
 GROUP BY reason
 ORDER BY rows_skipped DESC;
```

Drill into one user (the payload is what you replay from):

```sql
SELECT aurora_type, aurora_id, reason, detail, seen_count, first_seen_at, payload
  FROM logbook_sync_skips
 WHERE user_id = '<user-id>' AND board_type = 'kilter'
 ORDER BY last_seen_at DESC;
```

Reason codes:

| `reason`            | What happened                                                              | Recovery                                                                       |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `invalid_angle`     | `angle` isn't a storable integer. No honest default, so the row is dropped | Fix upstream (the row re-syncs on its next upstream edit), or replay `payload` |
| `invalid_identity`  | `climb_uuid` / `aurora_id` missing or carrying an unstorable byte          | Usually an upstream data bug; replay from `payload` once corrected             |
| `normalize_failed`  | The row threw during parsing (bad `climbed_at`/`created_at`) — see #3520   | Same as above                                                                  |
| `db_write_rejected` | Parsed and validated, but Postgres still refused it                        | Read `detail` for the Postgres error; usually needs a code fix                 |

A skipped row is **not** re-fetched automatically: Aurora's user sync is
incremental and the checkpoint advances past it (not advancing is the wedge this
fixes). It comes back when the user edits it upstream, when the watermark is
reset (`clearAuroraBoardData` drops `board_user_syncs`, so the next sync starts
from 1970), or via the JSON export import below, which ignores the watermark.

A rising `seen_count` on the same row means it keeps being re-delivered and
re-refused — worth a look at `detail`.

## JSON Export Import (Alternative to API Sync)

Since the Kilter backend has been shut down, API-based sync is no longer available for Kilter users. As an alternative, users can import their data from Aurora's JSON export file.

### How It Works

1. User downloads their data export from Aurora (a `.json` file)
2. In the Boardsesh app, open Connected apps and click **Import JSON** on the
   relevant board card (on the web, the same card appears on `/aurora-migration`
   and on a profile page for a board with no data yet)
3. Select the export file — a preview shows the number of ascents, attempts, and circuits
4. Confirm — the server resolves climb names to UUIDs, maps grades, and imports the data

### Technical Details

- **Backend endpoint**: `POST /api/aurora-import` streams progress events for web and mobile
- **Implementation**: `packages/aurora-sync/src/sync/json-import.ts`
- **Preview parser**: `packages/shared-schema/src/aurora-import.ts`
- **Web UI**: `packages/web/app/components/board-entity/board-credential-card.tsx`,
  rendered by `board-import-prompt.tsx` on `/aurora-migration` and `/profile/{id}`.
  Web has no board-accounts settings section any more (W-21, #4440) — full
  credential management is mobile-only.
- **Mobile UI**: `packages/mobile/src/components/integrations/BoardAccountsSection.tsx`

Web and mobile credential management use backend REST endpoints instead of
Backend REST routes: `GET/POST/DELETE /api/aurora-credentials` for
credential state, `GET /api/aurora-credentials/unsynced` for pending local
changes, and the `/api/board-credentials/kilter/handoff` +
`/board-credentials/kilter/{start,callback}` OAuth handoff followed by
`POST /api/board-credentials/kilter/finalize` for Kilter.

### Key Differences from API Sync

|                  | API Sync                     | JSON Import                               |
| ---------------- | ---------------------------- | ----------------------------------------- |
| Data identifiers | Aurora UUIDs                 | Climb names (resolved to UUIDs)           |
| Grade format     | Numeric difficulty IDs       | Font grade strings ("6c")                 |
| Quality/stars    | 0-3 scale (internal)         | 1-5 scale (user-facing)                   |
| Dedup key        | Aurora UUID (`auroraId`)     | Deterministic hash (`json-import-{hash}`) |
| Trigger          | Automatic (cron every 15min) | Manual (user uploads file)                |

### Deduplication

- **Same file re-imported**: Deterministic `auroraId` based on `sha256(climbUuid:angle:climbedAt:type)` ensures `onConflictDoUpdate` handles idempotency.
- **Cross-source (API + JSON)**: Before inserting, existing ticks are fetched and matched by `(climbUuid, angle, climbedAt)` with normalized timestamps. Matching entries are skipped.

Both keys are frozen, and neither includes mirror (#3521). The synthetic `auroraId` is persisted on every imported tick, so changing its inputs rewrites ids that existing rows already carry — which breaks the upsert path that in-place corrections run through, and is a migration, not a refactor. Adding mirror to the cross-source key alone is worse: two records differing only by orientation would then both pass dedup while still hashing to the same `auroraId`, and Postgres rejects two such rows in one `ON CONFLICT DO UPDATE` batch (`21000`), failing the chunk. The trade-off is that a mirrored and a non-mirrored log of the same climb at the same second collapse to one row.

Because the dedup skips rather than upserts, a re-import can't correct an existing row through the insert path. Corrections are explicit `UPDATE`s scoped to the user's own `json_import` rows and matched on the natural key — `healMislabeledJsonImportAttempts` (#3301, send mislabeled as an attempt) and `healJsonImportMirrorFlags` (#3521, orientation dropped). Both are in-place and never delete.

### Climb Name Resolution

Climb names are resolved via `board_climbs` table using a composite index on `(board_type, name)`. When multiple climbs share the same name (rare), listed public climbs are preferred first, then the importing user's own climbs, then unlisted Aurora catalog climbs. Within the same tier, the climb with the highest `ascensionist_count` is chosen.

Exact non-draft Aurora catalog matches remain importable even if the climb has since been delisted in Boardsesh. This keeps historical logbook data importable without making the delisted climb appear in public search.

Some Aurora exports replace emoji with literal `?` characters in climb names. After exact matching, the importer tries a narrow fallback for still-unresolved names containing `?`: it gathers candidates with an escaped `ILIKE` pattern, strips emoji from DB names, strips question marks from export names, and only accepts normalized exact matches. This recovers names such as `Friend Forever?` → `Friend Forever👭` without broad fuzzy matching.

Unresolvable names (missing climbs, renamed climbs, typos) are returned to the user in the result dialog so they know which entries could not be imported.

## Migration from Vercel Cron

Complete — sync moved off the Vercel/backend cron to the `aurora-sync daemon` CLI.
The legacy `/api/internal/user-sync-cron` Vercel route and the `POST /sync-cron`
backend handler have been removed; the daemon on a VM is the sole sync path.

### Kilter sync rollout gate

While Kilter sync is in early access, the connect UI is gated client-side by the `kilter-oauth-linking` PostHog feature flag. The app's Connected apps screen only shows the Kilter sign-in card when the flag is on (or a Kilter account is already linked). Rolling the importer in or out is a PostHog toggle — no redeploy. The backend connect endpoints stay authenticated and rate-limited but no longer enforce a user allowlist.

## See also

- [`kilter-sync.md`](./kilter-sync.md) — Sibling package for the Kilter Grips integration. Same `aurora_credentials` table, same daemon shape, completely different wire (Keycloak OAuth + PowerSync NDJSON + REST).
