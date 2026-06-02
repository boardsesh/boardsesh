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

Per-user pull works end-to-end against the live Kilter backend. Catalog ingest and push-back are stubbed pending wire verification — see [Open wire questions](#open-wire-questions) below.

The package can run as:

1. **CLI** — `bunx kilter-sync …` for local debugging and forced syncs
2. **Backend daemon** — long-running loop on Railway, one user per cycle, mirrors aurora-sync's daemon model

There is no Vercel cron path. The web app only hosts the OAuth handshake and the access-control gate.

## Architecture

Kilter exposes its product across three independent hosts. We hit all three on a normal sync cycle.

```
┌──────────────────────┐   refresh_token grant   ┌────────────────────────┐
│ idp.kiltergrips.com  │ ◀───────────────────── │  Backend daemon        │
│ (Keycloak OIDC)      │ ────▶ access_token ──▶ │  /kilter-sync-cron     │
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

Notable absence: there is **no `climbs` table** in any PowerSync bucket. Climb metadata for the Kilter board comes from a different surface that's still being identified — see [Open wire questions](#open-wire-questions). The per-user pull works without it because `boardsesh_ticks.climb_uuid` references the Kilter UUID directly and the alias resolver falls back to the input UUID when the canonical catalog hasn't been ingested yet.

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

When a `logs` op arrives, the writer does a **three-way match** rather than a straight upsert:

1. If a tick with the same `kilter_id` already exists, update it in place (PowerSync echoing the same `log_uuid` is normal — keep it idempotent).
2. Otherwise, look for a Boardsesh-originated tick matching the **natural key** `(user_id, board_type, climb_uuid, angle, climbed_at ± 60s)` whose `kilter_id IS NULL`. If found, **adopt**: fill in `kilter_id` on the existing row instead of inserting a duplicate. This is the path where a tick the user logged in Boardsesh now comes back from Kilter after a board sync.
3. If the natural-key match exists but has a **different** `kilter_id`, log a `divergent kilter_id` warning and skip the row. Almost always a server-side merge we didn't see; design says don't silently overwrite.
4. If nothing matches, insert a fresh row.

The reason this isn't a plain `onConflictDoUpdate(target: kilterId)` is that PostgreSQL treats `NULL`s as distinct, so the `kilter_id IS NULL` case would never collide and we'd produce duplicates on the natural key. The three-way match has to be explicit.

`REMOVE` ops **soft-detach** the matching row keyed on `(user_id, kilter_id)`: `kilter_id`, `kilter_type`, `kilter_synced_at`, and `kilter_sync_error` all get nulled, but the tick itself stays. PowerSync re-delivers full snapshots on reconnect or schema migration as `REMOVE` before `PUT` for every row — a hard delete here would wipe Boardsesh-side state (status promoted attempt→send, party-session links, computed fields) milliseconds before the row is re-inserted via the natural-key adoption path. The kilter*id gets re-stamped on the subsequent PUT. For a \_real* Kilter-side delete the row stays detached and visible in Boardsesh, which is the safer default until we have a separate "user explicitly deleted on Kilter" signal we can trust.

### Why `board_climb_ratings` is its own table

Kilter exposes ratings as a first-class resource at `POST /api/climb-rating/` — separate from logs, with their own UUID (`climb_rating_uuid`). We need a stable home for both pulled and pushed rows, with surrogate keys (`kilter_id` and `aurora_id`) that are **partial-unique on NOT NULL** so a Boardsesh-originated rating can later be adopted by either backend without colliding with other not-yet-synced rows.

The conflict target on insert is the natural key `(board_type, climb_uuid, angle, user_id)`, not `kilter_id` — same reasoning as the ticks path. Kilter's per-rating payload doesn't carry `weight`, so kilter-origin rows leave that column NULL.

### Circuits → playlists

Circuit rows upsert into `playlists` (`kilter_id` = `circuit_uuid`, `kilter_type = 'circuits'`). The climbs list is **full-replace per sync**: delete every `playlist_climbs` row for the playlist, re-insert from the snapshot, chunk inserts at 500 rows to stay under the 65535-parameter Postgres ceiling. Matches aurora-sync's circuit handling. Ownership is idempotent via `(playlist_id, user_id)` unique.

### Defensive sub-scoping

The Kilter server scopes the `user_buckets` and `circuit_buckets` streams by the bearer token's `sub` today, so subscribing with `parameters: {}` works. We still defensively decode `sub` from the access JWT and drop any `circuits` op whose `user_uuid` doesn't match — if the server-side sync rules ever loosen, we'd at worst ignore valid data rather than write someone else's. `circuit_climbs` carry no `user_uuid`; we trust the parent-circuit filter.

## Catalog sync (Flow A) — stubbed

Catalog ingest is not wired in this PR — there's no `shared-sync.ts` yet. The PowerSync bucket layout is verified (see table above) but two things still need to land before catalog sync can be added:

1. The `climbs` source — not in PowerSync, location TBD.
2. The bucket-to-`board_*` mapping (Kilter's `hold_placements` + `mounting_holes` have replaced Aurora's flat `placements` table; the mapping isn't 1:1).

Per-user pull does not depend on catalog ingest, so the daemon runs without it. When catalog support lands, re-introduce the piggyback model from aurora-sync (`lastCatalogSyncAt`, cooldown getter, try/catch inside `runCycleForCredential`) — the runner has placeholder comments where it goes.

## OAuth handshake

The web app exposes three routes under `/api/internal/board-credentials/kilter/` (mirrors the `/api/internal/aurora-credentials/` layout — these are third-party board credential flows, not NextAuth providers, so they intentionally live outside `/api/auth/*`):

- `start` — generates a PKCE verifier + state, sets HttpOnly cookies scoped to `/api/internal/board-credentials/kilter`, redirects to Keycloak's authorize endpoint with `scope=openid offline_access`.
- `callback` — validates state, exchanges the code for `{access_token, refresh_token, id_token}`, decodes the `sub` + `preferred_username` from the id_token (no signature verification — we just received it over TLS from Keycloak, and we never accept id_tokens via client redirects), encrypts the refresh token via `@boardsesh/crypto`, and upserts:
  - `aurora_credentials` (`board_type = 'kilter'`, `encrypted_refresh_token`, `username/password = NULL`).
  - `user_board_mappings` (`board_user_id_text = sub`, `board_user_id = NULL` — kilter sub is a UUID, not an integer).
- `disconnect` — revokes locally (clears the credential row + mapping).

The callback is **account-linking only**. It never creates a NextAuth session — the user must already be signed in. If `offline_access` doesn't return a `refresh_token`, the handshake fails closed with `reason=no-refresh-token` rather than persisting an unrenewable credential.

### Access gate

Account linking is gated by `KILTER_SYNC_ALLOWED_USER_IDS` (comma-separated NextAuth user IDs) — see [`packages/web/app/lib/kilter-sync/access.ts`](../packages/web/app/lib/kilter-sync/access.ts). Empty/unset means the feature is off for everyone. Both `start` and `callback` enforce the gate, and the settings UI hides the Connect button when it returns false. The allowlist is parsed once at module load; flipping it requires a redeploy. PR 15 removes the gate.

## Daemon

Same loop shape as aurora-sync's daemon: one user per cycle, oldest `last_sync_at` first (`NULLS FIRST`), random 1–15 min jitter between cycles, Sydney quiet hours (`10pm–7am`), transient errors (HTTP 5xx, network, timeout, Keycloak `invalid_grant` is treated as permanent and routes to `syncStatus = 'expired'`).

The daemon loop primitives (`resolveDaemonOptions`, `runDaemonLoop`, quiet-hours math) live in the neutral `@boardsesh/sync-runtime` package; both aurora-sync and kilter-sync consume them. Only the per-cycle work differs.

Backend hosts it at:

```
POST /kilter-sync-cron
Authorization: Bearer <CRON_SECRET>
```

Same `CRON_SECRET` as `/sync-cron` (aurora-sync); the two endpoints are independent so a 500 on one doesn't take down the other. Implementation in `packages/backend/src/handlers/kilter-sync.ts`.

## CLI

```bash
bunx kilter-sync list                # List all stored kilter credentials
bunx kilter-sync user <userId>       # Force a sync for one user
bunx kilter-sync daemon              # Run the daemon (one-user-per-cycle, quiet hours)
bunx kilter-sync catalog             # Stubbed — not wired (no public method on the runner)
```

Run with 1Password like aurora-sync:

```bash
op run --env-file=packages/kilter-sync/.env.1password -- bunx kilter-sync daemon
```

## Environment variables

| Variable                       | Required           | Purpose                                                            |
| ------------------------------ | ------------------ | ------------------------------------------------------------------ |
| `KILTER_OAUTH_CLIENT_ID`       | yes (web + daemon) | Keycloak client ID. Today: `kilter`                                |
| `KILTER_OAUTH_CLIENT_SECRET`   | no                 | Confidential-client secret. Leave unset for the public PKCE client |
| `KILTER_OAUTH_REDIRECT_URI`    | yes (web)          | Must match the redirect URI registered in Keycloak                 |
| `KILTER_SYNC_ALLOWED_USER_IDS` | yes during rollout | Comma-separated NextAuth user IDs allowed to link                  |
| `AURORA_CREDENTIALS_SECRET`    | yes                | Shared encryption key with aurora-sync — same key, same table      |
| `CRON_SECRET`                  | yes (backend)      | Bearer token for `/kilter-sync-cron`                               |
| `KILTER_IDP_HOST`              | no                 | Override Keycloak host (sandbox)                                   |
| `KILTER_SYNC_HOST`             | no                 | Override PowerSync host (sandbox)                                  |
| `KILTER_PORTAL_HOST`           | no                 | Override REST portal host (sandbox)                                |
| `DATABASE_URL`                 | yes                | Same Postgres as everything else                                   |

## Open wire questions

These are the things still TODO. The kilter wire-spec documents that backed the original design were intentionally excluded from this repo for legal reasons, so verification has to happen against real traffic.

1. **REST push payload shapes.** `/api/logs/bulk`, `/api/climb-rating/`, `/api/circuits`, `/api/circuit-climbs` — endpoint paths confirmed, body shapes not. Push-back is gated behind `KILTER_SYNC_PUSH_ENABLED` and the POST helpers call `pushNotWired()` (throws) until captured.
2. **Attempts endpoint.** Whether attempts share `/api/logs/` with `topped=false`, or live on a separate REST endpoint. Pull side handles both as `logs` rows already; only push is blocked.
3. **Climb-metadata source.** PowerSync has no `climbs` bucket. Where does climb metadata for the Kilter board come from — a separate REST endpoint? A different PowerSync stream gated by a scope we don't request yet? Until this is answered, catalog ingest stays stubbed and the canonical-uuid resolver falls back to the input UUID.

When any of these get verified, replace the matching `pushNotWired()` call with the real POST and remove the item here.
