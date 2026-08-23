# PostGIS usage audit — Railway production (read-only), 2026-08-23

Source: PostgreSQL 16.9, PostGIS 3.7.0dev (3.6.0rc2-339-g6d7299047), GEOS 3.15.0dev
Target artifact: PostgreSQL 18.4, PostGIS 3.6.4 (newest PGDG offers for PG18)

## Actual spatial usage: two columns

| Column | Type | Rows | Populated |
|---|---|---|---|
| `public.gyms.location` | `geography(Point,4326)` | 4875 | 3114 |
| `public.user_boards.location` | `geography(Point,4326)` | 6375 | 3318 |

Two partial GiST indexes:
- `gyms_location_idx` — `USING gist (location) WHERE deleted_at IS NULL AND is_public = true`
- `user_boards_location_gist_idx` — `USING gist (location) WHERE is_public = true AND deleted_at IS NULL`

No geometry, raster, or topogeometry columns anywhere in the app schemas.

## tiger / topology are empty scaffolding

- `tiger.geocode_settings`: 0 rows
- live tuples across `tiger`, `tiger_data`, `topology`: 0

`postgis_tiger_geocoder` (120 objects) and `postgis_topology` (10 objects) are installed but never used. Not installing them on the target removes 130 objects from the migration surface.

## Assessment

`geography(Point,4326)` and GiST indexing are among the oldest, most stable parts of PostGIS — unchanged in API and on-disk representation across 3.x. Nothing here uses a 3.7-only feature, because nothing here uses anything beyond point storage and proximity indexing.

Production is on a development build only because the Railway service tracks `postgis/postgis:16-master` with auto-updates enabled. That drift bought nothing and is what makes the version comparison look alarming.

## Available PostGIS for PG18 (PGDG bookworm-pgdg, amd64)

    3.6.2+dfsg-1.pgdg12+1
    3.6.3+dfsg-1.pgdg12+1
    3.6.4+dfsg-2.pgdg12+1   <- newest, what the attested image ships

There is no stable 3.7 release to target.
