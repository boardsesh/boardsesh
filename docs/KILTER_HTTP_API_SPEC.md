# Kilter HTTP API Specification

**Covered version**: Kilter Board Android 2.10.1 (versionCode 65), with live API checks from 2026-06-02
**Sibling docs**: [KILTER_POWERSYNC_SPEC.md](KILTER_POWERSYNC_SPEC.md), [AURORA_BLUETOOTH_PROTOCOL_SPEC.md](AURORA_BLUETOOTH_PROTOCOL_SPEC.md), [KILTER_LIVE_SPEC.md](KILTER_LIVE_SPEC.md)

> Kilter Grips runs their own backend, separate from the Aurora Climbing backend that other Aurora-family boards share. The wire-level Bluetooth protocol used to drive the LED hardware is shared with Aurora and is documented in [`AURORA_BLUETOOTH_PROTOCOL_SPEC.md`](AURORA_BLUETOOTH_PROTOCOL_SPEC.md). **This document only covers the HTTP and realtime-sync APIs.**
>
> This is a client and integration guide, not an authoritative server contract. The 2.10.1 package contains some URL literals that are not the routes accepted by the service; live checked routes are identified below. Method choices and full request/response shapes remain unverified unless explicitly stated.

---

## Table of Contents

1. [Architecture overview](#1-architecture-overview)
2. [Hostnames and base URLs](#2-hostnames-and-base-urls)
3. [Authentication (Keycloak / OIDC)](#3-authentication-keycloak--oidc)
4. [HTTP conventions](#4-http-conventions)
5. [Endpoints](#5-endpoints)
   1. [Users](#51-users)
   2. [Climbs](#52-climbs)
   3. [Climb statistics](#53-climb-statistics)
   4. [Climb ratings](#54-climb-ratings)
   5. [Climb mounting holes](#55-climb-mounting-holes)
   6. [Logs (ascents and attempts)](#56-logs-ascents-and-attempts)
   7. [Circuits and circuit climbs](#57-circuits-and-circuit-climbs)
   8. [Walls (boards)](#58-walls-boards)
   9. [Gyms and followers](#59-gyms-and-followers)
   10. [Notifications](#510-notifications)
   11. [Reporting and moderation](#511-reporting-and-moderation)
   12. [Image upload](#512-image-upload)
6. [PowerSync realtime layer](#6-powersync-realtime-layer)
7. [Local SQLite schema (client-side mirror)](#7-local-sqlite-schema-client-side-mirror)
8. [Third-party integrations](#8-third-party-integrations)
9. [Open questions](#9-open-questions)

---

## 1. Architecture overview

Networking splits into four planes:

| Plane             | Host                     | Transport                               | Purpose                                                                      |
| ----------------- | ------------------------ | --------------------------------------- | ---------------------------------------------------------------------------- |
| **Identity**      | `idp.kiltergrips.com`    | HTTPS (Keycloak OIDC)                   | Login, registration, refresh, logout                                         |
| **REST API**      | `portal.kiltergrips.com` | HTTPS / JSON                            | Mutations (create climb, log ascent, follow user, etc.) and on-demand reads  |
| **Realtime sync** | `sync1.kiltergrips.com`  | HTTPS streaming + WebSocket (PowerSync) | Bidirectional sync of the Postgres-backed catalog into a local SQLite mirror |
| **Maps**          | `places.googleapis.com`  | HTTPS / JSON                            | Gym/wall location autocomplete                                               |

Most reads go to a **local SQLite mirror**, but that mirror is filled by **two different mechanisms**, and the split matters for interop:

- **PowerSync** fills the small reference catalog (holds, hold sets, grades, products, layouts, mounting holes), `gyms`/`walls`, and the signed-in user's own data (logs, attempts, ratings, circuits, settings, social). Confirmed working with a stock `@powersync/node` client — see [`KILTER_POWERSYNC_SPEC.md §6`](KILTER_POWERSYNC_SPEC.md#6-what-syncs-where).
- **REST** fills the public **climb catalog** (`climbs` + `climb_stats`). The package contains a region-based `/climbdetails/{productName}/edges` path, but that route returned 404 in the 2026-06-02 service check. Boardsesh uses the successful per-layout `/api/climbs/all/{productLayoutUuid}` and `/api/climb-stat/all/{productLayoutUuid}` reads. This catalog is **not** a PowerSync bucket.

The REST API is therefore used for:

- the public climb catalog read path (`/api/climbs/all/{productLayoutUuid}`, `/api/climb-stat/all/{productLayoutUuid}`, `/api/climbs/delteduuids`)
- writes (logs, climbs, ratings, circuits)
- operations PowerSync can't model (image upload, email verification, OAuth-mediated registration)
- named `transaction` endpoints used for grouped write candidates; server atomicity is unverified

The app feels offline-tolerant because reads hit local SQLite — but populating the climb catalog there is an explicit REST download, not a background PowerSync stream.

---

## 2. Hostnames and base URLs

```
https://idp.kiltergrips.com/realms/kilter        # Keycloak realm
https://portal.kiltergrips.com                   # Marketing/web frontend (also serves /api)
https://portal.kiltergrips.com/api               # REST API root
https://sync1.kiltergrips.com                    # PowerSync streaming endpoint
https://places.googleapis.com/v1                 # Google Places
https://app.kiltergrips.com/privacy              # Static privacy page
https://app.kiltergrips.com/terms                # Static terms page
```

A `/v2/users/` path also exists alongside the `/api/users/` routes. Its purpose is unclear without further investigation (see [open questions](#9-open-questions)).

---

## 3. Authentication (Keycloak / OIDC)

Authentication is delegated to Keycloak, with Authorization Code + PKCE.

| Endpoint           | URL                                                                        |
| ------------------ | -------------------------------------------------------------------------- |
| Issuer / discovery | `https://idp.kiltergrips.com/realms/kilter`                                |
| Authorization      | `https://idp.kiltergrips.com/realms/kilter/protocol/openid-connect/auth`   |
| Token              | `https://idp.kiltergrips.com/realms/kilter/protocol/openid-connect/token`  |
| Logout             | `https://idp.kiltergrips.com/realms/kilter/protocol/openid-connect/logout` |

**Redirect URI scheme**: `com.kiltergrips:/oauthredirect`.

**Client / scope** (confirmed): `client_id=kilter`, `scope=openid offline_access`. There is one realm (`kilter`) and one client; the access token's `aud` is `["kilter", "account"]`. A headless consumer can skip the browser flow entirely and use the Resource-Owner-Password grant (`grant_type=password`) against `/token` with the same `client_id` and `scope` — confirmed working for the PowerSync stream. (The other client-id strings in the app — `androidClientId`, `iosClientId`, `kilter-app-analytics` — are Firebase/Google, not Keycloak.)

**Flow**:

1. Client opens a Custom Tab / SFAuthenticationSession pointing at the Keycloak `/auth` endpoint with PKCE.
2. Keycloak redirects back to `com.kiltergrips:/oauthredirect?code=…` after consent.
3. Client exchanges the code at `/token` for an `access_token`, `refresh_token`, and `id_token`.
4. `access_token` is sent as `Authorization: Bearer <jwt>` on every call to `portal.kiltergrips.com/api/*`. The same token authenticates the PowerSync stream.

**Token endpoint response fields** (OIDC JSON; `expiresAt` is a local value computed from `expires_in`):

- `access_token`
- `refresh_token`
- `token_type` (`Bearer`)
- `expires_in` (seconds)
- `id_token` (OIDC, decoded for user info)

**ID-token / user-info claims used by the client**:

- `sub` — Keycloak user UUID
- `email`, `email_verified`
- `preferred_username`
- `given_name`, `family_name`

> **Confidence**: HIGH for the endpoint URLs (all are reachable via the realm's standard `.well-known/openid-configuration`).

---

## 4. HTTP conventions

| Header          | Value                                                                                |
| --------------- | ------------------------------------------------------------------------------------ |
| `Authorization` | `Bearer <access_token>` (Keycloak access JWT)                                        |
| `Content-Type`  | `application/json` for POST/PUT/PATCH bodies; `multipart/form-data` for image upload |
| `Accept`        | `application/json`                                                                   |
| `User-Agent`    | Stock HTTP-client default; no custom UA                                              |

Path conventions:

- Resource collections are plural: `/api/climbs`, `/api/circuits`, `/api/walls`.
- Single-resource fetches usually use a trailing-slash + ID pattern: `/api/climbs/single/{climbUuid}`, `/api/circuits/get-circuit/{circuitUuid}`.
- Transactional / multi-table write endpoints are explicitly named: `/api/climbs/create-climb/transaction`, `/api/climbs/update-climb/transaction`.
- Snake_case is common in the PowerSync rows. The checked per-layout catalog REST responses use camelCase; other write DTOs still need confirmation.

> **Confidence**: HIGH for catalog response casing; LOW for untested write headers and DTO casing.

---

## 5. Endpoints

For each endpoint, distinguish a path embedded in the client from a route accepted in a live service check. Unless called out, **method** is inferred from semantics (resource lookup → GET; "create" / "update" / "transaction" → POST) and **shape** is inferred from client-side models. Treat inferred shapes as examples, not a contract.

### 5.1 Users

| Method   | Path                                               | Purpose                                                                 |
| -------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET`    | `/api/users/`                                      | Get current authenticated user                                          |
| `GET`    | `/api/users/find`                                  | Search users (by email / username / display name)                       |
| `POST`   | `/api/users/register?redirectUrl=<frontend_url>`   | Server-side user creation; redirects browser to the frontend on success |
| `POST`   | `/api/users/email/verification`                    | Trigger an email-verification message for the current user              |
| `GET`    | `/api/users/email/verify/{token}`                  | Email-confirmation landing endpoint (called via deeplink)               |
| `POST`   | `/api/users/resend/id/{userId}`                    | Resend verification or reset email for a user                           |
| `GET`    | `/api/users/user-settings`                         | Read the current user's settings                                        |
| `PUT`    | `/api/users/user-settings`                         | Update the current user's settings                                      |
| `GET`    | `/api/users/user-analytics`                        | Aggregated user stats (totals, distributions, last-session date)        |
| `POST`   | `/api/users/block-climb`                           | Hide a climb from the current user's feed                               |
| `DELETE` | `/api/users/unblock-climb/{climbUuid}?angle=<deg>` | Un-hide a previously blocked climb                                      |
| `GET`    | `/v2/users/`                                       | Unknown v2 namespace — possibly paginated user listing or admin variant |

**User DTO** (camelCase, inferred):

```jsonc
{
  "userUuid": "uuid",
  "username": "string", // unique handle
  "email": "string",
  "firstName": "string",
  "lastName": "string",
  "displayName": "string", // optional, derived
  "profilePictureUrl": "string",
  "bio": "string",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
}
```

**Registration error** (the only typed error model surfaced):

```jsonc
{
  "errorCode": "EMAIL_TAKEN | USERNAME_TAKEN | INVALID_EMAIL | …",
  "message": "human-readable",
  "field": "email | username | …",
}
```

> Confidence: HIGH for path list. MEDIUM for shape. LOW for `/v2/users/` semantics.

### 5.2 Climbs

| Method | Path                                                                                                    | Purpose                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `GET`  | `/api/climbs/`                                                                                          | Paginated climb list (filtered by query params)                                   |
| `GET`  | `/api/climbs/all/{productLayoutUuid}`                                                                    | Full per-layout climb array; live checked by Boardsesh                            |
| `GET`  | `/api/climbs/single/{climbUuid}`                                                                        | Fetch one climb                                                                   |
| `GET`  | `/api/climbs/curated`                                                                                   | Curated/featured climbs                                                           |
| `GET`  | `/api/climbs/logged`                                                                                    | Climbs the current user has logged                                                |
| `GET`  | `/api/climbs/delteduuids`                                                                               | UUIDs of deleted climbs (sync cleanup; note the typo)                             |
| `GET`  | `/api/climbs/climbdetails/`                                                                             | Climb details (joined with rating/log info)                                       |
| `GET`  | `/api/climbs/climbdetails/user`                                                                         | Current user's climbs with stats                                                  |
| `GET`  | `/api/climbs/climbdetails/{productName}/edges?edgeLeft=&edgeRight=&edgeBottom=&edgeTop=&limit=&offset=` | Client-packaged region route; returned 404 in the 2026-06-02 check                |
| `GET`  | `/api/climbs/climbdetails/{productName}/edges/count`                                                    | Client-packaged count route; service behavior unverified                          |
| `POST` | `/api/climbs/create-climb/transaction`                                                                  | Grouped create candidate; accepted body and atomicity unverified                 |
| `POST` | `/api/climbs/update-climb/transaction`                                                                  | Grouped update candidate; accepted body and atomicity unverified                 |

**Climb DTO** — JSON key on the wire (camelCase, inferred) mapped to the snake_case Postgres column that PowerSync mirrors:

| JSON key                                      | Postgres column              | Type     | Notes                                                                                                                                                      |
| --------------------------------------------- | ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `climbUuid`                                   | `climb_uuid`                 | string   | PK                                                                                                                                                         |
| `name`                                        | `name`                       | string   | display name                                                                                                                                               |
| `description`                                 | `description`                | string?  |                                                                                                                                                            |
| `userUuid`                                    | `user_uuid`                  | string   | setter                                                                                                                                                     |
| `username`                                    | `username`                   | string   | setter username (denormalized)                                                                                                                             |
| `productName`                                 | `product_name`               | string   | e.g. `Kilter Board Original`, `Kilter Board Homewall`                                                                                                      |
| `productLayoutUuid`                           | `product_layout_uuid`        | string   | specific board+set combo                                                                                                                                   |
| `edgeLeft`,`edgeRight`,`edgeBottom`,`edgeTop` | `edge_*`                     | integer  | bounding box on the board                                                                                                                                  |
| `frameCount`                                  | `frame_count`                | integer  | for multi-frame climbs                                                                                                                                     |
| `framesPace`                                  | `frames_pace`                | integer  | ms per frame                                                                                                                                               |
| `angle`                                       | `angle`                      | integer? | preferred angle, optional                                                                                                                                  |
| `allowMatch`                                  | `allow_match`                | bool     | matching hands on a hold permitted                                                                                                                         |
| `isDraft`                                     | `is_draft`                   | bool     |                                                                                                                                                            |
| `isListed`                                    | `is_listed`                  | bool     | public vs unlisted                                                                                                                                         |
| `accumulatedHoldSetValue`                     | `accumulated_hold_set_value` | integer  | sum of "value" across hold sets used                                                                                                                       |
| `curated`                                     | `curated`                    | bool?    | featured                                                                                                                                                   |
| `isDeleted`                                   | `is_deleted`                 | bool     | soft-delete; cleared via `/delteduuids`                                                                                                                    |
| `createdAt`,`updatedAt`                       | `created_at`,`updated_at`    | ISO-8601 |                                                                                                                                                            |
| `climbConcat`                                 | `climb_concat`               | string   | canonical placement-encoded string (same encoding used by the LED protocol — see [`AURORA_BLUETOOTH_PROTOCOL_SPEC.md`](AURORA_BLUETOOTH_PROTOCOL_SPEC.md)) |

The `create-climb/transaction` and `update-climb/transaction` request bodies are presumed to include the parent climb fields plus an array of `mountingHoles` (see [§5.5](#55-climb-mounting-holes)).

`/api/climbs/all/` without a layout ID returned `[]` in the 2026-06-02 check. The per-layout read returns camelCase JSON. See [kilter-sync.md](kilter-sync.md#verified-restpowersync-contract-phase-0-2026-06-02) for the checked response and current integration.

> Confidence: HIGH for the checked per-layout and deletion reads; HIGH that the other listed path literals occur in the client package; LOW for untested route behavior and write shapes.

### 5.3 Climb statistics

| Method | Path                   | Purpose                                  |
| ------ | ---------------------- | ---------------------------------------- |
| `GET`  | `/api/climb-stat/`     | Per-climb stats for a single climb+angle |
| `GET`  | `/api/climb-stat/all/{productLayoutUuid}` | Full per-layout stat array; live checked by Boardsesh |

**ClimbStat DTO**:

| JSON key                   | Postgres column              | Type                                |
| -------------------------- | ---------------------------- | ----------------------------------- |
| `climbUuid`                | `climb_uuid`                 | string                              |
| `angle`                    | `angle`                      | integer                             |
| `ascentCount`              | `ascent_count`               | integer                             |
| `currentDifficultyId`      | `current_difficulty_id`      | integer (FK into difficulty_grades) |
| `officialKilterDifficulty` | `official_kilter_difficulty` | integer?                            |
| `difficultyAverage`        | `difficulty_average`         | float                               |
| `qualityAverage`           | `quality_average`            | float                               |
| `faUsername`               | `fa_username`                | string? — first-ascent username     |
| `faAt`                     | `fa_at`                      | ISO-8601?                           |
| `curated`                  | `curated`                    | bool?                               |

Primary key is `(climb_uuid, angle)`.

> Confidence: HIGH on the column set.

### 5.4 Climb ratings

| Method   | Path                                  | Purpose                                                                      |
| -------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| `GET`    | `/api/v2/climb-rating/`                  | List the current user's ratings (likely filterable by `climbUuid` / `angle`) |
| `GET`    | `/api/v2/climb-rating/{climbRatingUuid}` | Fetch a single rating                                                        |
| `POST`   | `/api/v2/climb-rating/`                  | Create a rating                                                              |
| `PUT`    | `/api/v2/climb-rating/{climbRatingUuid}` | Update a rating                                                              |
| `DELETE` | `/api/v2/climb-rating/{climbRatingUuid}` | Delete a rating                                                              |

**ClimbRating DTO** (inferred):

```jsonc
{
  "climbRatingUuid": "uuid",
  "userUuid": "uuid",
  "climbUuid": "uuid",
  "angle": 40,
  "rating": 4, // 1–5 stars
  "difficultyGradeId": 16, // user's perceived difficulty
  "comment": "Great moves on the crux",
  "weight": 1.0, // optional, confidence/ascent-count weight
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
}
```

The 2.10.1 package contains both absolute `/api/v2/climb-rating` URLs and a relative `/api/climb-rating/` literal. Which operations use each route, and which methods the service accepts, remain unverified. The table shows the versioned route family as a client candidate, not a tested write contract.

> Confidence: HIGH for embedded route literals; LOW for method matrix and write shape.

### 5.5 Climb mounting holes

| Method | Path                                                              | Purpose                                            |
| ------ | ----------------------------------------------------------------- | -------------------------------------------------- |
| `GET`  | `/api/climb-mounting-holes/{climbUuid}?angle=&productLayoutUuid=` | Hold placements for one climb on a specific layout |

**ClimbMountingHole DTO**:

```jsonc
{
  "climbMountingHoleUuid": "uuid",
  "climbUuid": "uuid",
  "productLayoutUuid": "uuid",
  "mountingHoleId": 123, // FK into the static hole catalog
  "placementTypeId": 12, // start / hand / foot / finish — same enum used by the LED protocol
  "x": 0.42, // sometimes inlined; otherwise resolved from mounting_hole_id
  "y": 0.71,
}
```

The placement-type enum is the same one used over Bluetooth (see [`AURORA_BLUETOOTH_PROTOCOL_SPEC.md`](AURORA_BLUETOOTH_PROTOCOL_SPEC.md)).

> Confidence: MEDIUM.

### 5.6 Logs (ascents and attempts)

| Method   | Path                  | Purpose                                                  |
| -------- | --------------------- | -------------------------------------------------------- |
| `GET`    | `/api/v2/logs/`          | List the current user's logs                             |
| `GET`    | `/api/v2/logs/{logUuid}` | Fetch a single log                                       |
| `POST`   | `/api/v2/logs/`          | Create one log                                           |
| `POST`   | `/api/v2/logs/bulk`      | Bulk-upload logs (offline-first sync of pending entries) |
| `PUT`    | `/api/v2/logs/{logUuid}` | Update a log                                             |
| `DELETE` | `/api/v2/logs/{logUuid}` | Delete a log                                             |

**Log DTO**:

```jsonc
{
  "logUuid": "uuid",
  "userUuid": "uuid",
  "climbUuid": "uuid",
  "productLayoutUuid": "uuid",
  "angle": 40,
  "topped": true, // sent the route
  "flashed": false, // sent on first session/with beta
  "sentimentValue": 4, // emoji rating, 1–5
  "rating": 4, // overlaps with ClimbRating; bulk endpoint may write both
  "difficultyGradeId": 18,
  "comment": "string",
  "createdAt": "ISO-8601",
}
```

The 2.10.1 package contains absolute `/api/v2/logs/` and `/api/v2/logs/bulk` URLs. The table's method matrix and write body are still inferred; no push request has been checked against the service.

> Confidence: HIGH for embedded route literals; LOW for method matrix and write shape.

### 5.7 Circuits and circuit climbs

| Method   | Path                                      | Purpose                                                       |
| -------- | ----------------------------------------- | ------------------------------------------------------------- |
| `GET`    | `/api/circuits`                           | List circuits (optionally filtered by `userUuid`, `isPublic`) |
| `GET`    | `/api/circuits/{circuitUuid}`             | One circuit with its climbs                                   |
| `GET`    | `/api/circuits/get-circuit/{circuitUuid}` | Alternative single-fetch endpoint (legacy or alias)           |
| `POST`   | `/api/circuits`                           | Create circuit                                                |
| `PUT`    | `/api/circuits/{circuitUuid}`             | Update circuit metadata                                       |
| `DELETE` | `/api/circuits/{circuitUuid}`             | Delete circuit                                                |
| `GET`    | `/api/circuit-climbs?circuitUuid=`        | List climbs in a circuit                                      |
| `POST`   | `/api/circuit-climbs`                     | Add a climb to a circuit                                      |
| `PUT`    | `/api/circuit-climbs/{circuitClimbUuid}`  | Reorder a climb within a circuit                              |
| `DELETE` | `/api/circuit-climbs/{circuitClimbUuid}`  | Remove a climb from a circuit                                 |

**Circuit DTO**:

```jsonc
{
  "circuitUuid": "uuid",
  "name": "Warm-up",
  "description": "string",
  "color": "#FF5733",
  "isPublic": false,
  "userUuid": "uuid",
  "creatorName": "string", // denormalized
  "creatorProfilePicture": "url",
  "count": 12, // climbs in circuit (joined)
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
}
```

**CircuitClimb DTO**:

```jsonc
{
  "circuitClimbUuid": "uuid",
  "circuitUuid": "uuid",
  "climbUuid": "uuid",
  "order": 3,
  "addedAt": "ISO-8601",
}
```

> Confidence: HIGH for path list; MEDIUM for write-side method matrix.

### 5.8 Walls (boards)

| Method   | Path                                | Purpose                                                 |
| -------- | ----------------------------------- | ------------------------------------------------------- |
| `GET`    | `/api/walls`                        | List walls (filtered by `gymUuid` and/or `productName`) |
| `GET`    | `/api/walls/climbcount`             | Climb counts per wall                                   |
| `POST`   | `/api/walls/custom-wall`            | Register a user-owned custom wall (homewall)            |
| `PUT`    | `/api/walls/custom-wall/{wallUuid}` | Update a custom wall                                    |
| `DELETE` | `/api/walls/custom-wall/{wallUuid}` | Delete a custom wall                                    |

**Wall DTO**:

```jsonc
{
  "wallUuid": "uuid",
  "name": "Main Wall",
  "gymUuid": "uuid", // null for homewalls
  "productName": "Kilter Board Original",
  "productLayoutUuid": "uuid",
  "serialNumber": "string", // hardware Bluetooth serial
  "isAdjustable": true,
  "minAngle": 0,
  "maxAngle": 70,
  "angleIncrements": 5,
  "angle": 40, // currently set angle
  "isListed": true,
  "boardDisplayName": "string", // branded label
}
```

> Confidence: HIGH for paths; MEDIUM for shape.

### 5.9 Gyms and followers

| Method   | Path                            | Purpose                                                      |
| -------- | ------------------------------- | ------------------------------------------------------------ |
| `GET`    | `/api/followers/`               | Followers of the current user                                |
| `GET`    | `/api/followers/user`           | Users the current user follows                               |
| `GET`    | `/api/followers/user/following` | Following list (variant — likely `?userUuid=` parameterized) |
| `GET`    | `/api/followers/gym/?gymUuid=`  | Followers of a gym                                           |
| `POST`   | `/api/followers/`               | Follow a user or gym                                         |
| `DELETE` | `/api/followers/`               | Unfollow                                                     |
| inferred | `/api/v2/followers/users/`      | Versioned user-follow route embedded in the 2.10.1 package  |
| inferred | `/api/v2/followers/gyms/`       | Versioned gym-follow route embedded in the 2.10.1 package   |

Gym endpoints don't surface as `/api/gyms` paths — gym data appears to be **read exclusively from the PowerSync SQLite mirror** (see [§7](#7-local-sqlite-schema-client-side-mirror)). Discovery / "find gym near me" is handled client-side by querying the local DB after Google Places autocomplete narrows the geographic region (see [§8](#8-third-party-integrations)).

> Confidence: HIGH for embedded v1 and v2 follower path literals; LOW for the operation-to-route mapping and methods. Gym rows are available through PowerSync; gym CRUD behavior is unverified.

### 5.10 Notifications

| Method   | Path                                    | Purpose            |
| -------- | --------------------------------------- | ------------------ |
| `GET`    | `/api/notifications/`                   | List notifications |
| `PUT`    | `/api/notifications/{notificationUuid}` | Mark read          |
| `DELETE` | `/api/notifications/{notificationUuid}` | Dismiss            |

**Notification DTO** (inferred):

```jsonc
{
  "notificationUuid": "uuid",
  "userUuid": "uuid", // recipient
  "type": "climb_rated | comment_added | followed | wall_added | …",
  "relatedUserUuid": "uuid",
  "relatedClimbUuid": "uuid",
  "message": "string",
  "isRead": false,
  "createdAt": "ISO-8601",
}
```

> Confidence: LOW for individual fields; HIGH for the list endpoint.

### 5.11 Reporting and moderation

| Method | Path                | Purpose                                                     |
| ------ | ------------------- | ----------------------------------------------------------- |
| `POST` | `/api/report-climb` | Flag a climb (inappropriate content, broken hardware, etc.) |

**Report DTO**:

```jsonc
{
  "climbUuid": "uuid",
  "angle": 40,
  "reason": "inappropriate | broken_holds | offensive_name | other",
  "comment": "string",
}
```

> Confidence: HIGH path; MEDIUM shape.

### 5.12 Image upload

| Method | Path              | Purpose                                 |
| ------ | ----------------- | --------------------------------------- |
| `POST` | `/api/image`      | Upload an image (multipart/form-data)   |
| `GET`  | `/api/image/user` | List the current user's uploaded images |

> Confidence: HIGH for paths; MEDIUM for multipart shape.

---

## 6. PowerSync realtime layer

The Kilter app uses [PowerSync](https://www.powersync.com) to mirror the **reference catalog, `gyms`/`walls`, and per-user data** from Postgres into local SQLite. (The public climb catalog is the exception — it's REST-fetched, see [§1](#1-architecture-overview).) The protocol details, table inventory, and the PowerSync-vs-REST split live in [`KILTER_POWERSYNC_SPEC.md`](KILTER_POWERSYNC_SPEC.md).

Quick summary:

- **Sync service URL**: `https://sync1.kiltergrips.com`
- **Auth**: same Keycloak JWT as the REST API (no separate token-exchange step).
- **Transport**: PowerSync streaming sync over HTTPS with BSON-stream or NDJSON content negotiation; WebSocket as the alternative protocol.
- **Writes**: client-side mutations queue locally, then the SDK uploads them through the corresponding `/api/...` REST endpoints (often the `*-transaction` variants for multi-table writes). After REST success, the client posts to `write-checkpoint2.json` so the sync stream can confirm persistence.

See the sibling spec for the full bucket model and synced-table inventory.

---

## 7. Local SQLite schema (client-side mirror)

The four tables below are explicitly defined as `CREATE TABLE` statements; the rest of the synced schema is registered programmatically by PowerSync from the server-side sync rules.

### `climbs`

```sql
CREATE TABLE climbs (
  climb_uuid                  TEXT PRIMARY KEY,
  climb_concat                TEXT,
  name                        TEXT NOT NULL,
  description                 TEXT,
  edge_left                   INTEGER NOT NULL,
  edge_right                  INTEGER NOT NULL,
  edge_bottom                 INTEGER NOT NULL,
  edge_top                    INTEGER NOT NULL,
  frame_count                 INTEGER NOT NULL,
  frames_pace                 INTEGER NOT NULL,
  user_uuid                   TEXT NOT NULL,
  username                    TEXT NOT NULL,
  product_name                TEXT NOT NULL,
  product_layout_uuid         TEXT NOT NULL,
  allow_match                 INTEGER NOT NULL,
  is_draft                    INTEGER NOT NULL,
  is_listed                   INTEGER NOT NULL,
  angle                       INTEGER,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL,
  is_deleted                  INTEGER NOT NULL DEFAULT 0,
  accumulated_hold_set_value  INTEGER NOT NULL DEFAULT 0,
  curated                     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_climbs_product_draft_curated
  ON climbs(product_name, is_draft, curated);
```

### `climb_stats`

```sql
CREATE TABLE climb_stats (
  climb_uuid                 TEXT NOT NULL,
  angle                      INTEGER NOT NULL,
  ascent_count               INTEGER NOT NULL,
  current_difficulty_id      INTEGER NOT NULL,
  official_kilter_difficulty INTEGER,
  difficulty_average         REAL,
  quality_average            REAL,
  fa_username                TEXT,
  fa_at                      TEXT,
  curated                    INTEGER,
  PRIMARY KEY (climb_uuid, angle)
);

CREATE INDEX IF NOT EXISTS idx_climb_stats_angle_diff_uuid
  ON climb_stats(angle, current_difficulty_id, climb_uuid);
```

### `climbs_for_product_fetch_info`

```sql
CREATE TABLE IF NOT EXISTS climbs_for_product_fetch_info (
  product_name      TEXT NOT NULL,
  count             INTEGER NOT NULL,
  progress          INTEGER NOT NULL,
  edge_left         INTEGER NOT NULL,
  edge_right        INTEGER NOT NULL,
  edge_bottom       INTEGER NOT NULL,
  edge_top          INTEGER NOT NULL,
  last_updated_at   TEXT,
  PRIMARY KEY (product_name, edge_left, edge_right, edge_bottom, edge_top)
);
```

Tracks initial-fetch progress per product+region, used to drive the "preparing climbs" loading screen on first login.

### `product_layout_updates`

```sql
CREATE TABLE IF NOT EXISTS product_layout_updates (
  product_layout_uuid  TEXT PRIMARY KEY,
  updated_at           TEXT NOT NULL
);
```

Per-layout cache invalidation marker.

### `recently_tried_climbs`

```sql
CREATE TABLE IF NOT EXISTS recently_tried_climbs (
  climb_uuid           TEXT NOT NULL,
  angle                INTEGER NOT NULL,
  product_layout_uuid  TEXT NOT NULL,
  tried_at             TEXT NOT NULL,
  user_uuid            TEXT,
  PRIMARY KEY (climb_uuid, angle)
);
```

Local-only history table; not synced.

---

## 8. Third-party integrations

### Google Places (gym/wall location search)

- Base: `https://places.googleapis.com/v1`
- Calls used:
  - `POST https://places.googleapis.com/v1/places:autocomplete` (text-prefix autocomplete)
  - `GET https://places.googleapis.com/v1/places/{placeId}` (place details)
- Authentication: `X-Goog-Api-Key` header.

### Firebase

- Firebase Core, Firebase Analytics, and Firebase Installations are present for analytics and crash reporting. No custom Firestore / RTDB endpoints surface.

### Other plugins

- BLE for board control — see the Bluetooth spec.
- Device GPS for "gyms near me".
- Image capture + crop pipeline for profile/photo uploads.
- Share-sheet integration.
- External URL launcher (Instagram, Google Maps directions).
- `appauth` for the Keycloak OIDC flow.

---

## 9. Open questions

Gaps that need traffic capture or direct confirmation from Kilter to close:

1. **Exact `/v2/users/` semantics** — is it a versioning bump, an admin/internal namespace, or a paginated variant?
2. ~~**OAuth `client_id`**~~ — **Resolved**: `client_id=kilter`, `scope=openid offline_access` (see [§3](#3-authentication-keycloak--oidc)).
3. **Write JSON casing** — the checked catalog response is camelCase; mutation bodies remain unverified. PowerSync rows retain mixed source column casing.
4. **PUT vs PATCH for updates** — `*/update-climb/transaction` endpoints accept POST, but for simple updates (rating, settings) PUT vs PATCH cannot be distinguished from the path list alone.
5. **Catalog route drift** — Boardsesh's per-layout `/api/climbs/all/{productLayoutUuid}` and `/api/climb-stat/all/{productLayoutUuid}` reads were accepted in 2026-06-02. The packaged region route returned 404 in that check; recheck both routes when the service changes.
6. **Errors** — only `RegistrationError` is a typed model. Other endpoints probably return a generic shape (`{ "error": "...", "message": "..." }`) but this isn't established.
7. **Rate limits / pagination defaults** — no headers or limits surfaced.
8. **The two static pages at `app.kiltergrips.com`** — `/privacy` and `/terms` are the only routes seen.
