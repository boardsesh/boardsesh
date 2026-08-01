# MoonBoard Sync

`@boardsesh/moonboard-sync` is the MoonBoard-specific public location sync CLI and daemon. It exists because MoonBoard locations are not available through Aurora or Kilter Grips APIs.

## Public board locations

The CLI logs in to MoonBoard, calls the map marker endpoint, and writes public Boardsesh locations through `@boardsesh/location-sync`.

Each upstream marker creates:

- one deterministic system-owned `gyms` row
- one public, unowned `user_boards` row for every supported MoonBoard layout and angle

MoonBoard locations intentionally cover every configured layout, not just the 2016 setup. For each marker, the sync writes all layouts from `MOONBOARD_LAYOUTS` and all angles from `MOONBOARD_ANGLES`.

Rows are upserted by deterministic UUID. The sync does not delete rows that disappear upstream.

A human edit or deletion freezes that row by setting `sync_frozen_at`, so later source pulls cannot overwrite it. A global admin can release the freeze from `/admin/location-sync`; the action clears only the marker, requires a recorded reason, and writes `location_sync_unfreeze_audit`. The separate gym-owner/approved-claim guard remains in force. There is no MoonBoard location schedule in production today: operators run `moonboard-sync locations` by hand. So a released freeze changes nothing on its own — the next manual run is what may refresh or resurrect the matching row.

## Gym identity (source keys)

MoonBoard's `GetMapMarkers` payload has **no upstream id** — only a name and coordinates. A gym's stable identity is therefore derived from its name plus a coarse location cell:

```
moonboard:<normalized name>:<lat cell>:<lng cell>
```

`<lat cell>`/`<lng cell>` are integer hundredths of a degree (`Math.round(coord * 100)`), a ~1.1 km north-south grid. The name is normalized (lowercase, single-spaced) so casing/whitespace jitter can't split one gym into two identities; the human-readable name is stored separately for display.

Why not full-precision coordinates: they made the key change on every pin nudge, so any move beyond the 20 m physical-match tier minted a permanent duplicate gym — a 20-150 m move tripped the same-provider guard, a larger move missed the match radius entirely (issue #3715). Why not the name alone: genuinely distinct gyms share names (the prod collisions — e.g. "MoonBoard" vs "Moonboard" — sit thousands of km apart), and a name-only key would merge them into one flip-flopping gym.

The coarse cell keeps the key stable across the whole realistic pin-correction range while keeping far-apart same-named gyms distinct. The rare correction that crosses a cell boundary **and** lands in the 20-150 m band mints one twin that surfaces in `/admin/gym-duplicates` for a human merge — the fallback is a manual merge, never a silently wrong one.

When the sync first runs against a database whose MoonBoard gyms were seeded without source aliases (as in prod today), each marker resolves its existing gym through the name + location physical match and adopts it (aliases the stable key onto it), so no separate backfill migration is needed.

## CLI

```bash
moonboard-sync locations
moonboard-sync locations --username <email> --password <password> -v
moonboard-sync daemon --skip-if-missing-credentials
```

`daemon` runs one location sync immediately during active hours, then repeats every six to eight hours with jitter. It uses the shared Postgres daemon lease under the `moonboard-sync` key, so a second container stays in standby during a rolling deploy and takes over when the active process releases or loses the lease. The location writes remain idempotent because the lease is an overlap reduction mechanism, not a correctness lock.

The combined `boardsesh-sync` image includes this command. The production sync host must run a separate service with:

```bash
bunx tsx packages/moonboard-sync/src/cli/index.ts daemon --skip-if-missing-credentials
```

Branch deploys do not run this daemon; they continue using the location snapshot in the dev database image.

Environment variables:

| Variable             | Required | Purpose                    |
| -------------------- | -------- | -------------------------- |
| `DATABASE_URL`       | yes      | Postgres connection string |
| `MOONBOARD_USERNAME` | yes      | MoonBoard account email    |
| `MOONBOARD_PASSWORD` | yes      | MoonBoard account password |

Run with 1Password:

```bash
op run --env-file=packages/moonboard-sync/.env.1password -- vp exec moonboard-sync locations -v
```

The root `vp run db:seed-locations` task runs the Aurora, Kilter, and MoonBoard location CLIs instead of the removed GeoJSON seed script. Credentialed providers are safe in clean dev environments: Kilter and MoonBoard skip with a successful exit when their credentials are not configured.

## First production run

The first scheduled run needs an operator check because production's April 2026 MoonBoard seed predates source aliases:

1. Record the current MoonBoard gym, board, and `moonboard:` source-alias counts.
2. Configure `MOONBOARD_USERNAME` and `MOONBOARD_PASSWORD` on the sync host and start the daemon service.
3. Confirm the sync adopts the seeded gyms through name-and-location matching and creates aliases without creating a second set of gyms.
4. Inspect `/admin/gym-duplicates` for the rare pin correction that crossed a coarse source-key cell. Verify and merge any real twins manually.
5. Check a later daemon cycle updates the same aliases and leaves duplicate counts stable.

The repository provides the runner and container command. Sync-host service configuration, credentials, and these production data checks are deployment steps and are not performed by CI.
