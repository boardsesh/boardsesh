import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import { places, placeImports } from '@boardsesh/db/schema';
import { importPlaceRows, normalizePlaceSearch, PLACE_DATASET } from '@boardsesh/db/queries';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { placeQueries } from '../graphql/resolvers/social/places';

const context: ConnectionContext = { connectionId: 'place-test', isAuthenticated: false };
const search = (query: string) => placeQueries.searchPlaces(null, { query }, context);
const sources = [{ name: 'test.txt', sha256: 'test-checksum', modifiedAt: null }];
function place(id: number, name: string, population: number, aliases = ''): typeof places.$inferInsert {
  return {
    id,
    name,
    normalizedName: normalizePlaceSearch(name),
    country: 'Australia',
    countryCode: 'AU',
    region: 'New South Wales',
    latitude: -33.86785,
    longitude: 151.20732,
    population,
    searchText: normalizePlaceSearch(`${name} ${aliases} New South Wales Australia AU`),
  };
}

beforeAll(async () => {
  await importPlaceRows(
    db,
    [
      place(2147714, 'Sydney', 5600000),
      {
        ...place(6354908, 'Sydney', 100000),
        country: 'Canada',
        countryCode: 'CA',
        region: 'Nova Scotia',
        searchText: 'sydney nova scotia canada ca',
      },
      place(900001, 'Sydney Harbour', 9000000),
      place(900002, 'München', 1500000, 'Munich'),
      ...Array.from({ length: 6 }, (_, index) => place(900010 + index, `Sydney Test ${index}`, 10)),
    ],
    sources,
  );
});

describe('local place search', () => {
  it('ranks exact cities before prefixes and disambiguates by population', async () => {
    const results = await search(' sYdNeY ');
    expect(results.map((result) => result.id)).toEqual([2147714, 6354908, 900001, 900010, 900011]);
    expect(results[0]).toMatchObject({ latitude: -33.86785, longitude: 151.20732, country: 'Australia' });
  });
  it('matches accents, aliases and location qualifiers', async () => {
    expect((await search('Munchen'))[0].name).toBe('München');
    expect((await search('Munich'))[0].name).toBe('München');
    expect((await search('Sydney Canada')).map((result) => result.id)).toEqual([6354908]);
    expect(await search('nowhereimaginary')).toEqual([]);
  });
  it('validates bounds and does not interpret LIKE wildcards', async () => {
    await expect(search('ab')).rejects.toThrow();
    await expect(search('x'.repeat(81))).rejects.toThrow();
    expect(await search(' %_% ')).toEqual([]);
  });
  it('upserts without removing places and skips an already completed initialization', async () => {
    await importPlaceRows(db, [place(900050, 'Test Town', 20)], sources);
    await importPlaceRows(db, [place(900050, 'Test Town', 25)], sources);
    expect(await db.select().from(places).where(eq(places.id, 900050))).toHaveLength(1);
    await importPlaceRows(db, [place(900050, 'Test Town', 30)], sources, true);
    expect((await db.select().from(places).where(eq(places.id, 900050)))[0].population).toBe(25);
    expect((await search('Sydney'))[0].id).toBe(2147714);
  });
  it('rolls back earlier batches and import metadata if a later batch fails', async () => {
    const [before] = await db.select().from(placeImports).where(eq(placeImports.dataset, PLACE_DATASET));
    const batch = Array.from({ length: 1001 }, (_, index) => place(910000 + index, 'Rollback Town', 0));
    batch[1000].name = null as unknown as string;
    await expect(importPlaceRows(db, batch, sources)).rejects.toThrow();
    expect(await db.select().from(places).where(eq(places.id, 910000))).toEqual([]);
    expect((await db.select().from(placeImports).where(eq(placeImports.dataset, PLACE_DATASET)))[0]).toEqual(before);
  });
});
