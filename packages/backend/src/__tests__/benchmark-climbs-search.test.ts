import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { boardClimbs, boardClimbStats } from '@boardsesh/db/schema';
import { db } from '../db/client';
import { climbQueries } from '../graphql/resolvers/climbs/queries';
import { climbFieldResolvers } from '../graphql/resolvers/climbs/field-resolvers';

// `onlyBenchmarks` keeps only climbs with a positive, real benchmark
// difficulty (#6232). Kilter's stored stats hold NaN for many climbs, and NaN
// passes `> 0` in Postgres (it ranks above every number), so a Benchmarks only
// search used to return them as climbs with no benchmark. On Kilter layout 1 at
// 40 degrees that buried a few hundred benchmarks under tens of thousands of
// other climbs, and a workout's Benchmarks only block came back short.

const layoutId = 99782;
const boardInput = { boardName: 'kilter', layoutId, sizeId: 1, setIds: '1', angle: 40 };
const anonymous = {
  isAuthenticated: false,
  userId: undefined,
  connectionId: 'benchmark-search-anon',
} as ConnectionContext;

type SearchOverrides = { onlyBenchmarks?: boolean; sortBy?: string; minAscents?: number; minRating?: number };

async function search(overrides: SearchOverrides): Promise<{ uuids: string[]; benchmarks: Array<string | null> }> {
  const context = await climbQueries.searchClimbs(
    null,
    { input: { ...boardInput, sortOrder: 'desc', ...overrides } },
    anonymous,
  );
  const climbs = await climbFieldResolvers.climbs(context as Parameters<typeof climbFieldResolvers.climbs>[0]);
  const sorted = [...climbs].sort((first, second) => first.uuid.localeCompare(second.uuid));
  return { uuids: sorted.map((climb) => climb.uuid), benchmarks: sorted.map((climb) => climb.benchmark_difficulty) };
}

const BENCHMARK_DIFFICULTY_BY_UUID = {
  'bench-real': sql`22::double precision`,
  'bench-nan': sql`'NaN'::double precision`,
  'bench-null': sql`NULL::double precision`,
  'bench-zero': sql`0::double precision`,
} as const;

describe('climb search: onlyBenchmarks', () => {
  beforeAll(async () => {
    const uuids = Object.keys(BENCHMARK_DIFFICULTY_BY_UUID);
    await db.insert(boardClimbs).values(
      uuids.map((uuid) => ({
        uuid,
        boardType: 'kilter',
        layoutId,
        isListed: true,
        isDraft: false,
        name: uuid,
        setterUsername: 'benchmark-setter',
        frames: 'p1r1',
        compatibleSizeIds: [1],
        requiredSetIds: [1],
      })),
    );
    await db.insert(boardClimbStats).values(
      Object.entries(BENCHMARK_DIFFICULTY_BY_UUID).map(([climbUuid, benchmarkDifficulty], position) => ({
        boardType: 'kilter',
        climbUuid,
        angle: 40,
        displayDifficulty: 20,
        // Different counts and ratings, so the ascents and quality sorts both
        // put a climb that is not a benchmark first.
        ascensionistCount: 10 + position * 10,
        qualityAverage: 2.5 + position * 0.5,
        benchmarkDifficulty,
      })),
    );
  });

  it('keeps every climb with the switch off', async () => {
    expect((await search({})).uuids).toEqual(['bench-nan', 'bench-null', 'bench-real', 'bench-zero']);
  });

  it.each([
    ['the default ascents sort', {}],
    ['the quality sort a workout sends', { sortBy: 'quality', minAscents: 5, minRating: 2 }],
    ['the creation sort (standard path)', { sortBy: 'creation' }],
  ] as const)('keeps only the real benchmark under %s', async (_label, overrides) => {
    expect(await search({ ...overrides, onlyBenchmarks: true })).toEqual({
      uuids: ['bench-real'],
      benchmarks: ['22'],
    });
  });
});
