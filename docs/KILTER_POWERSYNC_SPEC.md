# Kilter PowerSync Specification

**Covered version**: Kilter Board Android 2.10.1 (versionCode 65), plus the Boardsesh service checks from 2026-06-02
**Package checked**: ARMv7 `libapp.so` SHA-256 `8af06628260bb3c8284d63ac8e2ec8684522d40f28a96a763df8a6d8846aa4a1`; client behavior is distinguished from server checks below
**Sibling docs**: [KILTER_HTTP_API_SPEC.md](KILTER_HTTP_API_SPEC.md), [AURORA_BLUETOOTH_PROTOCOL_SPEC.md](AURORA_BLUETOOTH_PROTOCOL_SPEC.md), [aurora-sync.md](aurora-sync.md), [KILTER_LIVE_SPEC.md](KILTER_LIVE_SPEC.md)

> Kilter mirrors part of its Postgres database into the client over [PowerSync](https://www.powersync.com), an open-source sync layer. To consume Kilter user data from Boardsesh — the analogue of what `@boardsesh/aurora-sync` does for Tension/Decoy/So-iLL — Boardsesh acts as a **PowerSync client** against `sync1.kiltergrips.com`. This document describes Kilter's PowerSync setup.
>
> Where confidence is lower than HIGH, sections are explicitly marked.

> **Catalog boundary.** Named PowerSync streams carry reference and user data, including `logs`, ratings, and circuits. Boardsesh fetches the public `climbs` and `climb_stats` catalogs through per-layout REST reads. Its live-checked routes are `GET /api/climbs/all/{productLayoutUuid}` and `GET /api/climb-stat/all/{productLayoutUuid}`. The package also contains a region-based `/climbdetails/{productName}/edges` literal; that route returned 404 in the 2026-06-02 service check. The app's current route choice is not established by those strings alone.

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

- **Sync rules** define named streams and the bucket instances delivered for a subscription. A client requests streams; the server returns bucket identifiers and oplog rows.
- **Parameters** can come from the auth JWT or from client-supplied stream subscriptions. In this deployment, Boardsesh requests named streams such as `global`, `global_gyms`, `global_climbs`, `user_buckets`, and `circuit_buckets`; the service returns parameterized bucket instances.
- **Client schema**: clients register a SQLite schema declaring which tables/columns/indexes they want. The PowerSync SQLite extension creates the tables and maintains them as oplog rows arrive.
- **CRUD upstream**: the SDK can queue local mutations in `ps_crud` and hand them to an app callback. The packaged client includes REST mutation routes and a `write-checkpoint2.json` string; the precise callback and checkpoint sequence has not been checked with a write request.
- **Transport**: an authenticated long-poll-style streaming HTTP request (BSON-stream or NDJSON), with WebSocket as an alternative on newer protocol versions. Reconnects with a checkpoint cursor.

PowerSync's client and protocol are open-source: see [`powersync-ja/powersync-service`](https://github.com/powersync-ja/powersync-service) and [`powersync-ja/powersync-js`](https://github.com/powersync-ja/powersync-js).

---

## 2. Kilter's PowerSync deployment

| Property                  | Value                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service host              | `https://sync1.kiltergrips.com`                                                                                                                                                                                                                                           |
| Sync core                 | **Rust core `0.4.10`** (`powersync_rs_version` string in `libpowersync.so`), wrapped by the PowerSync Dart SDK                                                                                                                                                            |
| Local schema mode         | **Raw tables** — the app declares real `CREATE TABLE`s and PowerSync applies oplog rows through configured INSERT/UPDATE/DELETE statements, instead of the default auto-generated `ps_data_*` views (`RawTable` / `raw_tables` / `PendingStatement` in `libpowersync.so`) |
| Sync model                | PowerSync **Sync Streams**. The client request names streams; the service resolves bucket instances from subscriptions and identity                                                                                                                                    |
| Storage                   | Local SQLite + the PowerSync SQLite extension                                                                                                                                                                                                                             |
| Backend connector         | Custom — Kilter implements their own connector backed by the REST API                                                                                                                                                                                                     |
| Auth mode                 | **Keycloak access token used directly** as PowerSync JWT (see [§3](#3-authentication-for-the-sync-stream))                                                                                                                                                                |
| Streaming endpoint        | `POST https://sync1.kiltergrips.com/sync/stream`                                                                                                                                                                                                                          |
| Write-checkpoint endpoint | `https://sync1.kiltergrips.com/write-checkpoint2.json?client_id=<powersync_client_id>`                                                                                                                                                                                    |
| Content-Type negotiation  | `Accept: application/vnd.powersync.bson-stream;q=0.9,application/x-ndjson;q=0.8`                                                                                                                                                                                          |

The SDK can obtain a client identifier with `SELECT powersync_client_id()`. A write-checkpoint URL containing `client_id` occurs in the packaged SDK; the official app's upload sequence remains unverified.

A prior `@powersync/node` check populated `gyms` and `walls`. Boardsesh now sends explicit named subscriptions through its NDJSON client. Subscribing to a schema table alone does not request every stream; the public climb catalog is fetched through REST (see [§6](#6-what-syncs-where)).

> Confidence: HIGH for the endpoint, stream-subscription request used by Boardsesh, and the prior `gyms`/`walls` check. `libpowersync.so` contains the `0.4.10` version and raw-table strings, but package strings alone do not prove every server setting or upload path.

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

The inspected package includes the `kilter` OAuth client and `openid offline_access` scope. The authenticated service snapshot contains reference and user rows, while the public climb catalog is provided through REST. The package alone cannot prove that no other client registration or server-side authorization rule exists.

**Implications for Boardsesh**:

- No separate token-exchange endpoint — a Keycloak access_token talks to PowerSync directly.
- Token TTL matches Keycloak's `access_token` lifetime (5–15 min). Refresh proactively via the `refresh_token` grant, or re-run the password grant. The connector's `expiresAt` drives PowerSync's own refresh.
- The same JWT validates REST API calls (`portal.kiltergrips.com/api/*`) **and** the sync stream, so one credential store covers both planes — including the REST catalog fetch in [§6](#6-what-syncs-where).

> Confidence: HIGH. Corroborated by a working scraper (`kilter` client, `openid offline_access`, token used directly) plus the binary's single-client / single-scope OAuth config.

---

## 4. Wire protocol

The package includes the PowerSync Dart SDK. The concrete request below is from the Boardsesh client and its checked service response:

### 4.1 Initial connection

```http
POST /sync/stream HTTP/1.1
Host: sync1.kiltergrips.com
Authorization: Bearer <keycloak_access_token>
Accept: application/x-ndjson
Content-Type: application/json

{
  "streams": {
    "include_defaults": false,
    "subscriptions": [
      { "stream": "user_buckets", "override_priority": null, "parameters": {} },
      { "stream": "circuit_buckets", "override_priority": null, "parameters": {} }
    ]
  }
}
```

This is the request body used by Boardsesh for a user snapshot. The client names streams, and the server resolves their bucket instances. Other clients may include defaults or additional resume fields. The shown request shape has been accepted by the service; it is not a claim that every SDK sends identical JSON.

### 4.2 Streamed messages

The checked Boardsesh request receives newline-delimited JSON. The packaged SDK also advertises BSON-stream support; HTTP framing can vary by connection. Message types:

| Message                           | Purpose                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `StreamingSyncCheckpoint`         | Marks a consistent checkpoint that includes a `last_op_id`, list of buckets, and per-bucket checksums              |
| `StreamingSyncCheckpointDiff`     | Incremental change to the active bucket set                                                                        |
| `StreamingSyncCheckpointComplete` | Server has finished sending all data up to the checkpoint                                                          |
| `StreamingSyncData`               | A batch of oplog rows for one bucket (`{ bucket, data: [{ op_id, op, object_type, object_id, checksum, data }] }`) |
| `StreamingSyncKeepalive`          | Periodic heartbeat with `token_expires_in` seconds — client should refresh auth before this hits zero              |

### 4.3 CRUD upload

The PowerSync SDK supports batching local writes in `ps_crud` for an `uploadData(database)` callback. A typical flow:

1. Reads pending entries (`object_type`, `op`, `id`, `data`) from `ps_crud`.
2. Uses Kilter's REST API (`portal.kiltergrips.com/api/...`) to apply app mutations.
3. Clears successfully uploaded local entries and waits for the synced server state.

The observed Boardsesh sync client is read-only. The exact official-app callback order, REST payloads, and checkpoint behavior require request-level confirmation; the presence of SDK strings for `write-checkpoint2.json` does not establish when the app invokes that endpoint.

> Confidence: HIGH for the Boardsesh request and parsed NDJSON snapshot. LOW for the official app's upload callback and checkpoint sequence.

---

## 5. Synced tables and indexes

The client uses PowerSync **raw tables**: it declares its own `CREATE TABLE`s and supplies the INSERT/UPDATE/DELETE statements PowerSync runs when applying oplog rows. The inventory below is split by **where each table's rows actually come from** — this is the key correction over earlier drafts. The PowerSync-synced set is identified by PowerSync's `<table>__<column>` index naming present in `libapp.so`; the REST-cached set is identified by direct app `INSERT INTO <table>` statements plus the REST endpoints that feed them.

### 5.1 Synced via PowerSync

The checked streams contain the reference and user rows listed in §6. The wider client schema below includes candidates inferred from `<table>__<column>` indexes; an index name alone does not prove a row type arrived in a selected stream.

**Reference catalog** (observed in the selected global streams):

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

**User-related schema candidates** (only checked rows from the selected user streams are confirmed):

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
| `logs`                 | `user_uuid`, `climb_uuid`, `product_layout_uuid`, `created_at`                                                                        | Sends and attempts, distinguished by `topped` and `flashed` |
| `attempts`             | `user_uuid`, `product_layout_uuid`, `angle`                                                                                           | Index literals identify a schema candidate; no separate stream role verified |
| `climb_ratings`        | `climb_rating_uuid` (pk), `user_uuid`, `climb_uuid`, `wall_uuid`, `gym_uuid`, `product_layout_uuid`, `difficulty_grade_id`            | Heavily indexed                                   |
| `circuits`             | `circuit_uuid` (pk)                                                                                                                   | Curated route lists                               |
| `circuit_climbs`       | `circuit_uuid`, `climb_uuid`                                                                                                          | Many-to-many                                      |
| `climb_mounting_holes` | `climb_uuid`, `product_layout_uuid`, `mounting_hole_uuid`, `hold_placement_id`, `placement_type`, `default_placement_type`, `hold_id` | Hold placements per climb                         |
| `climb_beta_links`     | `climb_uuid`, `angle`, `link`                                                                                                         | External beta video/post links                    |

The table lists client-schema candidates, not a guarantee that every row type arrives in every subscription. The checked `user_buckets` stream carries `logs` for both sends and attempts; Boardsesh reads it without creating local upstream writes. Other table coverage must be checked against the selected streams.

### 5.2 NOT synced via PowerSync — the public climb catalog (REST-cached)

These are local SQLite tables with app-side cache operations. **They are not observed in the selected PowerSync streams.** The table separates package cache evidence from routes checked by Boardsesh; it does not assume the app invokes the same REST route.

| Table | Package evidence | Current Boardsesh read |
| --- | --- | --- |
| `climbs` | Direct local `INSERT INTO climbs` statement; package also contains the region `/edges` route | `GET /api/climbs/all/{productLayoutUuid}`, accepted in the 2026-06-02 service check |
| `climb_stats` | Direct local `INSERT INTO climb_stats` statement | `GET /api/climb-stat/all/{productLayoutUuid}`, accepted in the same check |
| `climbs_for_product_fetch_info` | Local region-fetch progress table | None; Boardsesh tracks its own catalog runs |
| `product_layout_updates` | Local per-layout cache marker | None |
| `recently_tried_climbs` | Local recent-climb history | None |

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
- Kilter's checked `logs` stream contains both sends and attempts. `topped` and `flashed` distinguish the outcome. The package also contains `attempts` index names, but no separate `attempts` stream role was verified or needed by the Boardsesh pull.

> Confidence: HIGH that `gyms`/`walls` sync (working scraper) and HIGH that `climbs`/`climb_stats` do **not** (REST-fed, per [§5.2](#52-not-synced-via-powersync--the-public-climb-catalog-rest-cached)). MEDIUM-HIGH that the remaining per-user/reference tables sync over the stream — they carry PowerSync index naming but each is worth confirming when wiring up the translator.

---

## 6. What syncs where

The service distinguishes **stream names** in a request from the parameterized **bucket instances** returned in a checkpoint. Boardsesh sends `streams.include_defaults: false` and names only the streams it needs. The following mapping is based on the service snapshots used by the current integration; a schema declaration alone does not subscribe to a stream.

| Requested stream | Observed bucket content | Boardsesh use |
| --- | --- | --- |
| `global` | Holds, hold sets, grades, placement types | Reference catalog |
| `global_gyms` | Gyms, walls, products, layouts | Reference catalog and board mapping |
| `global_climbs` | Beta links, hold placements, mounting holes | Reference catalog; no public `climbs` rows |
| `user_buckets` | User, homewall, `logs`, ratings, analytics | Per-user import; `logs` covers sends and attempts |
| `circuit_buckets` | Circuits and circuit climbs | Playlist import; must accompany `user_buckets` |

`GET /api/climbs/all/{productLayoutUuid}` and `GET /api/climb-stat/all/{productLayoutUuid}` supply the public climb catalog. These per-layout reads and `GET /api/climbs/delteduuids` were checked against the service in 2026-06-02 and are the routes in the Boardsesh client. The package's `/climbdetails/{productName}/edges` literal does not establish a working route; it returned 404 in that check. `/api/climbs/all/` without a layout ID returned an empty array.

The current user sync explicitly requests `user_buckets` plus `circuit_buckets`. Requesting only one leaves part of the playlist data out. See [kilter-sync.md](kilter-sync.md#powersync-buckets-verified-live) for object-type mapping and error handling.

> Confidence: HIGH for the observed service snapshots, accepted stream request, and checked REST catalog routes. Server-side rule definitions, account-specific visibility, and future stream contents remain unverified.

---

## 7. Client-side writes (CRUD queue)

The package contains PowerSync CRUD support and REST mutation URLs documented in [`KILTER_HTTP_API_SPEC.md`](KILTER_HTTP_API_SPEC.md). The operation-to-route mapping and payloads below remain candidates until an actual write request is checked:

- `climbs` + `climb_mounting_holes` writes → `/api/climbs/create-climb/transaction`, `/api/climbs/update-climb/transaction`.
- `circuits` + `circuit_climbs` writes → `/api/circuits` and `/api/circuit-climbs`.
- `user_settings`, `user_blocked_climbs` writes → `/api/users/user-settings`, `/api/users/block-climb`, `/api/users/unblock-climb/...`.
- `logs` and `climb_ratings` writes → candidate `/api/v2/logs/`, `/api/v2/logs/bulk`, `/api/v2/climb-rating/` URLs in the 2.10.1 package.

The transaction endpoints suggest grouped writes, but the package alone does not establish server atomicity or their complete request bodies.

> Confidence: HIGH for packaged route literals and SDK CRUD support; LOW for official-app callback sequence and write shapes. Boardsesh push-back remains unwired.

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

1. **Catalog route changes.** The checked per-layout `/api/climbs/all/{productLayoutUuid}` and `/api/climb-stat/all/{productLayoutUuid}` routes work for the current integration. Recheck them when the app or service changes; the package's `/climbdetails/{productName}/edges` path returned 404 in the prior service check.
2. **Ratelimits or anti-scraping.** Kilter may cap concurrent streams per `sub`, or rate-limit the catalog REST endpoints. If we sync while the user has the app open, one side may get disconnected. Serialize per-user; back off on 429.
3. **Schema drift.** New client releases can grow the synced tables/indexes and the REST DTOs. Smoke-test that fails loudly on a mismatch rather than silently dropping rows.
4. **ToS / abuse considerations.** This does what their app does, on behalf of users who opt in by handing over Keycloak credentials. Same shape as `aurora-sync`. Worth a parallel section in CLAUDE.md / LEGAL.md before production.
5. **Write contract.** Confirm which packaged v2 URL each log/rating operation uses, including method, body, and response. `logs` already carries both sends and attempts on the checked pull path.
6. **Refresh-token lifetime.** Keycloak refresh_tokens expire (default 30 days / session-idle). The daemon must detect expired refresh and surface a re-auth prompt rather than failing silently.
