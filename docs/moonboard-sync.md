# MoonBoard Sync

`@boardsesh/moonboard-sync` is the MoonBoard-specific public location sync CLI. It exists because MoonBoard locations are not available through Aurora or Kilter Grips APIs.

## Public board locations

The CLI logs in to MoonBoard, calls the map marker endpoint, and writes public Boardsesh locations through `@boardsesh/location-sync`.

Each upstream marker creates:

- one deterministic system-owned `gyms` row
- one public, unowned `user_boards` row for every supported MoonBoard layout and angle

MoonBoard locations intentionally cover every configured layout, not just the 2016 setup. For each marker, the sync writes all layouts from `MOONBOARD_LAYOUTS` and all angles from `MOONBOARD_ANGLES`.

Rows are upserted by deterministic UUID. The sync does not delete rows that disappear upstream.

## CLI

```bash
moonboard-sync locations
moonboard-sync locations --username <email> --password <password> -v
```

Environment variables:

| Variable             | Required | Purpose                    |
| -------------------- | -------- | -------------------------- |
| `DATABASE_URL`       | yes      | Postgres connection string |
| `MOONBOARD_USERNAME` | yes      | MoonBoard account email    |
| `MOONBOARD_PASSWORD` | yes      | MoonBoard account password |

Run with 1Password:

```bash
op run --env-file=packages/moonboard-sync/.env.1password -- bunx moonboard-sync locations -v
```

The root `vp run db:seed-locations` task runs the Aurora, Kilter, and MoonBoard location CLIs instead of the removed GeoJSON seed script. Credentialed providers are safe in clean dev environments: Kilter and MoonBoard skip with a successful exit when their credentials are not configured.
