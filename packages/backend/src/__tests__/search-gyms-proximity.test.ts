import { describe, it, expect, beforeAll, beforeEach } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import { rowsFromResult } from '@boardsesh/db/client';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialGymQueries } from '../graphql/resolvers/social/gyms';

/**
 * Real-database coverage for `searchGyms`'s PostGIS proximity branch — the one
 * mobile's `useNearbyGyms` picker and the web directory's "near me" view both
 * run in production, and the only branch of the resolver that had never touched
 * a real database.
 *
 * Why it could not exist before: `gyms.location` is a `geography(Point, 4326)`
 * added by raw migration (drizzle/0052, 0054, 0127), so it lives outside the
 * Drizzle schema and never reached the hand-maintained test DDL. The tail of
 * schema-sql.ts now creates the extension, both `location` columns, the GIST
 * indexes and the 0127 derivation trigger — guarded, so a server without PostGIS
 * still gets its 70-odd tables and these tests self-skip.
 *
 * Everything here seeds plain `latitude`/`longitude` and lets the trigger derive
 * the geography, because that is exactly what production does — a test that set
 * `location` by hand would pass while the derivation the resolver depends on was
 * broken.
 */

const OWNER = 'proximity-owner';

// Amsterdam. Every fixture is placed due north of it, so the distance between a
// gym and the search point is a plain meridian arc: 1 degree of latitude here is
// ~111.28 km, which is what makes the boundary pair below predictable.
const SEARCH_LAT = 52.3791;
const SEARCH_LON = 4.9003;
const METRES_PER_DEGREE_LATITUDE = 111_276;

/** Latitude that sits `metres` due north of the search point. */
const latitudeNorthOf = (metres: number) => SEARCH_LAT + metres / METRES_PER_DEGREE_LATITUDE;

// `gyms.hours_updated_at` is `timestamp` WITHOUT time zone, so the driver hands
// back a wall-clock reading carrying no offset and `new Date(...)` resolves it in
// the process's zone. Written and asserted in that same zone-free form, so the
// assertion below does not quietly depend on the host running UTC.
const HOURS_UPDATED_AT = '2026-02-03 10:30:00';

const anonCtx = (): ConnectionContext => ({ connectionId: 'conn-anon', isAuthenticated: false }) as ConnectionContext;

type SearchResult = {
  gyms: Array<{
    uuid: string;
    slug: string | null;
    name: string;
    hours: string | null;
    hoursUpdatedAt: string | null;
    createdAt: string;
    latitude: number | null;
    longitude: number | null;
    address: string | null;
    website: string | null;
    boardTypes: string[];
  }>;
  totalCount: number;
  hasMore: boolean;
};

const searchNearby = (input: Record<string, unknown>) =>
  socialGymQueries.searchGyms(
    null,
    { input: { latitude: SEARCH_LAT, longitude: SEARCH_LON, ...input } },
    anonCtx(),
  ) as Promise<SearchResult>;

/** The Drizzle branch — no coordinates, so `useProximity` is false. */
const searchText = (input: Record<string, unknown>) =>
  socialGymQueries.searchGyms(null, { input }, anonCtx()) as Promise<SearchResult>;

/**
 * Drop the two fields the branches are KNOWN to disagree on, so the rest can be
 * compared strictly. Not a convenience — it is carving a known bug (#4588,
 * `timestamp` without time zone read in two different zones) out of an otherwise
 * exact equality. Delete this helper when #4588 lands.
 */
const withoutFieldsDivergingOnBug4588 = (gym: SearchResult['gyms'][number]) => {
  const comparable: Record<string, unknown> = { ...gym };
  delete comparable.hoursUpdatedAt;
  // Same defect, same cause: `created_at` is `timestamp` without time zone too,
  // so it skews by the host offset in exactly the same way. Checked separately
  // below for the thing that would actually 500 the query — that it parses.
  delete comparable.createdAt;
  return comparable;
};

