# PostGIS 3.7.0dev → 3.6.4 rehearsal

Evidence for Blocker 2 of the PostgreSQL 18 rollout. Run 2026-08-23 with
`vp run test:postgres18-spatial-rehearsal`; the script is
`scripts/postgres18-spatial-rehearsal.sh` and re-running it reproduces every number below.

## The question

`docs/postgres-18-migration.md` §1 blocks the catalog audit unless source and target PostGIS
versions are equal. Production reports `3.7.0dev` because the Railway service tracks the mutable
`postgis/postgis:16-master` tag; the attested PG18 artifact ships stable 3.6.4, and PGDG publishes no
stable 3.7 for PostgreSQL 18. `pg_extension.extversion` cannot be downgraded in place — PostGIS ships
no downgrade script — so "move one side to match the other" is not available in either direction.

The gate asks whether the versions are equal. The decision actually needs the narrower question:
**does everything this application does with PostGIS survive the step from 3.7.0dev to 3.6.4?**

## Method

No production contact, no credential, no dump of the 11 GB production database. Both endpoints are
throwaway containers on a private docker network with `POSTGRES_HOST_AUTH_METHOD=trust`, so there is
no secret involved at any point.

|                |                                                                                                                                                                                                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source         | `postgis/postgis:16-master` — the tag the Railway production service tracks                                                                                                                                                                                                                                     |
| Target         | built from `packages/db/docker/Dockerfile.postgres`, the same pinned inputs as the attested artifact                                                                                                                                                                                                            |
| Copy mechanics | the dump/restore flags, the byte-identical `pg_restore --list` awk filter, and the exit-status-and-any-diagnostic rule from `scripts/postgres-logical-replication.sh setup`. The real setup also carries the `drizzle` schema, which holds migration bookkeeping and no spatial object; this dumps `public` only |
| Clients        | PostgreSQL 18.4 `pg_dump`/`pg_restore`, run from inside the target image — newer client, older server                                                                                                                                                                                                           |

The fixture is the application's complete spatial surface, taken from the migrations that created it:
the two `geography(Point,4326)` columns (0052, 0054), both partial GiST indexes, and the
`set_location_from_coordinates()` trigger that derives the geography from lat/lng (0127). 500 rows per
table, half with a NULL location, so a copy that silently coerced NULL to a point could not pass.

Set `TARGET_IMAGE` to the attested digest to rehearse against the published artifact instead of a
local build. That needs `docker login ghcr.io` with a token carrying `read:packages` —
`ghcr.io/boardsesh/boardsesh-postgres-postgis` is not anonymously pullable, unlike the seeded dev
image.

## Versions observed

```
source: PostgreSQL 16.14, POSTGIS="3.7.0dev 3.6.0rc2-620-gb8c7b0142"
        GEOS="3.15.0dev-CAPI-1.21.0" PROJ="9.9.0"
target: PostgreSQL 18.4,  POSTGIS="3.6.4 94d984b"
        GEOS="3.11.1-CAPI-1.17.1" PROJ="9.8.1"
```

The step is wider than the PostGIS version alone — PROJ goes 9.9.0 → 9.8.1 — and the distance and
proximity checks cover that. GEOS also moves, 3.15.0dev → 3.11.1, but it is **not** exercised and does
not need to be: GEOS backs planar `geometry` operations, and this application uses none. Geography
distance and `ST_DWithin` run through PostGIS's own geodesic code in liblwgeom.

**The source build is not the build production runs.** The production audit recorded
`3.6.0rc2-339-g6d7299047`; this rehearsal ran `3.6.0rc2-620-gb8c7b0142`, roughly 280 commits of
PostGIS master later. That is the mutable-tag problem in miniature, and it is why
`docs/postgres-18-rollout-handover.md` §5 puts "pin the Railway image" ahead of the `wal_level`
restart. Once the pin lands, re-run with `SOURCE_IMAGE` set to production's pinned digest — one
command — and update this record.

## Result — 21 of 21 checks matched

