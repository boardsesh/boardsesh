# Kilter PowerSync Specification

**Covered version**: Kilter Board mobile app, current as of 2026-05-23
**Re-verified**: 2026-06-01 against the decompiled APK (`libapp.so` / `libpowersync.so` string dumps)
**Sibling docs**: [KILTER_HTTP_API_SPEC.md](KILTER_HTTP_API_SPEC.md), [AURORA_BLUETOOTH_PROTOCOL_SPEC.md](AURORA_BLUETOOTH_PROTOCOL_SPEC.md), [aurora-sync.md](aurora-sync.md)

> Kilter mirrors part of its Postgres database into the client over [PowerSync](https://www.powersync.com), an open-source sync layer. To consume Kilter user data from Boardsesh — the analogue of what `@boardsesh/aurora-sync` does for Tension/Decoy/So-iLL — Boardsesh acts as a **PowerSync client** against `sync1.kiltergrips.com`. This document describes Kilter's PowerSync setup.
>
> Where confidence is lower than HIGH, sections are explicitly marked.

> **Correction (2026-06-01).** Earlier drafts of this doc assumed the _entire_ catalog — including the world-readable climb catalog — is mirrored through PowerSync, served from inferred `public_climbs` / `global_catalog` buckets. The decompiled app shows that is **wrong**. PowerSync carries only (a) the small global **reference catalog** (holds, hold sets, grades, products, layouts, mounting holes, placement types) and (b) **per-user data** (the signed-in user's logs, attempts, ratings, circuits, walls, settings, social graph). The **public climb catalog (`climbs` + `climb_stats`) is fetched over REST**, paginated by board region, and cached into local SQLite — see [§6](#6-what-syncs-where) and [KILTER_HTTP_API_SPEC.md §5.2](KILTER_HTTP_API_SPEC.md#52-climbs). There is no PowerSync bucket that streams every public climb to every client. If you are trying to "sync the `public_climbs` bucket", stop — it does not exist; pull the catalog via REST instead.

---

## Table of Contents

1. [Background: PowerSync in 90 seconds](#1-background-powersync-in-90-seconds)
2. [Kilter's PowerSync deployment](#2-kilters-powersync-deployment)
3. [Authentication for the sync stream](#3-authentication-for-the-sync-stream)
4. [Wire protocol](#4-wire-protocol)
5. [Synced tables and indexes](#5-synced-tables-and-indexes)
6. [What syncs where (PowerSync vs REST)](#6-what-syncs-where)
7. [Client-side writes (CRUD queue)](#7-client-side-writes-crud-queue)
8. [Boardsesh implementation plan](#8-boardsesh-implementation-plan)
9. [Open questions and risks](#9-open-questions-and-risks)

---

## 1. Background: PowerSync in 90 seconds

PowerSync sits between a Postgres database and SQLite clients. The shape:

```
┌──────────────┐    logical replication    ┌────────────────┐
│  Postgres    │ ───────────────────────▶  │  PowerSync     │
│  (server)    │                           │  Service       │
└──────────────┘    upstream CRUD writes   │  (sync1.*)     │
        ▲          ◀────────────────────── │                │
        │                                  └────────┬───────┘
        │                                           │ streaming sync
        │                                           ▼
        │                                  ┌────────────────┐
        └────── REST writes ─────────────  │  Client SDK    │
                  (uploadData hook)        │                │
                                           └────────────────┘
                                                    │
                                                    ▼
                                           local SQLite (mirror)
```

Key concepts:

- **Sync rules** (server-side YAML) declare _buckets_. Each bucket is a parameterised query over Postgres that selects which rows belong in it. Buckets are the unit of sync — a client subscribes to buckets, the server streams oplog rows.
- **Parameters** come from the auth JWT (e.g. `request.user_id()`) or from client-supplied parameters in the connection request. Typical patterns: a `global` bucket of public catalog rows; one `by_user[uid]` bucket per authenticated user; potentially `by_wall[wall_uuid]`, `by_circuit[circuit_uuid]`, etc.
- **Client schema**: clients register a SQLite schema declaring which tables/columns/indexes they want. The PowerSync SQLite extension creates the tables and maintains them as oplog rows arrive.
- **CRUD upstream**: clients enqueue local mutations into a `ps_crud` table. PowerSync's `uploadData` callback hands those rows to app code, which calls the developer's REST API. After the REST call succeeds, the client calls `write-checkpoint2.json` so PowerSync knows the write has been persisted server-side.
- **Transport**: an authenticated long-poll-style streaming HTTP request (BSON-stream or NDJSON), with WebSocket as an alternative on newer protocol versions. Reconnects with a checkpoint cursor.

PowerSync's client and protocol are open-source: see [`powersync-ja/powersync-service`](https://github.com/powersync-ja/powersync-service) and [`powersync-ja/powersync-js`](https://github.com/powersync-ja/powersync-js).

---

## 2. Kilter's PowerSync deployment

| Property                  | Value                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service host              | `https://sync1.kiltergrips.com`                                                                                                                                                                                                                                           |
| Sync core                 | **Rust core `0.4.10`** (`powersync_rs_version` string in `libpowersync.so`), wrapped by the PowerSync Dart SDK                                                                                                                                                            |
| Local schema mode         | **Raw tables** — the app declares real `CREATE TABLE`s and PowerSync applies oplog rows through configured INSERT/UPDATE/DELETE statements, instead of the default auto-generated `ps_data_*` views (`RawTable` / `raw_tables` / `PendingStatement` in `libpowersync.so`) |
| Sync model                | PowerSync **Sync Streams** (`ps_stream_subscriptions`, `StreamSubscriptionRequest`, `subscribe`/`unsubscribe`, per-subscription `ttl`) — the newer stream-subscription protocol, not classic JWT-only bucket derivation                                                   |
| Storage                   | Local SQLite + the PowerSync SQLite extension                                                                                                                                                                                                                             |
| Backend connector         | Custom — Kilter implements their own connector backed by the REST API                                                                                                                                                                                                     |
| Auth mode                 | **Keycloak access token used directly** as PowerSync JWT (see [§3](#3-authentication-for-the-sync-stream))                                                                                                                                                                |
| Streaming endpoint        | `POST https://sync1.kiltergrips.com/sync/stream`                                                                                                                                                                                                                          |
| Write-checkpoint endpoint | `https://sync1.kiltergrips.com/write-checkpoint2.json?client_id=<powersync_client_id>`                                                                                                                                                                                    |
| Content-Type negotiation  | `Accept: application/vnd.powersync.bson-stream;q=0.9,application/x-ndjson;q=0.8`                                                                                                                                                                                          |

The client identifies itself with a stable UUID returned by `SELECT powersync_client_id()` — the PowerSync extension generates and persists this per install. It's appended to write-checkpoint calls so the server can correlate uploaded writes with the streaming session.

A Boardsesh `@powersync/node` client connects with a plain `Schema` of the tables it wants, calls `waitForFirstSync()`, and reads the local mirror. This is **confirmed working** for `gyms` and `walls` against the live service — see the connector example in [§3](#3-authentication-for-the-sync-stream). The same client returns nothing for the public climb catalog, because those rows do not stream (see [§6](#6-what-syncs-where)).

> Confidence: HIGH for endpoint, content-type, client_id flow, sync-core version, raw-table mode, and that a stock `@powersync/node` client syncs the buckets the token grants.

---

## 3. Authentication for the sync stream

Kilter does **not** mint a separate PowerSync JWT. The standard Keycloak `access_token` is passed directly as the bearer token to `sync1.kiltergrips.com`. The PowerSync service validates JWTs against the realm's JWKS (`https://idp.kiltergrips.com/realms/kilter/protocol/openid-connect/certs`), with `sub` as the user identifier.

This is **confirmed working** by a standalone `@powersync/node` scraper that syncs `gyms` + `walls`:

```ts
const KILTER_AUTH_URL = 'https://idp.kiltergrips.com/realms/kilter/protocol/openid-connect/token';
const KILTER_SYNC_ENDPOINT = 'https://sync1.kiltergrips.com';
const KILTER_CLIENT_ID = 'kilter'; // the realm's public client
const KILTER_SCOPE = 'openid offline_access';

// Resource-Owner-Password grant → access_token, used verbatim as the PowerSync token.
const body = new URLSearchParams({
  grant_type: 'password',
  client_id: KILTER_CLIENT_ID,
  username,
  password,
  scope: KILTER_SCOPE,
});
const { access_token, expires_in } = await (
  await fetch(KILTER_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
).json();

const connector: PowerSyncBackendConnector = {
  fetchCredentials: async () => ({
    endpoint: KILTER_SYNC_ENDPOINT,
    token: access_token, // Keycloak JWT, no exchange
    expiresAt: new Date(Date.now() + (expires_in - 60) * 1000),
  }),
  uploadData: async () => {
    /* read-only scraper */
  },
};
```

The minted access token carries `aud: ["kilter", "account"]` (the `account` audience is auto-added by Keycloak; `kilter` is the client). That is sufficient for the sync stream.

**Two token theories that are NOT the answer** — both come up when the public climb catalog fails to sync, and both are dead ends:

1. _"A different scope (`kilter-catalog`, `portal`, …) would mint `aud: ["kilter-portal", …]` and unlock more buckets."_ The app binary contains exactly one OAuth scope (`offline_access`, plus implicit `openid`) and one realm/client. There is no second audience or catalog scope anywhere in `libapp.so`. PowerSync checks `aud` **once per connection**, not per bucket — if the token authenticates the stream at all (it does; gyms/walls sync), audience is not gating any particular table.
2. _"The portal/web uses a different `client_id` that gets broader buckets."_ The only Keycloak client is `kilter`. The other client-id strings in the binary (`androidClientId`, `iosClientId`, `kilter-app-analytics`, `…firebasestorage.app`) are **Firebase / Google** identifiers for Google Sign-In, Places, and analytics — unrelated to PowerSync auth.

The real reason the catalog doesn't sync is structural, not credential: the public climb catalog is not served by PowerSync at all (see [§6](#6-what-syncs-where)). No token change unlocks it.

**Implications for Boardsesh**:

- No separate token-exchange endpoint — a Keycloak access_token talks to PowerSync directly.
- Token TTL matches Keycloak's `access_token` lifetime (5–15 min). Refresh proactively via the `refresh_token` grant, or re-run the password grant. The connector's `expiresAt` drives PowerSync's own refresh.
- The same JWT validates REST API calls (`portal.kiltergrips.com/api/*`) **and** the sync stream, so one credential store covers both planes — including the REST catalog fetch in [§6](#6-what-syncs-where).

> Confidence: HIGH. Corroborated by a working scraper (`kilter` client, `openid offline_access`, token used directly) plus the binary's single-client / single-scope OAuth config.

---

## 4. Wire protocol

Kilter uses a stock PowerSync client, so the documented PowerSync streaming protocol applies. The high-level shape:

### 4.1 Initial connection

```http
POST /sync/stream HTTP/1.1
Host: sync1.kiltergrips.com
Authorization: Bearer <keycloak_access_token>
Accept: application/vnd.powersync.bson-stream;q=0.9,application/x-ndjson;q=0.8
Content-Type: application/json

{
  "client_id": "<uuid from powersync_client_id()>",
  "buckets": [],                        // empty on first sync; checkpoint resumes on later runs
  "include_checksum": true,
  "raw_data": true                      // request row JSON rather than diffs
}
```

The body shape is fixed by the PowerSync protocol — clients don't choose buckets, the server determines them from sync rules + JWT claims.

### 4.2 Streamed messages

The server responds with `Transfer-Encoding: chunked`, emitting newline-delimited JSON (or length-prefixed BSON if the client negotiated BSON). Message types:

| Message                           | Purpose                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `StreamingSyncCheckpoint`         | Marks a consistent checkpoint that includes a `last_op_id`, list of buckets, and per-bucket checksums              |
| `StreamingSyncCheckpointDiff`     | Incremental change to the active bucket set                                                                        |
| `StreamingSyncCheckpointComplete` | Server has finished sending all data up to the checkpoint                                                          |
| `StreamingSyncData`               | A batch of oplog rows for one bucket (`{ bucket, data: [{ op_id, op, object_type, object_id, checksum, data }] }`) |
| `StreamingSyncKeepalive`          | Periodic heartbeat with `token_expires_in` seconds — client should refresh auth before this hits zero              |

### 4.3 CRUD upload

Local writes are batched into `ps_crud` and flushed via the connector's `uploadData(database)` callback. The callback:

1. Reads pending entries (`object_type`, `op`, `id`, `data`) from `ps_crud`.
2. Calls Kilter's REST API (`portal.kiltergrips.com/api/...`) to apply the mutation. Most non-trivial writes hit `/api/.../transaction` endpoints which take the equivalent of the local row set in one call.
3. On 2xx, calls `POST https://sync1.kiltergrips.com/write-checkpoint2.json?client_id=<id>` so the sync service can correlate the upload with the next streaming checkpoint.
4. Calls `database.deleteCrudBatch()` to mark it persisted.

This means the streaming endpoint is **read-only from the client's perspective** — every server-side write to Postgres flows through Kilter's REST API, and PowerSync mirrors it back out to all subscribed clients.

> Confidence: HIGH that the protocol matches stock PowerSync (the SDK is unmodified); MEDIUM on the exact JSON keys in the request body — they may differ slightly by SDK version.

---

## 5. Synced tables and indexes

The client uses PowerSync **raw tables**: it declares its own `CREATE TABLE`s and supplies the INSERT/UPDATE/DELETE statements PowerSync runs when applying oplog rows. The inventory below is split by **where each table's rows actually come from** — this is the key correction over earlier drafts. The PowerSync-synced set is identified by PowerSync's `<table>__<column>` index naming present in `libapp.so`; the REST-cached set is identified by direct app `INSERT INTO <table>` statements plus the REST endpoints that feed them.

### 5.1 Synced via PowerSync

These rows stream from `sync1.kiltergrips.com` and are confirmed (`gyms`, `walls`) or strongly indicated (the rest, via `<table>__<column>` indexes) to arrive over the sync stream.

**Global reference catalog** (small, identical for every user — the "static" board data):

| Table               | Indexed columns (and inferred PK)                                   | Notes                                                                          |
| ------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `products`          | `product_name` (pk)                                                 | Board models (Kilter Original / Homewall / Mini / Grasshopper / etc.)          |
| `product_layouts`   | `product_layout_uuid` (pk), `product_name`                          | Specific layout variants per product                                           |
| `mounting_holes`    | `mounting_hole_uuid` (pk), `product_name`                           | Hardware catalog — every hole on every board                                   |
| `holds`             | `hold_id` (pk)                                                      | Hold catalog                                                                   |
| `hold_sets`         | `hold_set_name` (pk)                                                | Hold-set groupings (Kilter HS, KS, etc.)                                       |
| `placement_types`   | `placement_type` (pk), `short_ref`                                  | start/hand/foot/finish enum                                                    |
| `difficulty_grades` | `difficulty_grade_id` (pk)                                          | Grade catalog (V-scale, font-scale)                                            |
| `gyms`              | `gym_uuid` (pk)                                                     | Gym directory — schema confirmed (see [§5.3](#53-gyms-table-confirmed-schema)) |
| `walls`             | `wall_uuid` (pk), `product_layout_uuid`, `product_name`, `gym_uuid` | Physical boards                                                                |

**Per-user data** (scoped to the authenticated `sub` by server-side stream rules):

| Table                  | Indexed columns (and inferred PK)                                                                                                     | Notes                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `users`                | `user_uuid` (pk), `email`                                                                                                             | Profiles                                          |
| `user_settings`        | `user_uuid` (pk)                                                                                                                      | Per-user preferences                              |
| `user_analytics`       | `user_uuid` (pk)                                                                                                                      | Aggregated stats                                  |
| `user_followers`       | `user_uuid`                                                                                                                           | Follower edges                                    |
| `user_blocked_climbs`  | `user_uuid`, `climb_uuid`                                                                                                             | Composite                                         |
| `user_notifications`   | `user_uuid`, `receiver_uuid`                                                                                                          | Notification feed                                 |
| `gym_followers`        | `user_uuid`                                                                                                                           | Gym follow edges                                  |
| `gym_notifications`    | `gym_uuid`, `receiver_uuid`                                                                                                           | Notifications scoped to a gym                     |
| `logs`                 | `user_uuid`, `climb_uuid`, `product_layout_uuid`, `created_at`                                                                        | Confirmed ascents                                 |
| `attempts`             | `user_uuid`, `product_layout_uuid`, `angle`                                                                                           | **Separate** from `logs` — attempts/bids vs sends |
| `climb_ratings`        | `climb_rating_uuid` (pk), `user_uuid`, `climb_uuid`, `wall_uuid`, `gym_uuid`, `product_layout_uuid`, `difficulty_grade_id`            | Heavily indexed                                   |
| `circuits`             | `circuit_uuid` (pk)                                                                                                                   | Curated route lists                               |
| `circuit_climbs`       | `circuit_uuid`, `climb_uuid`                                                                                                          | Many-to-many                                      |
| `climb_mounting_holes` | `climb_uuid`, `product_layout_uuid`, `mounting_hole_uuid`, `hold_placement_id`, `placement_type`, `default_placement_type`, `hold_id` | Hold placements per climb                         |
| `climb_beta_links`     | `climb_uuid`, `angle`, `link`                                                                                                         | External beta video/post links                    |

> The app writes `logs`, `attempts`, `climb_ratings`, `circuits`, `circuit_climbs`, `walls`, `user_settings`, `user_blocked_climbs` locally (direct `INSERT … RETURNING *`) for optimistic UI, then uploads via REST; PowerSync mirrors the server's version back. For a read-only Boardsesh consumer, treat them as read-only sync targets.

### 5.2 NOT synced via PowerSync — the public climb catalog (REST-cached)

These are plain local SQLite tables the app fills itself. **They are not PowerSync buckets.** This is the correction at the heart of this revision.

| Table                           | Populated by                                                                                                                                    | Notes                                                                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `climbs`                        | REST: `GET /api/climbs/climbdetails/{productName}/edges?…limit=&offset=` (paginated by board region), `/api/climbs/curated`, `/api/climbs/all/` | Direct `INSERT INTO climbs (id, climb_uuid, …)` in app code. The full public climb catalog.                                                                                   |
| `climb_stats`                   | REST: `/api/climb-stat/all/` (and inline with climb detail)                                                                                     | Direct `INSERT INTO climb_stats (…)`. Per-climb-angle aggregates.                                                                                                             |
| `climbs_for_product_fetch_info` | App bookkeeping                                                                                                                                 | Tracks paginated-fetch progress per `(product_name, edge_*)`; drives the "Downloading data…" preparing screen on first login. Proof that the catalog is pulled, not streamed. |
| `product_layout_updates`        | App bookkeeping                                                                                                                                 | Per-layout cache-invalidation marker (`updated_at`).                                                                                                                          |
| `recently_tried_climbs`         | App-local                                                                                                                                       | Device-only history; never leaves the device.                                                                                                                                 |

See [§6](#6-what-syncs-where) for the full data-flow picture and [KILTER_HTTP_API_SPEC.md §5.2](KILTER_HTTP_API_SPEC.md#52-climbs) for the catalog endpoints and `climbs` schema.

### 5.3 `gyms` table (confirmed schema)

Recovered verbatim from a working `@powersync/node` sync. Note the mixed snake_case / camelCase column names — they mirror the Postgres source columns as-is:

```
gym_uuid, name, address, city, country, countryCode, postal_code,
latitude, longitude, gymLogo, bannerLogo, instagramUsername, isListed
```

### 5.4 Notes on schema vs. PowerSync semantics

- PowerSync types are coerced to SQLite's three storage classes (`TEXT`, `INTEGER`, `REAL`). Booleans on the wire become `INTEGER 0/1`. Timestamps are `TEXT` ISO-8601.
- Every synced row carries an `id TEXT` column (PowerSync's oplog row id). The working `gyms`/`walls` sync selects `id` directly alongside the natural `*_uuid` key. Kilter's tables all have natural primary keys (`*_uuid` etc.); a Boardsesh translator keys on those and can ignore `id`.
- The `attempts` vs `logs` split matches Aurora's `bids` vs `ascents` distinction. Boardsesh already dual-writes both into `boardsesh_ticks` ([aurora-sync.md](aurora-sync.md)); the Kilter equivalent should follow the same pattern.

> Confidence: HIGH that `gyms`/`walls` sync (working scraper) and HIGH that `climbs`/`climb_stats` do **not** (REST-fed, per [§5.2](#52-not-synced-via-powersync--the-public-climb-catalog-rest-cached)). MEDIUM-HIGH that the remaining per-user/reference tables sync over the stream — they carry PowerSync index naming but each is worth confirming when wiring up the translator.

---

## 6. What syncs where

Kilter splits catalog data across **two transports**, and that split is the answer to "how do I sync the public climbs". The full route catalog is too large to mirror onto every device, so only the small/static and the per-user slices go through PowerSync; the big public climb catalog is paged over REST and cached.

```
                         ┌─────────────────────────────────────────────┐
   PowerSync stream  ───▶│ reference catalog: products, product_layouts │  small, static,
   sync1.kiltergrips.com │   mounting_holes, holds, hold_sets,          │  same for everyone
   (Keycloak JWT)        │   placement_types, difficulty_grades, gyms,  │
                         │   walls                                       │
                         ├─────────────────────────────────────────────┤
                         │ per-user (scoped to sub): logs, attempts,    │  one user's data
                         │   climb_ratings, circuits, circuit_climbs,   │
                         │   climb_mounting_holes, climb_beta_links,    │
                         │   users, user_settings, user_analytics,      │
                         │   user_*/gym_* social                        │
                         └─────────────────────────────────────────────┘

   REST (same JWT)   ───▶  climbs + climb_stats  ← the public climb catalog
   portal.kiltergrips.com  GET /api/climbs/climbdetails/{productName}/edges?
                              edgeLeft=&edgeRight=&edgeBottom=&edgeTop=&limit=&offset=
                            GET /api/climbs/climbdetails/{productName}/edges/count
                            GET /api/climbs/curated   ·   GET /api/climbs/all/
                            GET /api/climb-stat/all/  ·   GET /api/climbs/delteduuids
                            → app pages through them, INSERTs into local `climbs`/`climb_stats`,
                              tracks progress in `climbs_for_product_fetch_info`
```

### Why the catalog is REST, not a bucket

Five independent signals in the app, all pointing the same way:

1. **Direct inserts.** The app issues `INSERT INTO climbs (id, climb_uuid, climb_concat, name, …)` and `INSERT INTO climb_stats (…)` itself — you don't hand-write inserts into a PowerSync-managed view.
2. **A progress table.** `climbs_for_product_fetch_info(product_name, count, progress, edge_left, edge_right, edge_bottom, edge_top, last_updated_at)` exists only to track _paginated fetching_ of climbs by board region. PowerSync tracks its own sync state; a per-region progress counter is a REST-pagination artifact.
3. **A count endpoint.** `/edges/count` returns a total so the client can drive a progress bar — a REST/pagination idiom, meaningless for a streamed bucket.
4. **A "preparing" screen.** `preparing_screen.dart` shows "Downloading data…" on first login while it pages the catalog in. PowerSync's first sync needs no app-driven download loop.
5. **It's confirmed empty over PowerSync.** A working `@powersync/node` scraper syncs `gyms`/`walls` fine but gets no public catalog when it adds `climbs` to the schema — because nothing streams there.

### For Boardsesh

- **Catalog (Flow A):** pull `climbs` + `climb_stats` over REST, paging `/api/climbs/climbdetails/{productName}/edges` per product per board region (or try `/api/climbs/all/` + `/api/climb-stat/all/` for a bulk pull), using the same Keycloak token. Do **not** model it as a PowerSync bucket. See [kilter-sync.md → Catalog sync (Flow A)](kilter-sync.md#catalog-sync-flow-a).
- **Per-user (Flow B):** a normal `@powersync/node` connection with the user's token streams their `logs` / `attempts` / `climb_ratings` / `circuits`, plus the reference catalog and `gyms`/`walls`. This is the part PowerSync is genuinely for.

> Confidence: HIGH that the public catalog is REST-fed (five signals + the working scraper). HIGH that reference + per-user data is PowerSync. The exact server-side stream/bucket _names_ remain server-side and unverifiable from the client, but they no longer matter for the integration — the client never names a bucket, it declares tables and the server fills them.

---

## 7. Client-side writes (CRUD queue)

The client issues writes through the standard PowerSync `ps_crud` queue, which uploads via the REST endpoints documented in [`KILTER_HTTP_API_SPEC.md`](KILTER_HTTP_API_SPEC.md):

- `climbs` + `climb_mounting_holes` writes → `/api/climbs/create-climb/transaction`, `/api/climbs/update-climb/transaction`.
- `circuits` + `circuit_climbs` writes → `/api/circuits` and `/api/circuit-climbs`.
- `user_settings`, `user_blocked_climbs` writes → `/api/users/user-settings`, `/api/users/block-climb`, `/api/users/unblock-climb/...`.
- `logs` and `climb_ratings` writes → `/api/logs/`, `/api/logs/bulk`, `/api/climb-rating/`.

The "transaction" REST endpoints exist because PowerSync's upload callback delivers `ps_crud` entries in committed order but applies them one row at a time — the server-side `*-transaction` endpoint accepts the whole row set (parent + children) at once to avoid partial commits.

> Confidence: HIGH that the upload flow goes through PowerSync's CRUD queue (it's a default behavior of the SDK).

---

## 8. Boardsesh implementation plan

See [`kilter-sync.md`](kilter-sync.md) for the integration design — schema migrations, the climb-dedup mechanism, per-user bidirectional sync, the three-writer extension to `board_climb_stats`, daemon shape, and phased rollout. That doc supersedes this section.

---

## 9. Open questions and risks

**Resolved since the first draft:**

- ~~Token-exchange endpoint?~~ **Resolved.** The Keycloak access_token is used directly; no middleman. Confirmed by the working scraper ([§3](#3-authentication-for-the-sync-stream)).
- ~~Which client / scope / audience unlocks the catalog?~~ **Resolved — wrong question.** One client (`kilter`), one scope (`openid offline_access`); `aud: ["kilter","account"]` is sufficient. The catalog isn't gated by the token at all ([§3](#3-authentication-for-the-sync-stream), [§6](#6-what-syncs-where)).
- ~~Bucket model / does `public_climbs` stream to everyone?~~ **Resolved.** There is no public-climb bucket; the catalog is REST ([§6](#6-what-syncs-where)).
- ~~Sync rules format / protocol version?~~ **Largely resolved.** Rust sync core `0.4.10` with Sync Streams ([§2](#2-kilters-powersync-deployment)). `@powersync/node` at a recent version speaks it (the scraper works).

**Still open:**

1. **Catalog REST contract details.** The `/api/climbs/climbdetails/{productName}/edges` params (`edgeLeft/Right/Bottom/Top`, `limit`, `offset`) and the exact response shape are read off the binary, not captured. Confirm the page size cap, whether `/api/climbs/all/` returns the unpaginated catalog, and the JSON casing before building the runner. **Validation cost**: a few authenticated requests.
2. **Ratelimits or anti-scraping.** Kilter may cap concurrent streams per `sub`, or rate-limit the catalog REST endpoints. If we sync while the user has the app open, one side may get disconnected. Serialize per-user; back off on 429.
3. **Schema drift.** New client releases can grow the synced tables/indexes and the REST DTOs. Smoke-test that fails loudly on a mismatch rather than silently dropping rows.
4. **ToS / abuse considerations.** This does what their app does, on behalf of users who opt in by handing over Keycloak credentials. Same shape as `aurora-sync`. Worth a parallel section in CLAUDE.md / LEGAL.md before production.
5. **`attempts` table semantics.** Confirm whether Kilter's `attempts` is "all attempts including sends" or "non-sends only" — affects the `boardsesh_ticks` dual-write rule.
6. **Refresh-token lifetime.** Keycloak refresh_tokens expire (default 30 days / session-idle). The daemon must detect expired refresh and surface a re-auth prompt rather than failing silently.