const insertGym = async (opts: {
  name: string;
  /** Metres due north of the search point. Omit for a gym with no coordinates. */
  metresNorth?: number;
  slug?: string | null;
  isPublic?: boolean;
  softDeleted?: boolean;
  address?: string | null;
  hours?: string | null;
  hoursUpdatedAt?: string | null;
  website?: string | null;
}): Promise<{ id: number; uuid: string }> => {
  const { name, metresNorth, isPublic = true, softDeleted = false } = opts;
  const uuid = uuidv4();
  const slug = opts.slug === undefined ? uuid : opts.slug;
  const hasCoordinates = metresNorth !== undefined;
  const result = await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public, latitude, longitude,
                      address, website, hours, hours_updated_at, deleted_at, created_at, updated_at)
    VALUES (${uuid}, ${name}, ${slug}, ${OWNER}, ${isPublic},
            ${hasCoordinates ? latitudeNorthOf(metresNorth) : null},
            ${hasCoordinates ? SEARCH_LON : null},
            ${opts.address ?? null}, ${opts.website ?? null}, ${opts.hours ?? null},
            ${opts.hoursUpdatedAt ? sql`${opts.hoursUpdatedAt}::timestamp` : sql`NULL`},
            ${softDeleted ? sql`now()` : sql`NULL`}, now(), now())
    RETURNING id
  `);
  return { id: Number(rowsFromResult<{ id: number }>(result)[0].id), uuid };
};

const insertBoard = async (gymId: number, boardType: string): Promise<void> => {
  const uuid = uuidv4();
  await db.execute(sql`
    INSERT INTO user_boards
      (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, angle, gym_id, is_public, created_at, updated_at)
    VALUES (${uuid}, ${uuid}, ${OWNER}, ${boardType}, 1, 10, '1,2', 'Wall', 40, ${gymId}, true, now(), now())
  `);
};

const locationTextOf = async (gymUuid: string): Promise<string | null> => {
  const result = await db.execute(sql`SELECT ST_AsText(location::geometry) AS wkt FROM gyms WHERE uuid = ${gymUuid}`);
  return rowsFromResult<{ wkt: string | null }>(result)[0]?.wkt ?? null;
};

/**
 * Whether this worker's database actually has PostGIS. Only knowable after the
 * schema apply, which is why the tests below skip at runtime rather than through
 * `it.skipIf` (evaluated while the file is still being collected).
 */
let hasPostGis = false;

const requirePostGis = (ctx: { skip: () => void }) => {
  if (!hasPostGis) ctx.skip();
};

beforeAll(async () => {
  const result = await db.execute(sql`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS present`);
  hasPostGis = rowsFromResult<{ present: boolean }>(result)[0]?.present === true;
});

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "gym_members", "gym_follows", "gym_claims",
      "board_follows", "boardsesh_ticks", "user_boards", "gyms", "notifications"
    RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${OWNER}, ${OWNER + '@test.com'}, 'Proximity Owner', now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
});

describe('searchGyms proximity', () => {
  // Unconditional, so the whole file can never go quietly dark: if the CI
  // database ever loses PostGIS, every other test here would report a tidy
  // "skipped" and the job would stay green with zero proximity coverage.
  it('asserts PostGIS is present when running in CI', (ctx) => {
    // Reports as skipped off CI rather than passing as a no-op — the rest of the
    // file already signals that way. Under CI it always runs, which is the whole
    // point: without it, a CI database that lost PostGIS would skip all fifteen
    // cases below and leave the job green with zero proximity coverage.
    if (!process.env.CI) ctx.skip();
    expect(hasPostGis).toBe(true);
  });

  it('derives the geography from latitude/longitude on insert', async (ctx) => {
    requirePostGis(ctx);
    // The resolver filters `location IS NOT NULL` and nothing in the write path
    // sets that column — the 0127 trigger does. If it stops firing, proximity
    // search returns nothing at all and every assertion below would still pass
    // for the wrong reason, so pin the derivation itself first.
    const gym = await insertGym({ name: 'Derived', metresNorth: 0 });
    expect(await locationTextOf(gym.uuid)).toBe(`POINT(${SEARCH_LON} ${SEARCH_LAT})`);
  });

  it('keeps a gym just inside the radius and drops the one just outside it', async (ctx) => {
    requirePostGis(ctx);
    // ~100m either side of a 10km radius. A sloppier pair (5km vs 60km) passes
    // even if the radius is out by a factor of two.
    const inside = await insertGym({ name: 'Inside Edge', metresNorth: 9_900 });
    await insertGym({ name: 'Outside Edge', metresNorth: 10_100 });

    const result = await searchNearby({ radiusKm: 10, limit: 50 });

    expect(result.gyms.map((gym) => gym.uuid)).toEqual([inside.uuid]);
    expect(result.totalCount).toBe(1);
    expect(result.hasMore).toBe(false);
  });

  it('widening the radius pulls the far gym back in', async (ctx) => {
    requirePostGis(ctx);
    // The mirror of the case above: proves the cut-off tracks `radiusKm` rather
    // than the excluded gym being unreachable for some other reason.
    const inside = await insertGym({ name: 'Inside Edge', metresNorth: 9_900 });
    const outside = await insertGym({ name: 'Outside Edge', metresNorth: 10_100 });

    const result = await searchNearby({ radiusKm: 11, limit: 50 });

    expect(result.gyms.map((gym) => gym.uuid).sort()).toEqual([inside.uuid, outside.uuid].sort());
    expect(result.totalCount).toBe(2);
  });

  it('returns gyms nearest first', async (ctx) => {
    requirePostGis(ctx);
    // Inserted furthest-first, so a resolver that fell back to insertion order
    // or created_at would produce the exact reverse of the expectation.
    const far = await insertGym({ name: 'Far', metresNorth: 30_000 });
    const middle = await insertGym({ name: 'Middle', metresNorth: 12_000 });
    const near = await insertGym({ name: 'Near', metresNorth: 400 });

    const result = await searchNearby({ radiusKm: 50, limit: 50 });

    expect(result.gyms.map((gym) => gym.uuid)).toEqual([near.uuid, middle.uuid, far.uuid]);
  });

  it('pages by distance with totalCount reporting the whole match set', async (ctx) => {
    requirePostGis(ctx);
    // The count and the rows are two separate `db.execute` statements that agree
    // only because they interpolate the same filter clause. Paging is where a
    // disagreement surfaces: a predicate on one and not the other leaves the
    // directory advertising a page that does not exist.
    const distances = [500, 1_500, 2_500, 3_500];
    const seeded = [];
    for (const metresNorth of distances) {
      seeded.push(await insertGym({ name: `Gym at ${metresNorth}m`, metresNorth }));
    }

    const firstPage = await searchNearby({ radiusKm: 10, limit: 2, offset: 0 });
    expect(firstPage.totalCount).toBe(4);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.gyms.map((gym) => gym.uuid)).toEqual([seeded[0].uuid, seeded[1].uuid]);

    const secondPage = await searchNearby({ radiusKm: 10, limit: 2, offset: 2 });
    expect(secondPage.totalCount).toBe(4);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.gyms.map((gym) => gym.uuid)).toEqual([seeded[2].uuid, seeded[3].uuid]);

    // And a single-row window lands on the second-nearest, not the second-inserted.
    const window = await searchNearby({ radiusKm: 10, limit: 1, offset: 1 });
    expect(window.gyms.map((gym) => gym.uuid)).toEqual([seeded[1].uuid]);
    expect(window.totalCount).toBe(4);
  });

  it('pages cleanly over gyms sharing one distance — no duplicates, no skips', async (ctx) => {
    requirePostGis(ctx);
    // A bulk import parks several gyms on one address, so `distance_meters` ties
    // exactly. Without `gyms.id` as a second sort key those rows have no defined
    // order and Postgres may return them differently per OFFSET page: one gym
    // appears twice, another never appears.
    const seeded = [];
    for (let index = 0; index < 6; index++) {
      seeded.push(await insertGym({ name: `Same Address ${index}`, metresNorth: 1_000 }));
    }

    const walk = async () => {
      const uuids: string[] = [];
      for (let offset = 0; offset < 6; offset += 2) {
        const page = await searchNearby({ radiusKm: 10, limit: 2, offset });
        expect(page.totalCount).toBe(6);
        uuids.push(...page.gyms.map((gym) => gym.uuid));
      }
      return uuids;
    };

    const firstWalk = await walk();
    expect(firstWalk).toHaveLength(6);
    expect(new Set(firstWalk).size).toBe(6);
    // Stable, not merely unique — a shuffled-but-complete result would pass the
    // uniqueness check alone while still breaking infinite scroll.
    expect(await walk()).toEqual(firstWalk);
  });

  it('never returns a gym with no coordinates', async (ctx) => {
    requirePostGis(ctx);
    const located = await insertGym({ name: 'Located', metresNorth: 1_000 });
    const unlocated = await insertGym({ name: 'No Coordinates' });

    expect(await locationTextOf(unlocated.uuid)).toBeNull();

    const result = await searchNearby({ radiusKm: 500, limit: 50 });
    expect(result.gyms.map((gym) => gym.uuid)).toEqual([located.uuid]);
    // The count statement carries `location IS NOT NULL` too — if only the rows
    // statement did, the directory would show one card under a header of two.
    expect(result.totalCount).toBe(1);
  });

  it('drops a gym as soon as its coordinates are cleared', async (ctx) => {
    requirePostGis(ctx);
    // The UPDATE arm of the trigger. Clearing lat/lng has to clear the geography,
    // or a gym that removed its address stays pinned to the map forever.
    const gym = await insertGym({ name: 'Moving Out', metresNorth: 1_000 });
    expect((await searchNearby({ radiusKm: 10, limit: 50 })).totalCount).toBe(1);

    await db.execute(sql`UPDATE gyms SET latitude = NULL, longitude = NULL WHERE id = ${gym.id}`);

    expect(await locationTextOf(gym.uuid)).toBeNull();
    const result = await searchNearby({ radiusKm: 10, limit: 50 });
    expect(result.gyms).toHaveLength(0);
    expect(result.totalCount).toBe(0);
  });

  it('leaves private and soft-deleted gyms out of both the rows and the count', async (ctx) => {
    requirePostGis(ctx);
    const visible = await insertGym({ name: 'Visible', metresNorth: 1_000 });
    await insertGym({ name: 'Private', metresNorth: 1_100, isPublic: false });
    await insertGym({ name: 'Deleted', metresNorth: 1_200, softDeleted: true });

    const result = await searchNearby({ radiusKm: 10, limit: 50 });
    expect(result.gyms.map((gym) => gym.uuid)).toEqual([visible.uuid]);
    expect(result.totalCount).toBe(1);
  });

  it('requireSlug drops a slugless gym from the rows and the count together', async (ctx) => {
    requirePostGis(ctx);
    const slugged = await insertGym({ name: 'Slugged', metresNorth: 1_000, slug: 'slugged-gym' });
    await insertGym({ name: 'Null Slug', metresNorth: 1_100, slug: null });
    await insertGym({ name: 'Empty Slug', metresNorth: 1_200, slug: '' });

    const unfiltered = await searchNearby({ radiusKm: 10, limit: 50 });
    expect(unfiltered.totalCount).toBe(3);

    const filtered = await searchNearby({ radiusKm: 10, limit: 50, requireSlug: true });
    expect(filtered.gyms.map((gym) => gym.uuid)).toEqual([slugged.uuid]);
    // The point the rendered-SQL test in search-gyms-require-slug-sql.test.ts
    // could only approximate: the predicate reaches the count statement too, so
    // `totalCount` falls by exactly the two excluded rows.
    expect(filtered.totalCount).toBe(1);
    expect(filtered.hasMore).toBe(false);
  });

  it('ANDs a text query with the radius rather than widening it', async (ctx) => {
    requirePostGis(ctx);
    const nearMatch = await insertGym({ name: 'Klimmuur Centraal', metresNorth: 1_000 });
    await insertGym({ name: 'Other Gym', metresNorth: 1_100 });
    await insertGym({ name: 'Klimmuur Noord', metresNorth: 40_000 });

    const result = await searchNearby({ radiusKm: 10, limit: 50, query: 'Klimmuur' });
    expect(result.gyms.map((gym) => gym.uuid)).toEqual([nearMatch.uuid]);
    expect(result.totalCount).toBe(1);
  });

  it('matches a text query against the address on the proximity path', async (ctx) => {
    requirePostGis(ctx);
    const byAddress = await insertGym({ name: 'Anonymous Gym', metresNorth: 1_000, address: 'Jan Rebelstraat 20' });
    await insertGym({ name: 'Another Gym', metresNorth: 1_100, address: 'Overtoom 1' });

    const result = await searchNearby({ radiusKm: 10, limit: 50, query: 'Rebelstraat' });
    expect(result.gyms.map((gym) => gym.uuid)).toEqual([byAddress.uuid]);
  });

  it('applies the boardTypes filter inside the radius', async (ctx) => {
    requirePostGis(ctx);
    const kilterGym = await insertGym({ name: 'Kilter Gym', metresNorth: 1_000 });
    const tensionGym = await insertGym({ name: 'Tension Gym', metresNorth: 1_100 });
    await insertGym({ name: 'Boardless Gym', metresNorth: 1_200 });
    await insertBoard(kilterGym.id, 'kilter');
    await insertBoard(tensionGym.id, 'tension');

    const result = await searchNearby({ radiusKm: 10, limit: 50, boardTypes: ['kilter'] });
    expect(result.gyms.map((gym) => gym.uuid)).toEqual([kilterGym.uuid]);
    expect(result.gyms[0].boardTypes).toEqual(['kilter']);
    expect(result.totalCount).toBe(1);
  });

  it('maps every column the response reads off the raw SELECT *', async (ctx) => {
    requirePostGis(ctx);
    // This branch hydrates rows by hand from snake_case keys (`mapRawGymRow`)
    // instead of going through the Drizzle query builder, and it has silently
    // lost fields that way twice (#3431 website_vouched_by_owner, then
    // hours_updated_at). A camelCase typo type-checks and maps to null forever
    // here while the text-search path keeps rendering the field correctly.
    const gym = await insertGym({
      name: 'Fully Populated',
      metresNorth: 1_000,
      slug: 'fully-populated',
      address: 'Jan Rebelstraat 20',
      website: 'https://example.com',
      hours: 'Mon-Fri 09:00-23:00',
      hoursUpdatedAt: HOURS_UPDATED_AT,
    });

    const [mapped] = (await searchNearby({ radiusKm: 10, limit: 50 })).gyms;
    const [viaTextPath] = (await searchText({ limit: 50 })).gyms;

    expect(mapped.uuid).toBe(gym.uuid);
    expect(mapped.slug).toBe('fully-populated');
    expect(mapped.name).toBe('Fully Populated');
    expect(mapped.address).toBe('Jan Rebelstraat 20');
    expect(mapped.website).toBe('https://example.com');
    expect(mapped.hours).toBe('Mon-Fri 09:00-23:00');
    expect(mapped.latitude).toBeCloseTo(latitudeNorthOf(1_000), 6);
    expect(mapped.longitude).toBeCloseTo(SEARCH_LON, 6);

    // Every non-timestamp field must match the Drizzle branch exactly, so a
    // column added to `gyms` later has to be carried by both or this fails
    // rather than going quietly null on the proximity path only.
    expect(withoutFieldsDivergingOnBug4588(mapped)).toEqual(withoutFieldsDivergingOnBug4588(viaTextPath));

    // The timestamps do NOT match off UTC, and that is a real defect rather than
    // a test artefact: `hours_updated_at` is `timestamp` WITHOUT time zone, and
    // mapRawGymRow's `new Date(string)` resolves the offset-less reading in the
    // process's zone while Drizzle reads the same column as UTC. Identical on a
    // UTC host (Railway, CI), which is why nobody has hit it. Tracked in #4588 —
    // both branches are pinned exactly, so the fix collapses these two into one
    // equality instead of having to re-derive what changed.
    expect(mapped.hoursUpdatedAt).toBe(new Date(HOURS_UPDATED_AT).toISOString());
    expect(viaTextPath.hoursUpdatedAt).toBe(`${HOURS_UPDATED_AT.replace(' ', 'T')}.000Z`);

    // `db.execute` hands back timestamps as strings while the Drizzle branch
    // hydrates them to Date, and the response calls `.toISOString()` on this —
    // an uncoerced string would 500 the whole query, not merely skew a field.
    expect(() => new Date(mapped.createdAt).toISOString()).not.toThrow();
    expect(Number.isNaN(Date.parse(mapped.createdAt))).toBe(false);
  });

  it('agrees with the text path about which gyms exist', async (ctx) => {
    requirePostGis(ctx);
    // The two branches share nothing but their intent, so pin them against each
    // other: with a radius wide enough to cover every fixture, the proximity
    // branch must return the same set the Drizzle branch does.
    await insertGym({ name: 'Alpha', metresNorth: 1_000 });
    await insertGym({ name: 'Beta', metresNorth: 60_000 });
    await insertGym({ name: 'Gamma', metresNorth: 200_000 });

    const proximity = await searchNearby({ radiusKm: 500, limit: 50 });
    const textOnly = await searchText({ limit: 50 });

    expect(proximity.totalCount).toBe(textOnly.totalCount);
    expect(proximity.gyms.map((gym) => gym.uuid).sort()).toEqual(textOnly.gyms.map((gym) => gym.uuid).sort());
  });
});