| Check                                                              | Covers                                                                                                                            |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| row count, populated-geography count (both tables)                 | nothing dropped, NULLs stayed NULL                                                                                                |
| `format_type` of both `location` columns                           | `geography(Point,4326)` survived with its typmod                                                                                  |
| `ST_AsEWKB` digest over every populated row (both tables)          | the on-the-wire binary of all 500 geographies, byte for byte — the comparison `docs/postgres-18-migration.md` §1 asks for by name |
| `ST_AsText` digest over every populated row (both tables)          | the WKT rendering `packages/db/src/__tests__/location-trigger.integration.test.ts` asserts against                                |
| whole-row digest, `sum(hashtextextended(row_to_json(t)::text, 0))` | the repo's own cutover drift detector, `scripts/postgres-table-digests.sql`                                                       |
| no `ENABLE ALWAYS`/`REPLICA` trigger on either table               | the premise that `--disable-triggers` models logical-replication apply                                                            |
| `pg_indexes.indexdef` for both partial GiST indexes                | predicates and opclass survived verbatim                                                                                          |
| proximity probe discriminates — 17 of 194 eligible rows            | the `ST_DWithin` comparison below is not 0 == 0                                                                                   |
| `ST_DWithin` proximity count                                       | the geodesic predicate agrees across versions, on a query with both matches and non-matches                                       |
| `ST_Distance` aggregate over every populated row                   | PROJ/liblwgeom produce identical geodesic distances                                                                               |
| `EXPLAIN` on the target names `using gyms_location_idx`            | the partial GiST index is chosen, not scanned past                                                                                |
| trigger probe: insert the same lat/lng on both sides               | plpgsql `ST_MakePoint(...)::geography` yields an identical geography under 3.6.4                                                  |

The digests are sensitive, not decorative: moving a single coordinate by 1e-7 degrees (~1 cm) on one
of the 250 populated rows changes both the EWKB digest and the row digest.

An earlier version of this rehearsal reported a passing `ST_DWithin` check that proved nothing — the
probe point sat 4,345 km from the nearest fixture row against a 2,000 km radius, so the count was 0 on
both sides and no candidate ever reached the geodesic predicate. The discrimination check above is
what stops that recurring: the answer must be a strict subset of the eligible rows, so neither an
empty result nor "everything" can pass.

## What this does and does not settle

**Settles:** nothing in the Boardsesh spatial surface depends on anything 3.7.0dev provides that 3.6.4
does not. Values, types, index definitions, index selection, geodesic results and the derivation
trigger all cross unchanged. The 3.7.0dev build is a consequence of tracking a `master` tag, not of
any feature this application uses.

**Does not settle:** this is not the §4 rehearsal. No whole-catalog cross-major DDL fingerprint
comparison, no sequence fence, no failback drill, and no real production data. Those remain the hard
external gate, and the fixture necessarily reflects what the audit found rather than whatever
production actually contains.

**Keeping the claim true.** "The application's whole spatial surface" is a statement about the
repository, and it decays. `scripts/postgres18-spatial-surface.test.sh` is the mechanism that keeps it
honest: it inventories every `ST_*` call site in first-party SQL and TypeScript, plus every migration
that adds a geography column, and fails when either grows past what the rehearsal exercises. Today
that surface is exactly `ST_MakePoint`, `ST_Distance`, `ST_DWithin` and `ST_AsText`, over `gyms` and
`user_boards`. It runs inside `vp run test:postgres18-contract`, so a new spatial migration trips it.
A new spatial _resolver_ only trips it on the next run of that workflow, since
`packages/backend/**` is not in the `&database_image_paths` filter — a gap worth closing if the
backend starts doing more with geography.

Re-run the rehearsal itself when: the Railway image pin changes, `Dockerfile.postgres` moves the
PostGIS version, or the surface test above fails.

## Two things the rehearsal turned up on the way

**The schema-owner step is load-bearing.** Restoring without
`ALTER SCHEMA public OWNER TO boardsesh_owner` fails on `COMMENT ON SCHEMA public IS 'standard public
schema'` — the awk filter drops `COMMENT - EXTENSION` entries but not `COMMENT - SCHEMA`, and the
restore runs as the owner role. `postgres-logical-replication.sh` already does the ALTER; this is a
note for anyone reproducing the steps by hand from the runbook.

**`pg_dump`/`pg_restore` of this database fails today, on any PostgreSQL version.** `pg_restore`
emits `SELECT pg_catalog.set_config('search_path', '', false)`, and migration 0127's
`set_location_from_coordinates()` has `proconfig` NULL, so its unqualified `geography` cast cannot
resolve while the trigger fires during `COPY`:

```
pg_restore: error: COPY failed for table "gyms": ERROR:  type "geography" does not exist
CONTEXT:  PL/pgSQL function public.set_location_from_coordinates() line 4 at assignment
```

This does not affect the cutover copy — logical replication does not fire ordinary triggers on the
subscriber — but it does affect the shadow-period gate "backup/restore of PG18 succeeds
independently" and the failback drill. Filed as #4699; the fix is one
`ALTER FUNCTION ... SET search_path` on that function. Until it lands, a restore drill must pass `--disable-triggers`, which needs a superuser.
The rehearsal restores with `--disable-triggers` for exactly that reason, which also happens to be
the faithful model of logical-replication apply.
