# Kilter Sync

This document describes how Kilter Grips data is synced from Kilter's Keycloak + PowerSync + REST backend to the Boardsesh database. It is the sibling of [`aurora-sync.md`](./aurora-sync.md); read that first if you want context on the Boardsesh sync model in general.

## Overview

The `@boardsesh/kilter-sync` package is a separate top-level package from `@boardsesh/aurora-sync` because Kilter Grips split from Aurora Climbing's backend and the two transports have nothing in common at the wire level:

|         | Aurora (Kilter pre-split, Tension)             | Kilter Grips                                  |
| ------- | ---------------------------------------------- | --------------------------------------------- |
| Auth    | Username/password login → opaque session token | Keycloak OAuth2 (PKCE) → access + refresh JWT |
| Pull    | REST `/sync` long-poll, `_complete` pagination | PowerSync `/sync/stream` NDJSON snapshot      |
| Push    | REST under same session                        | REST under Keycloak bearer (separate host)    |
| Catalog | Bundled into the same `/sync` response         | Separate PowerSync streams (`global*`)        |

Per-user pull and catalog ingest both work end-to-end against the live Kilter backend. Push-back is stubbed pending wire verification — see [Open wire questions](#open-wire-questions) below.

The package can run as:

1. **CLI** — `vp exec kilter-sync …` for local debugging and forced syncs
2. **Daemon CLI** — long-running `kilter-sync daemon` loop on a VM, one user per cycle, mirrors aurora-sync's daemon model

There is no Vercel cron path. The web app only hosts the OAuth handshake and the access-control gate.

## Architecture

Kilter exposes its product across three independent hosts. We hit all three on a normal sync cycle.

```
┌──────────────────────┐   refresh_token grant   ┌────────────────────────┐
│ idp.kiltergrips.com  │ ◀───────────────────── │  kilter-sync daemon    │
│ (Keycloak OIDC)      │ ────▶ access_token ──▶ │  (CLI on a VM)         │
└──────────────────────┘                         └────────────┬───────────┘
                                                              │
                                                              │  Bearer <access>
                          NDJSON snapshot                     ▼
┌──────────────────────┐ ◀───────────────────── ┌────────────────────────┐
│ sync1.kiltergrips    │                         │  syncKilterUserData    │
│ /sync/stream         │ ─────── ops ──────────▶│  (user_buckets +       │
│ (PowerSync)          │                         │   circuit_buckets)     │
└──────────────────────┘                         └────────────┬───────────┘
                                                              │  Drizzle writes
                                                              ▼
                                                  ┌─────────────────────┐
                                                  │  Postgres (Railway) │
                                                  │  boardsesh_ticks    │
                                                  │  board_climb_ratings│
                                                  │  playlists / …      │
                                                  └─────────────────────┘
                                                              ▲
                          push-back (stubbed today)           │
┌──────────────────────┐ ◀───────────────────────────────────┘
│ portal.kiltergrips   │
│ /api/logs/bulk       │
│ /api/climb-rating/   │
│ /api/circuits        │
└──────────────────────┘
```

### Three planes

- **`idp.kiltergrips.com` — Keycloak.** Standard OIDC, `kilter` client (public, PKCE today; `KILTER_OAUTH_CLIENT_SECRET` is optional and only set for confidential-client deployments). Token refresh handled by `packages/kilter-sync/src/api/keycloak.ts`. Keycloak rotates the refresh token on every refresh; the daemon persists the new one (encrypted) inside the same DB session as the rest of the cycle.
- **`sync1.kiltergrips.com/sync/stream` — PowerSync.** NDJSON wire (`application/x-ndjson`). One POST with subscriptions in the body, the server streams a snapshot of every subscribed bucket and ends with a `{"checkpoint_complete": …}` envelope. Implemented in [`packages/kilter-sync/src/api/powersync-client.ts`](../packages/kilter-sync/src/api/powersync-client.ts). The client aborts the fetch on `checkpoint_complete` — we deliberately don't follow live updates, only the snapshot.
- **`portal.kiltergrips.com/api/*` — REST.** Where push-back lives: `/api/logs/bulk`, `/api/climb-rating/`, `/api/circuits` (+ `/api/circuit-climbs`). Payload shapes still being verified live; push-back is gated behind `KILTER_SYNC_PUSH_ENABLED` and the unwired POST helpers call `pushNotWired()` (throws) rather than guessing a body shape.

All three hosts are overridable via `KILTER_IDP_HOST`, `KILTER_SYNC_HOST`, `KILTER_PORTAL_HOST` for sandbox use.

## PowerSync buckets (verified live)

PowerSync groups rows into named buckets. We subscribe with `include_defaults: false` and an explicit list, which avoids draining the full catalog when we only want per-user state.

| Bucket                            | Object types it carries                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `global`                          | `holds`, `hold_sets`, `difficulty_grades`, `grade_systems`, `placement_types`, `videos` |
| `global_gyms`                     | `gyms`, `walls`, `products`, `product_layouts`                                          |
| `global_climbs`                   | `climb_beta_links`, `hold_placements`, `mounting_holes`                                 |
| `user_buckets[<sub>]`             | `users`, `walls` (homewall), `logs`, `climb_ratings`, `gym_users`, `user_analytics`     |
| `circuit_buckets[<circuit_uuid>]` | `circuits`, `circuit_climbs`                                                            |

Notable absence: there is **no `climbs` table** in any PowerSync bucket. Climb metadata is fetched over REST (`GET /api/climbs/all/{productLayoutUuid}`), not PowerSync — see [Catalog sync (Flow A)](#catalog-sync-flow-a). The per-user pull tolerates a not-yet-ingested catalog because `boardsesh_ticks.climb_uuid` references the Kilter UUID directly and the alias resolver falls back to the input UUID.

A normal per-user sync subscribes to **both** `user_buckets` and `circuit_buckets`. The user's circuits are listed by UUID inside `user_buckets`, but the circuit metadata + its climb list live in the circuit-scoped bucket — you need both or you ingest empty playlists.

## Per-user pull (Flow B)

Lives in [`packages/kilter-sync/src/sync/user-sync.ts`](../packages/kilter-sync/src/sync/user-sync.ts). Single PowerSync stream, ops buffered by `object_type`, then applied inside one Drizzle transaction.

### Object-type → local-table mapping

| PowerSync `object_type`                            | Local table                                               | Notes                                         |
| -------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------- |
| `logs`                                             | `boardsesh_ticks` (`kilter_id` = `log_uuid`)              | Includes attempts — see below                 |
| `climb_ratings`                                    | `board_climb_ratings` (`kilter_id` = `climb_rating_uuid`) | Conflict target is natural key, not surrogate |
| `circuits`                                         | `playlists` + `playlist_ownership`                        | `kilter_type = 'circuits'`                    |
| `circuit_climbs`                                   | `playlist_climbs`                                         | Full-replace per circuit                      |
| `users` / `walls` / `gym_users` / `user_analytics` | —                                                         | Skipped in v1; no downstream consumer yet     |

### Logs ≠ separate attempts

The original design assumed Kilter had a separate `attempts` table like Aurora. It doesn't. The `logs` table carries **both completed climbs and attempts**, distinguished by the `topped` and `flashed` flags:

| `topped` | `flashed` | Tick status |
| -------- | --------- | ----------- |
| 1        | 1         | `flash`     |
| 1        | 0         | `send`      |
| 0        | —         | `attempt`   |

A single `logs` row maps to either a flash/send tick or an attempt tick, with `kilter_type` set to `'logs'` or `'attempts'` accordingly. There is no separate per-attempt table to drain.

### Natural-key adoption (design §4.3)

Incoming `logs` PUT ops are first **deduped by `log_uuid`** (last-op-wins). PowerSync's oplog can carry more than one op for the same row within a single snapshot — an edited or re-logged climb shows up as several PUTs. The reference PowerSync client collapses these into a table keyed by id; our hand-rolled stream forwards every op, so the writer dedupes explicitly. Without this, two ops for the same `log_uuid` would both reach the bulk insert with the same `kilter_id` and violate the **global** `boardsesh_ticks_kilter_id_unique` index, aborting the whole flush.

After dedup, the writer does a **three-way match** rather than a straight upsert:

1. If a tick with the same `kilter_id` already exists, update it in place (PowerSync echoing the same `log_uuid` is normal — keep it idempotent). The lookup is **global**, not user-scoped: if the matching `kilter_id` belongs to a **different** Boardsesh user (the same Kilter account linked to two Boardsesh accounts), the row is skipped-and-logged — inserting it would collide on the global unique index and adopting it would stamp a globally-taken `kilter_id`.
2. Otherwise, look for a Boardsesh-originated tick matching the **natural key** `(user_id, board_type, climb_uuid, angle, climbed_at ± 60s)` whose `kilter_id IS NULL`. If found, **adopt**: fill in `kilter_id` on the existing row instead of inserting a duplicate. This is the path where a tick the user logged in Boardsesh now comes back from Kilter after a board sync. The match is **status-aware** in one direction: an incoming `attempt` will not adopt (and thereby downgrade) an existing `send`/`flash` — the natural key ignores status, so the attempt is left to insert as its own tick. Upgrades (incoming `send`/`flash` onto an existing `attempt`) and same-status re-syncs still adopt.
3. If the natural-key match exists but has a **different** `kilter_id`, log a `divergent kilter_id` warning and skip the row. Almost always a server-side merge we didn't see; design says don't silently overwrite.
4. If nothing matches, insert a fresh row.

The reason this isn't a plain `onConflictDoUpdate(target: kilterId)` is that PostgreSQL treats `NULL`s as distinct, so the `kilter_id IS NULL` case would never collide and we'd produce duplicates on the natural key. The three-way match has to be explicit.

`REMOVE` ops **soft-detach** the matching row keyed on `(user_id, kilter_id)`: `kilter_id`, `kilter_type`, `kilter_synced_at`, and `kilter_sync_error` all get nulled, but the tick itself stays. PowerSync re-delivers full snapshots on reconnect or schema migration as `REMOVE` before `PUT` for every row — a hard delete here would wipe Boardsesh-side state (status promoted attempt→send, party-session links, computed fields) milliseconds before the row is re-inserted via the natural-key adoption path. The kilter*id gets re-stamped on the subsequent PUT. For a \_real* Kilter-side delete the row stays detached and visible in Boardsesh, which is the safer default until we have a separate "user explicitly deleted on Kilter" signal we can trust.

### Why `board_climb_ratings` is its own table

Kilter exposes ratings as a first-class resource at `POST /api/climb-rating/` — separate from logs, with their own UUID (`climb_rating_uuid`). We need a stable home for both pulled and pushed rows, with surrogate keys (`kilter_id` and `aurora_id`) that are **partial-unique on NOT NULL** so a Boardsesh-originated rating can later be adopted by either backend without colliding with other not-yet-synced rows.

The conflict target on insert is the natural key `(board_type, climb_uuid, angle, user_id)`, not `kilter_id` — same reasoning as the ticks path. Kilter's per-rating payload doesn't carry `weight`, so kilter-origin rows leave that column NULL.

Two timestamp invariants are easy to break by accident (issue #3524). **`created_at` comes from the upstream rating date** (`raw.created_at`, parsed by `parseKilterTimestamp`), not from the column default — without it every historical rating collapses onto the day our sync first saw it. It is deliberately absent from the `DO UPDATE` SET, so a Boardsesh-originated rating that a later sync adopts keeps its own original date rather than being re-stamped with Kilter's. **The `DO UPDATE` is change-guarded** by a row-wise `IS DISTINCT FROM` over `(rating, difficulty_grade_id, comment, kilter_id)`, comparing the existing row against the _effective_ new value (`COALESCE(EXCLUDED.…, existing)` for the COALESCE'd columns, not bare `EXCLUDED`). PowerSync redelivers a full snapshot every cycle, so without the guard the update fires for every rating on every run and `updated_at` degrades into "when the sync last ran".

### Circuits → playlists

Circuit rows land in `playlists` (`kilter_id` = `circuit_uuid`, `kilter_type = 'circuits'`) via a **three-way match**, the same shape the logs path uses and for the same reason — a plain `ON CONFLICT (kilter_id)` can't see a row whose `kilter_id` is still NULL:

1. If a playlist with the same `kilter_id` already exists, upsert it in place. The lookup is **global**, not user-scoped: a `kilter_id` belonging to a **different** Boardsesh user (one Kilter account linked to two Boardsesh accounts) is skipped-and-logged rather than overwritten (#3526).
2. Otherwise, look for a **legacy Kilter playlist** this user solely owns that has no `kilter_id` yet, and **adopt** it — stamp the surrogate keys onto the row that is already there instead of inserting a twin. Candidates must already carry an upstream origin (`aurora_id IS NOT NULL`), which is what keeps a playlist the user built by hand in Boardsesh from being swallowed by a same-named Kilter circuit. Two matching tiers, in order: `aurora_id = circuit_uuid` (Grips kept the uuid across the backend split), then the **normalized name** (`lower(btrim(name))`) when it appears exactly once among the candidates **and** exactly once among the incoming circuits. Anything ambiguous is left to insert — a wrong merge is worse than a duplicate.
3. If nothing matches, insert a fresh playlist.

Those legacy rows exist because Kilter used to be an ordinary Aurora board: aurora-sync wrote its circuits keyed on `aurora_id` until it was switched off for Kilter on 2026-03-30, and the mobile JSON import still writes the same shape with a synthetic `aurora_id = 'json-import-<hash>'`. No migration ever moved `aurora_id` → `kilter_id`, so before the adoption step every pre-split circuit got a second playlist row on the first sync after re-linking Kilter — carrying Kilter's stale content, stamped `created_at = now()`, sorted to the top of the list (#4707). Adoption rather than delete-and-reinsert is what preserves `playlists.uuid`, the offline-sync local PK that `user_playlist_pins`, `playlist_follows` and every mobile client already point at.

**Adoption is link-only.** It stamps `kilter_id` / `kilter_type` / `kilter_synced_at` and leaves `name`, `description`, `is_public`, `color` and `playlist_climbs` exactly as the user left them, because circuit push-back is still stubbed behind `KILTER_SYNC_PUSH_ENABLED` (#3525) — Boardsesh-side edits are the only copy that exists. `kilter_synced_at` is set to `COALESCE(aurora_synced_at, created_at)`, not `now()`: the column means "Kilter's content was last written into this row", and claiming a content sync that never happened would make the guard below read "no local edits" and clobber those edits on the very next cycle.

The upsert in (1) carries an **edit-clobber guard**, the twin of the ticks one: `DO UPDATE` only fires while `updated_at <= COALESCE(kilter_synced_at, updated_at)`. A playlist the user edited in Boardsesh since Kilter content last landed keeps both its metadata and its climbs — the guard suppresses the update, `.returning()` comes back empty and the diff-and-replace below is skipped with it. The tradeoff is deliberate: until push-back ships, an edited playlist is **frozen** against Kilter-side changes. A playlist the user has not edited syncs normally on the cycle after adoption.

When the guard lets it through, the climbs list is **full-replace per sync**: delete every `playlist_climbs` row for the playlist, re-insert from the snapshot, chunk inserts at 500 rows to stay under the 65535-parameter Postgres ceiling. Matches aurora-sync's circuit handling. Ownership is idempotent via `(playlist_id, user_id)` unique.

### Defensive sub-scoping

The Kilter server scopes the `user_buckets` and `circuit_buckets` streams by the bearer token's `sub` today, so subscribing with `parameters: {}` works. We still defensively decode `sub` from the access JWT and drop any `circuits` op whose `user_uuid` doesn't match — if the server-side sync rules ever loosen, we'd at worst ignore valid data rather than write someone else's. `circuit_climbs` carry no `user_uuid`; we trust the parent-circuit filter.

## Catalog sync (Flow A)

Implemented in [`packages/kilter-sync/src/sync/catalog-sync.ts`](../packages/kilter-sync/src/sync/catalog-sync.ts). The public climb catalog is **not** a PowerSync bucket — it's REST, paged by product layout. A cycle:

1. **Reference pull** (`sync/reference-pull.ts`) over PowerSync `global` + `global_gyms` → `products`, `product_layouts`, `holds`, `difficulty_grades`. The `product_layouts` list is the set of `productLayoutUuid`s to fetch; the others drive a reconcile/verify pass.
2. **Layout resolve** (`sync/layout-resolver.ts`): each Grips `productLayoutUuid` (a small int-string like `"27"`) → the integer `board_layouts.id`, by product name. Grips ships finer layout granularity than the legacy catalog, so many Grips layouts collapse onto one `board_layouts` row (six "Kilter Board Original" variants → `layout_id=1`). Resolutions persist to `board_layout_aliases`. Products with multiple board layouts (Tycho) or unknown to board\_\* ("UP Board") resolve to null → skipped and reported.
3. **Catalog REST pull**, grouped by resolved `board_layouts.id` so the existing catalog loads once per board layout: `GET /api/climbs/all/{productLayoutUuid}` (full per-layout array, no pagination) + `GET /api/climb-stat/all/{productLayoutUuid}`.
4. **Parse + remap** (`sync/catalog-parse.ts`): Grips `climb_concat` is `h{holeId}p{code}[s{start}][e{end}]`; the legacy catalog stores `frames` as `p{placementId}r{code}`. `board_placements(layout_id, hole_id) → id` (unique per layout) bridges the two, so `climb_concat` is rewritten to the canonical Aurora frames format and routed through the existing `convertLitUpHoldsStringToMap`. This guarantees byte-identical `board_climb_holds` / `hold_fingerprint` to the legacy data (verified 366/366 in Phase 0).
5. **Dedup** (see [Climb dedup](#climb-dedup)) — **UUID-first** (Grips inherited Aurora's climb UUIDs, so ~80% of climbs already exist as their own canonical), then hold-fingerprint for new UUIDs.
6. **Upsert** `board_climbs` (new canonicals only) + `board_climb_holds` + `board_climb_aliases`, then `board_climb_stats`, writing the Grips count into `upstream_ascensionist_count` (see below). Setter notifications fire for newly-inserted canonicals (`sync/notifications.ts`, ported from aurora-sync).
7. **Deletion reconciliation** (`sync/deletions.ts`) via `GET /api/climbs/delteduuids` — gated, report-only by default.

### Verified REST/PowerSync contract (Phase 0, 2026-06-02)

The endpoint paths read off the APK were partly wrong; verified live against a real account:

| Need      | Endpoint                                      | Notes                                                                                                                                 |
| --------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog   | `GET /api/climbs/all/{productLayoutUuid}`     | Full per-layout array, no pagination. The documented `climbdetails/{productName}/edges` 404s; `/climbs/all/` with no id returns `[]`. |
| Stats     | `GET /api/climb-stat/all/{productLayoutUuid}` | `{climbUuid, angle, ascentCount, currentDifficultyId, difficultyAverage, qualityAverage, faUsername, faAt}`                           |
| Deletions | `GET /api/climbs/delteduuids`                 | `string[]` (mixed casing)                                                                                                             |
| Reference | PowerSync `global` / `global_gyms`            | `product_layouts` carries `product_layout_uuid` + `product_name` + edges                                                              |

Wire JSON is **camelCase**. Across 19 listed layouts the catalog is ~424k climbs (all distinct; each climb has exactly one layout); ~80% already exist in `board_climbs` by UUID (case-insensitive).

### Cooldown + piggyback

The per-board cooldown is persisted in `board_shared_syncs` (default 1h via
`sharedSyncCooldownMs`) and claimed with a single-statement compare-and-set.
PostgreSQL writes each cursor timestamp with a fresh UUID and returns that
complete value to fence the completion update, so duplicate or skewed client
clocks cannot let a stalled finisher overwrite a newer daemon's claim. After a
successful per-user cycle, `runCycleForCredential` calls `maybeRunCatalogSync`
with that user's token; success and failure both keep the full cooldown from
the end of the catalog run, and a catalog failure never poisons the user's
credential.

### Prerequisite: fingerprint backfill

Dedup keys on `(board_type, layout_id, hold_fingerprint)`, but the legacy Kilter catalog landed before that column existed — every existing kilter climb has `hold_fingerprint IS NULL` until backfilled. Run once before catalog sync so Grips climbs dedupe against the existing catalog instead of duplicating it:

```bash
vp exec tsx packages/db/scripts/backfill-hold-fingerprints.ts --board kilter
```

Idempotent (re-running writes the same fingerprints; self-aliases use `ON CONFLICT DO UPDATE`).

### The `climb_concat` encoding

Every hold in a Grips `climb_concat` is one token:

```
h{holeId} p{roleCode} [s{startFrame}] [e{endFrame}]
```

`s`/`e` are **1-based and inclusive**, and are omitted when they equal their default (`s` → frame 1, `e` → the climb's last frame). A bare `h1180p12` on a 15-frame climb is therefore lit for all 15 frames. Animated (`frame_count > 1`) climbs are exactly the ones that carry `s`/`e`; single-frame climbs never do. The commas the Aurora `frames` format uses **never appear** in a `climb_concat`.

`catalog-parse.ts` translates a hold lit over frames `s..e` into a `p{placementId}r{code}` token on frame `s` and, when `e` isn't the final frame, an `x{placementId}` token on frame `e + 1` — the Aurora delta format. A placement cleared and re-lit on the same frame keeps only the `p` token. Multi-frame output sorts each frame's tokens by placement id (the Aurora catalog's own convention); single-frame output preserves the incoming order.

Verified against 100,513 live catalog rows across two product layouts (2026-07-25): every concat matches the grammar with no gaps, and no `s`/`e` index falls outside `1..frameCount`. Decoding every climb present in both catalogs and diffing against the legacy Aurora `frames` gives **141/141 semantic parity on multi-frame climbs** (78 of them byte-identical) over 86,054 climbs compared, with one divergence that is an upstream content edit rather than a decode fault. The captured samples backing the unit tests live in `packages/kilter-sync/src/sync/__fixtures__/grips-multiframe.json`, with their provenance recorded in the file.

#### Two kinds of frame (and why only 78 of those 141 are byte-identical)

An Aurora `frames` string mixes two frame kinds, and the leading `"` is what tells them apart:

- **Delta frame** — starts with `"`. Holds carry over from the previous frame; `p` adds or re-roles one, `x` turns one off. A frame that is _only_ a `"` is a legitimate **hold frame**: a delta with no changes, i.e. hold the lights for one more pace tick. 956 of these exist across 320 catalog climbs.
- **Absolute frame** — a later frame with no `"`. It restates the whole lit set from scratch, so every hold the previous frame lit goes dark unless this frame lights it again. 295 of the 709 multi-frame climbs carry at least one.

`catalog-parse.ts` emits `,"` unconditionally, so everything _we_ write is pure delta. That is why our decode is byte-identical only for the climbs the legacy catalog also wrote as pure delta, and semantically equal (not byte-equal) for the rest.

Reading every frame as a delta, and dropping the `"`-only ones, is issue **#3947** — it made 91 of those 141 animated Kilter climbs play back wrong. The reader that gets it right is `parseFramesSegments` / `accumulateFramesToMaps` in `@boardsesh/board-constants/hold-states`, pinned by a cross-encoding fixture at `packages/board-constants/src/__tests__/__fixtures__/aurora-frames-oracle.json` whose expected snapshots are decoded from Grips' `s`/`e` ranges rather than from our own reader.

### The skip backlog (`board_climb_ingest_skips`)

A climb the sync reads but cannot turn into a `board_climbs` row is recorded in `board_climb_ingest_skips` with its **verbatim** `climb_concat`, so an encoding change is visible instead of silent. Before this table existed such a climb was counted, logged once, and then missing from Boardsesh forever — including its stats, which get dropped along with it (issue #3523).

| `reason`             | Meaning                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `unplaceable_hole`   | A hole in the concat has no `board_placements` row on the resolved layout.  |
| `unparsable_concat`  | The token scan didn't consume the whole string — an encoding we don't know. |
| `frame_out_of_range` | An `s`/`e` index falls outside `1..frameCount`, or the range is inverted.   |

Rows are upserted on `(board_type, climb_uuid)`: re-skipping refreshes `last_seen_at` and re-opens the row, and a climb a later run manages to ingest gets `resolved_at` stamped. Nothing is ever deleted, so the table doubles as the record of what a parser fix recovered. `climbsUnmapped`, `skipsRecorded`, and `skipsResolved` all land in the per-run summary log.

Read it with:

```bash
vp exec kilter-sync backlog                                    # open skips, grouped by reason
vp exec kilter-sync backlog --reason unparsable_concat --raw   # with the raw payloads
vp exec kilter-sync backlog --include-resolved
```

A non-zero `unparsable_concat` count is the signal that Kilter changed the encoding — and the raw payloads needed to decode the new form are already sitting in the table.

### Remaining known gap

- **Post-2024 hold-set placements.** A handful of climbs use holds whose `board_placements` rows postdate the legacy snapshot (`board_shared_syncs` shows placements last synced 2024-06-22). The holds exist in `board_holes` but aren't placed on the layout, so the hole→placement remap fails and the climb lands in the backlog as `unplaceable_hole`. Refreshing `board_placements` (needs the `mounting_holes` PowerSync bucket) is a follow-up.

### Setter notifications and recovered climbs

A newly-inserted canonical notifies followers of its setter only when the upstream `createdAt` is recent (30 days). Any ingest that recovers a backlog — the multi-frame decoder picks up animated climbs first published as far back as 2021 — would otherwise present years-old climbs to followers as brand new.

## Public board locations

Kilter public locations come from the same PowerSync reference pull as the catalog. `global_gyms` carries `gyms`, `walls`, `products`, and `product_layouts`; `syncKilterLocations` maps each wall to a Boardsesh layout/size/set config and then delegates the actual `gyms` / `user_boards` upsert to `@boardsesh/location-sync`.

The location writer creates deterministic system-owned public rows:

- one `gyms` row per upstream gym UUID
- one public, unowned `user_boards` row per upstream wall
- stable UUIDs and slugs derived from the upstream source key

It never deletes rows that disappear upstream. Rows with missing layout mappings, unsupported product/size data, or invalid coordinates are reported as skipped.

A human edit or deletion freezes that row by setting `sync_frozen_at`, so later source pulls cannot overwrite it. A global admin can release the freeze from `/admin/location-sync`; the action clears only the marker, requires a recorded reason, and writes `location_sync_unfreeze_audit`. It does not launch a sync. The next successful catalog/location pull may refresh or resurrect the row, while the separate gym-owner/approved-claim guard still prevents an upstream takeover of an owner-curated gym.

The catalog sync refreshes locations after a successful catalog pull. You can also run the location-only path:

```bash
vp exec kilter-sync locations --user <nextauth-user-id>
```

For local testing without a linked credential, set `KILTER_TEST_USERNAME` and `KILTER_TEST_PASSWORD`; the CLI will use the password token flow.

The package `sync:locations` script passes `--skip-if-missing-credentials` so aggregate repo tasks can run in clean environments. Direct `kilter-sync locations` calls still require `--user` or test credentials unless that flag is passed explicitly.

## Climb dedup

Kilter's catalog has duplicate climbs at different UUIDs with identical hold layouts. We collapse them behind a canonical row.

**Fingerprint.** `sha256` of sorted `hold_id:hold_state:frame_number` tuples (`packages/kilter-sync/src/sync/fingerprint.ts`), stored on `board_climbs.hold_fingerprint`, indexed `(board_type, layout_id, hold_fingerprint)`.

**Resolution, per incoming climb:**

1. **UUID identity** — if the incoming UUID already exists in `board_climbs` (case-insensitive), it is its own canonical. (The dominant path: Grips inherited Aurora's UUIDs.)
2. **Fingerprint hit** — a new UUID whose `(layout_id, fingerprint)` matches an existing or already-seen-this-run canonical becomes an alias (`board_climb_aliases`), not a new row.
3. **Miss** — insert a new canonical row + a self-alias.

**Stats accumulation (worked example).** Two listed climbs `A` (count 18) and `B` (count 5) with identical holds collapse onto one canonical: `A` is canonical with `upstream_ascensionist_count = 18`, `B` aliases to `A` and its 5 ascents accumulate → 23. The accumulation is computed **in memory per `(canonical, angle)` and written as an overwrite** (not `+=`), so re-running recomputes the same 23 — idempotent. If the same source climb stat appears through multiple Grips `product_layout_uuid`s that collapse to one Boardsesh layout, it is counted once by `(source climb UUID, angle)`. Display fields (`difficulty/quality/fa`) come only from the canonical climb's own stat row.

### `ascensionist_count` — one upstream column plus Boardsesh

`board_climb_stats.ascensionist_count` is the materialized count the search hot path reads. It sums two owned columns: `upstream_ascensionist_count` — the board's single manufacturer/upstream count — and `boardsesh_ascensionist_count`, the independent Boardsesh-native contribution:

```
ascensionist_count = COALESCE(upstream_ascensionist_count, 0)
                   + COALESCE(boardsesh_ascensionist_count, 0)
```

The Kilter board's upstream count comes from the Grips catalog sync (`catalog-sync.ts`); Tension's from aurora-sync (`shared-sync.ts`); MoonBoard's from the app-catalog import. The same formula runs at every writer, including the Boardsesh-tick recompute (`recompute-climb-stats.ts`). `boardsesh_ascensionist_count` stays additive because Boardsesh-native ticks aren't (yet) pushed upstream; revisit when push-back lands.

Historical note: there used to be two upstream columns — `aurora_` (from the pre-split `kilterboardapp.com`) and `kilter_` (from `kiltergrips.com`), holding the same logs Kilter migrated between the two backends — and the materialized total took `GREATEST(kilter_, aurora_)` to avoid double-counting the Kilter board. Migration `0141` folded them into the single `upstream_ascensionist_count` via `GREATEST(aurora_, kilter_)`. Neither snapshot dominated (in prod 90,262 Kilter rows had `kilter_ > aurora_`, 36,710 the other way), so the fold preserved every row's higher count.

### Stats repair

A single Boardsesh layout maps to several Grips `product_layout_uuid`s (size variants). Before the `(source climb UUID, angle)` dedup landed, the catalog sync folded each repeated source stat once per variant, so `upstream_ascensionist_count` (and thus `ascensionist_count`) was inflated by the number of variants a climb appeared in. The fix prevents new inflation; existing rows need a one-time `repair-stats` pass (`stats-repair.ts`).

`repair-stats` re-fetches every listed Grips layout, dedupes stats the same way the live sync now does, and **overwrites** `upstream_ascensionist_count` from the deduped value (also re-asserting Grips `display_difficulty / difficulty_average / quality_average` on canonical rows). Unlike the live catalog sync — which writes `upstream_ascensionist_count = GREATEST(existing, incoming)` so a stale or partial snapshot can never lower a climb — `repair-stats` is authoritative and may correct a count downward. It is idempotent — re-running converges and the second run is a no-op.

- **Dry-run is the default and is read-only.** It reports `changedKilterRows`, `maxKilterDrop` / `maxKilterRise` (largest per-row decrease/increase), `statsDeduped`, `statsUnresolved`, and a `topBefore` list. Review these before applying — a large `maxKilterDrop` can also signal a partial Grips fetch (delisted climbs, rate-limit truncation), so treat it as a stop-and-investigate signal rather than blindly applying.
- **`--apply` writes inside a single transaction** (overwrite + materialized-total recompute are atomic) and prints `topAfter`. A fetch error aborts before any write, since writes only run after the full fetch loop completes.
- Run it with the **daemon paused** so a concurrent catalog sync doesn't interleave, and run it **unscoped** (no `--layouts`) for the production cleanup — the materialized-total recompute pass touches all Kilter rows, so a scoped run can leave inconsistent state. Rows for climbs Grips no longer lists aren't re-fetched, so this tool does not correct delisted-climb inflation.

An applied repair that changes 500 or more rows is picked up by the live board-snapshot threshold scan and
republished to the fleet's gzip CDN prefix. Do not leave devices to replay a bulk repair through hundreds of
GraphQL pages. The scan runs on a best-effort 15-minute cadence; for a planned repair that should not wait
for the next scheduled scan, manually dispatch **Export Board Snapshots** after the transaction commits with
`gzip_only`, `board=kilter`, and the affected layout when it is known.

### Quality scale — every board on 1–5

Kilter Grips reports `quality_average` on a 1–5 scale (MoonBoard too), but Aurora reports 1–3. To keep `board_climb_stats.quality_average` one scale the UI renders uniformly, every writer stores 1–5: aurora-sync normalises its writes via `normalizeQualityTo5` (`×5/3`, continuous — it's a stored average, so unlike `convertQuality` it isn't rounded to integer star steps); Kilter Grips and Boardsesh-tick quality are already 1–5 and stored as-is.

Existing rows synced **before** that change are still on 1–3 (this is why the app showed 1–3 stars). A new boolean **`board_climb_stats.quality_normalized`** tracks whether a row is on the canonical 1–5 scale; migration `0116_backfill_quality_scale_1to5` does the one-time conversion idempotently:

- Scales `×5/3` and sets `quality_normalized = true` for Aurora-sourced 1–3 rows on the Aurora-scale boards (`kilter, tension, decoy, soill, touchstone, grasshopper`), **excluding** Kilter Grips-touched rows (`upstream_ascensionist_count > 0`, the proxy for a Grips-written count) and Boardsesh-owned climbs (both already 1–5).
- Marks every remaining row `quality_normalized = true` without changing it (MoonBoard, Grips-native, Boardsesh-owned, null quality).

Every write path (`aurora-sync` upsert, kilter `catalog-sync`, the tick `recompute`) sets `quality_normalized`, so rows touched after the migration are never re-scaled, and re-running the migration is a no-op. (Transitional column — drop it in follow-up work once the whole table is normalized.)

> **Already ran the old manual `×5/3` SQL?** Earlier revisions documented a manual one-time `UPDATE … * 5.0/3.0` for the non-kilter boards. If an environment ran it, mark those rows normalized **before** applying `0116` so they aren't scaled twice:
>
> ```sql
> UPDATE board_climb_stats SET quality_normalized = true
> WHERE board_type IN ('tension','decoy','soill','touchstone','grasshopper') AND quality_average IS NOT NULL;
> ```
>
> Fresh environments (never manually backfilled) need nothing — `0116` handles them.

> **Deploy order matters.** `normalizeQualityTo5` (aurora-sync write path) and the `quality_normalized` flag must ship **together** — they do, on this branch. The hazard: an aurora-sync build that normalises quality on write but predates the `quality_normalized` column would write 1–5 values flagged `false`, which `0116` would then scale **again** (a 1–5 average ≤ 3 still passes the `≤ 3.0` guard). So: **apply migrations `0115`+`0116` before the new aurora-sync daemon runs**, and never run a normalize-on-write build standalone against a DB that hasn't had `0116`. Production is safe today — the kilter-sync branch isn't deployed, so no normalize-on-write has run; prod `quality_average` is uniformly raw 1–3 (verified). If you ever suspect an environment ran normalize-on-write before `0115`, treat its Aurora-board rows like the manual-SQL case above (mark normalized, then migrate).

## Schema changes

The catalog-relevant schema (`board_climbs.hold_fingerprint` + index, `board_climb_aliases`, `board_climb_stats.upstream_ascensionist_count` + the multi-writer recompute) already shipped with Flow B. Flow A adds:

| Change | Object                                                                                                      | Notes                                                                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| new    | `board_layout_aliases (board_type, layout_uuid PK, layout_id FK→board_layouts, source, first/last_seen_at)` | Persists the Grips `product_layout_uuid` → integer `layout_id` mapping; reused by the per-user paths.                                           |
| new    | `board_climb_stats.quality_normalized boolean NOT NULL DEFAULT false` (migration `0115`)                    | Tracks whether `quality_average` is on the canonical 1–5 scale; gates the one-time 1–3→1–5 backfill (`0116`). Transitional — drop in follow-up. |

## OAuth handshake

The backend owns the Kilter credential flow. Web and mobile both start with
`POST /api/board-credentials/kilter/handoff`, then send the user through the
browser-facing `/board-credentials/kilter/start` and
`/board-credentials/kilter/callback` routes. The callback returns only a
short-lived completion token; the app must finish linking with
`POST /api/board-credentials/kilter/finalize` using the signed-in user's bearer
JWT.

- `handoff` - creates a short-lived signed handoff for the authenticated Boardsesh user and records a one-time nonce.
- `start` - verifies the handoff, generates a PKCE verifier + state, sets HttpOnly cookies scoped to `/board-credentials/kilter`, and redirects to Keycloak's authorize endpoint with `scope=openid offline_access`.
- `callback` - validates state, exchanges the code for `{access_token, refresh_token, id_token}`, decodes the `sub` + `preferred_username` from the id_token (no signature verification - we just received it over TLS from Keycloak, and we never accept id_tokens via client redirects), encrypts the refresh token via `@boardsesh/crypto`, and redirects back with a signed completion token.
- `finalize` - requires the bearer JWT for the active Boardsesh session, verifies that the completion token belongs to the same user, consumes a one-time nonce, decrypts the refresh token, and upserts:
  - `aurora_credentials` (`board_type = 'kilter'`, `encrypted_refresh_token`, `username/password = NULL`).
  - `user_board_mappings` (`board_user_id_text = sub`, `board_user_id = NULL` - kilter sub is a UUID, not an integer).
- `DELETE /api/aurora-credentials` - revokes locally (clears the credential row + mapping).

The callback is **account-linking only**. It never creates a NextAuth session and
never saves credentials directly. If `offline_access` doesn't return a
`refresh_token`, the handshake fails closed with `reason=no-refresh-token` rather
than persisting an unrenewable credential.

### Access gate

Account linking is gated client-side by the `kilter-oauth-linking` PostHog feature flag. The app reads the flag (`useFeatureFlag('kilter-oauth-linking')`) and only shows the Kilter sign-in card when it's on (or when a Kilter account is already linked, so it stays manageable if the flag flips off). Toggling the flag in PostHog rolls the importer in or out without a redeploy. The backend OAuth/password endpoints stay authenticated and rate-limited but no longer enforce a user allowlist.

## Daemon

Same loop shape as aurora-sync's daemon: one user per cycle, random 1–15 min jitter between cycles, Sydney quiet hours (`10pm–7am`), transient errors (HTTP 5xx, network, timeout) leave `syncStatus` untouched for retry, while Keycloak `invalid_grant` is treated as permanent and routes to `syncStatus = 'expired'`.

**Two timestamps, two jobs:**

- `last_sync_at` — last **successful** sync. Stamped on success only. This is what users see as the credential card's "Last synced" time, so a failed cycle must never advance it (otherwise the card shows "connected, just synced" for a cycle that failed before applying data).
- `last_sync_attempt_at` — last **attempt**, success or failure. This is the scheduler's fairness clock: `getNextCredentialToSync` orders by `last_sync_attempt_at ASC NULLS FIRST` (served by `aurora_credentials_sync_attempt_priority_idx`).

The split exists because the error classifier fails open — a non-`KilterApiError` (a DB error, a bug) is treated transient. If the scheduler ordered by `last_sync_at` and we never advanced anything on failure, a credential that fails deterministically would keep its `NULL`/old timestamp and be re-selected first every cycle, monopolising the single-user-per-cycle queue and starving everyone else. Advancing `last_sync_attempt_at` on every outcome rotates a failing credential to the back while keeping `last_sync_at` honest; it still retries on its next turn. No data is lost: `last_sync_attempt_at` is a scheduling key, never a data cursor — each cycle re-pulls the full snapshot idempotently, so a failed cycle's rows land on the next successful turn.

Selection also **claims**: the pick runs `SELECT ... FOR UPDATE SKIP LOCKED` and stamps `last_sync_attempt_at` inside one short transaction, so two overlapping daemon instances take disjoint work. Part of that claim is a 30-second reclaim gap (`CREDENTIAL_MIN_RECLAIM_GAP_MS`) in the WHERE — a credential is not re-selectable inside that window. It reads like a throttle but isn't one: under READ COMMITTED the claim has to falsify a predicate, because a racer whose lock attempt lands just after the winner's commit gets an EvalPlanQual recheck of the WHERE quals and never of the ORDER BY. The daemon's shortest cycle is 1 minute, so the gap never binds in practice. Full reasoning: the header comment on `claimNextCredentialForSync` in `packages/db/src/queries/sync/claim-credential.ts`.

(aurora-sync still orders by `last_sync_at` and has the same latent starvation gap — adopting this attempt clock there is tracked in [#3331](https://github.com/boardsesh/boardsesh/issues/3331). The `last_sync_attempt_at` column and its index already cover aurora-sync's query shape; only its runner needs updating.)

The daemon loop primitives (`resolveDaemonOptions`, `runDaemonLoop`, quiet-hours math) live in the neutral `@boardsesh/sync-runtime` package; both aurora-sync and kilter-sync consume them. Only the per-cycle work differs.

It runs as a **long-lived CLI process on a VM** — `vp exec kilter-sync daemon` (see [CLI](#cli)) — not as a backend HTTP endpoint. The catalog piggyback's cooldown is persisted in Postgres, so restarts and overlapping deploys share the same per-board gate. The earlier `/kilter-sync-cron` backend handler (and the aurora `/sync-cron`) were removed in favour of this model, so the backend no longer depends on the sync packages. `CRON_SECRET` is no longer needed for kilter sync — the daemon authenticates to Kilter with the stored per-user refresh token, nothing fronts it.

## CLI

Run these commands from `packages/backend` after `vp install`. The checked-in
launcher loads the TypeScript CLI directly; no build is required.

```bash
vp exec kilter-sync list                # List all stored kilter credentials
vp exec kilter-sync user <userId>       # Force a sync for one user
vp exec kilter-sync daemon              # Run the daemon (one-user-per-cycle, quiet hours)
vp exec kilter-sync catalog --user <id> # Sync the public climb catalog (Flow A)
vp exec kilter-sync repair-stats --user <id>          # Dry-run: report deduped Kilter counts vs DB (no writes)
vp exec kilter-sync repair-stats --user <id> --apply  # Write the deduped counts + recompute totals
vp exec kilter-sync repair-stats --user <id> --layouts <uuid,uuid>  # Scope to specific Grips product_layout_uuids
vp exec kilter-sync locations --user <id> # Sync public Kilter gym/board locations
vp exec kilter-sync locations --skip-if-missing-credentials # No-op when no token source is configured
```

`repair-stats` is a one-time cleanup for the catalog-stats inflation (see [Stats repair](#stats-repair)). It defaults to a read-only dry-run; nothing is written without `--apply`.

Run with 1Password like aurora-sync:

```bash
op run --env-file=packages/kilter-sync/.env.1password -- vp exec kilter-sync daemon
```

## Environment variables

| Variable                     | Required           | Purpose                                                            |
| ---------------------------- | ------------------ | ------------------------------------------------------------------ |
| `KILTER_OAUTH_CLIENT_ID`     | yes (web + daemon) | Keycloak client ID. Today: `kilter`                                |
| `KILTER_OAUTH_CLIENT_SECRET` | no                 | Confidential-client secret. Leave unset for the public PKCE client |
| `KILTER_OAUTH_REDIRECT_URI`  | yes (web)          | Must match the redirect URI registered in Keycloak                 |
| `AURORA_CREDENTIALS_SECRET`  | yes                | Shared encryption key with aurora-sync — same key, same table      |
| `KILTER_IDP_HOST`            | no                 | Override Keycloak host (sandbox)                                   |
| `KILTER_SYNC_HOST`           | no                 | Override PowerSync host (sandbox)                                  |
| `KILTER_PORTAL_HOST`         | no                 | Override REST portal host (sandbox)                                |
| `DATABASE_URL`               | yes                | Same Postgres as everything else                                   |

## Open wire questions

These are the things still TODO. The kilter wire-spec documents that backed the original design were intentionally excluded from this repo for legal reasons, so verification has to happen against real traffic.

1. **REST push payload shapes.** `/api/logs/bulk`, `/api/climb-rating/`, `/api/circuits`, `/api/circuit-climbs` — endpoint paths confirmed, body shapes not. Push-back is gated behind `KILTER_SYNC_PUSH_ENABLED` and the POST helpers call `pushNotWired()` (throws) until captured.
2. **Attempts endpoint.** Whether attempts share `/api/logs/` with `topped=false`, or live on a separate REST endpoint. Pull side handles both as `logs` rows already; only push is blocked.
3. ~~**Climb-metadata source.**~~ **Resolved (2026-06-02).** The public catalog is REST, paged per product layout: `GET /api/climbs/all/{productLayoutUuid}` (+ `/api/climb-stat/all/{…}`, `/api/climbs/delteduuids`). See [Catalog sync (Flow A)](#catalog-sync-flow-a). The documented `climbdetails/{productName}/edges` endpoint does not exist.

When any of these get verified, replace the matching `pushNotWired()` call with the real POST and remove the item here.
