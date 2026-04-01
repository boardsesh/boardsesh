# Kilter Sync

This document describes how user data is synced from the new Kilter API (portal.kiltergrips.com) to the Boardsesh database using the `@boardsesh/kilter-sync` package.

## Background

In early 2026, the original Kilter backend (`kilterboardapp.com`) was shut down and replaced by a new platform at `portal.kiltergrips.com`. The new backend uses:

- **OAuth2/Keycloak** authentication instead of the old `/sessions` cookie-based auth
- A new REST API at `portal.kiltergrips.com/api`
- A sync stream endpoint at `sync1.kiltergrips.com/sync/stream`

The `@boardsesh/kilter-sync` package implements Boardsesh's integration with this new API, separate from the `@boardsesh/aurora-sync` package which handles Tension (and previously Kilter).

Our approach is based on the analysis of the new Kilter API documented in [ruairica/kilter-app-migration](https://github.com/ruairica/kilter-app-migration), a community migration tool that helped map out the new OAuth2 endpoints and data formats.

## Architecture

```
┌─────────────────┐     ┌───────────────────────────────┐
│  External Cron  │────▶│  Vercel / Railway              │
│  (cron-job.org) │     │  GET /api/internal/             │
└─────────────────┘     │      kilter-sync-cron          │
                        └──────────────┬────────────────┘
                                       │
                    ┌──────────────────┤
                    ▼                  ▼
          ┌─────────────────┐  ┌─────────────────┐
          │  Kilter IDP     │  │  Kilter Sync    │
          │  (Keycloak)     │  │  Stream         │
          │  idp.kilter     │  │  sync1.kilter   │
          │  grips.com      │  │  grips.com      │
          └─────────────────┘  └─────────────────┘
                                       │
                                       ▼
                              ┌─────────────────┐
                              │  Neon Database   │
                              └─────────────────┘
```

## How It Differs from Aurora Sync

| Aspect | Aurora Sync (Tension) | Kilter Sync |
|--------|----------------------|-------------|
| Auth | Cookie token via `/sessions` | OAuth2 JWT via Keycloak IDP |
| User ID | Numeric (from login response) | UUID in JWT `sub` claim; numeric ID discovered from sync |
| Sync URL | `tensionboardapp2.com/sync` | `sync1.kiltergrips.com/sync/stream` |
| Auth header | `Cookie: token=...` | `Authorization: Bearer ...` |
| REST API | `api.kilterboardapp.com/v1` | `portal.kiltergrips.com/api` |
| Package | `@boardsesh/aurora-sync` | `@boardsesh/kilter-sync` |

## Authentication Flow

1. **POST** credentials to Keycloak IDP:
   ```
   POST https://idp.kiltergrips.com/realms/kilter/protocol/openid-connect/token
   Content-Type: application/x-www-form-urlencoded

   grant_type=password&client_id=kilter-app&username=...&password=...
   ```

2. **Receive** a JWT `access_token` in the response.

3. **Decode** the JWT payload to extract the user's UUID from the `sub` claim. The signature is not verified since the token was received directly from the IDP over HTTPS.

4. **Use** the token as a Bearer token for all API calls:
   ```
   Authorization: Bearer <access_token>
   ```

## Numeric User ID Discovery

The OAuth2 JWT provides a UUID, but the sync stream data still uses numeric Aurora user IDs internally (for `user_syncs`, walls, tags, circuits). On the first sync:

1. We pass `user_id: 0` in the sync request timestamps
2. The sync response's `user_syncs` array contains the real numeric `user_id`
3. We extract it and back-populate `auroraCredentials.auroraUserId`
4. Subsequent syncs use the correct numeric ID

## Incremental Sync

The sync stream works identically to the old Aurora `/sync` endpoint:

1. Send table timestamps as URL-encoded form data (Bearer auth instead of Cookie)
2. Server returns only data changed since last sync
3. Response uses `_complete` flag for pagination
4. Batched upserts (100 rows per INSERT) into the unified board tables

### Tables Synced

| Sync Table | Database Target | Dual Write |
|------------|----------------|------------|
| users | board_users | - |
| walls | board_walls | - |
| draft_climbs | board_climbs | - |
| ascents | boardsesh_ticks | - |
| bids | boardsesh_ticks | - |
| tags | board_tags | - |
| circuits | board_circuits | playlists, playlist_climbs |

## Package Structure

```
packages/kilter-sync/
├── src/
│   ├── api/
│   │   ├── kilter-client.ts      # OAuth2 client, JWT decode, API methods
│   │   ├── kilter-sync-api.ts    # Sync stream wrapper
│   │   ├── types.ts              # TypeScript types
│   │   └── index.ts
│   ├── sync/
│   │   ├── user-sync.ts          # User data sync (upserts, batching)
│   │   ├── convert-quality.ts    # Quality scale conversion (1-3 → 1-5)
│   │   └── index.ts
│   ├── runner/
│   │   ├── sync-runner.ts        # KilterSyncRunner (credential management)
│   │   ├── types.ts
│   │   └── index.ts
│   ├── db/
│   │   └── table-select.ts       # Unified table references
│   └── index.ts
├── package.json
└── tsconfig.json
```

## Integration Points

### Credential Storage

Kilter credentials are stored in the same `aurora_credentials` table as Tension, with `board_type = 'kilter'`. The encrypted username and password are used to obtain fresh OAuth2 tokens on each sync.

### Cron Endpoint

```
GET /api/internal/kilter-sync-cron
Authorization: Bearer <CRON_SECRET>
```

Syncs one Kilter user per invocation (oldest `lastSyncAt` first). This is separate from the Aurora sync cron which handles Tension.

### Account Linking UI

The Settings page "Link" button for Kilter uses the same dialog as Tension but routes through the `KilterClient.signIn()` OAuth2 flow in the credentials API route.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `AURORA_CREDENTIALS_SECRET` | Encryption key for stored credentials |
| `CRON_SECRET` | Bearer token for authenticating cron requests |

## Troubleshooting

### "Invalid username or password" on link

The Keycloak IDP returns 400/401 for bad credentials. Verify the user can log in at portal.kiltergrips.com directly.

### auroraUserId shows as 0

This is expected on the first link. The numeric ID is populated after the first successful sync. If it stays at 0 after sync, check the sync logs for errors from `sync1.kiltergrips.com`.

### Sync stream returns empty data

The Bearer token may have expired. The cron job obtains a fresh token on each run. If running manually, ensure the token is recent.
