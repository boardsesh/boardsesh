import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { redisClientManager, type RedisClients } from '../redis/client';
import {
  getPopularConfigs,
  normalizeCatalogTimestamp,
  type CachedPopularConfig,
} from '../graphql/resolvers/social/boards';
import { seedAuroraCatalogFixtures } from './helpers/board-catalog-fixture';

// Issue #4466: `popularBoardConfigs` gains `lastClimbAt`, the newest listed
// climb's `created_at` in that config, normalised to a proper ISO-8601 UTC
// string. `board_climbs.created_at` is TEXT, not timestamptz, and carries two
// naive-UTC (zone-less) separator styles depending on the importer — Aurora
// writes a space (`'2024-03-11 09:00:00'`), MoonBoard writes ISO-T
// (`'2023-11-23T18:00:15.227'`). A raw text MAX across a mix of both is wrong
// on a shared calendar day: 'T' (0x54) sorts after ' ' (0x20), so the SQL
// aggregate must canonicalise the separator before taking the max.
const BOARD_TYPE = 'lastclimbat-test';
const PRODUCT_ID = 941001;
const LAYOUT_ID = 941001;
const SIZE_ID = 941001;
const SET_ID = 941001;

// Config edges: a climb counts only if edge_left > bps.edge_left,
// edge_right < bps.edge_right, edge_bottom > bps.edge_bottom, edge_top <
// bps.edge_top (strict containment). In-bounds climbs use 10..90; the size
// itself is 0..100.
const SIZE_EDGES = { edgeLeft: 0, edgeRight: 100, edgeBottom: 0, edgeTop: 100 };
const IN_BOUNDS_EDGES = { edgeLeft: 10, edgeRight: 90, edgeBottom: 10, edgeTop: 90 };

async function insertClimb(params: {
  uuid: string;
  edges: { edgeLeft: number; edgeRight: number; edgeBottom: number; edgeTop: number };
  createdAt: string | null;
  isListed: boolean;
  isDraft: boolean;
}) {
  const { uuid, edges, createdAt, isListed, isDraft } = params;
  await db.execute(sql`
    INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, edge_left, edge_right, edge_bottom, edge_top, is_listed, is_draft, created_at)
    VALUES
      (${uuid}, ${BOARD_TYPE}, ${LAYOUT_ID}, ${uuid}, ${edges.edgeLeft}, ${edges.edgeRight}, ${edges.edgeBottom}, ${edges.edgeTop}, ${isListed}, ${isDraft}, ${createdAt})
  `);
}

async function cleanupClimbs() {
  await db.execute(sql`DELETE FROM board_climb_stats WHERE board_type = ${BOARD_TYPE}`);
  await db.execute(sql`DELETE FROM board_climbs WHERE board_type = ${BOARD_TYPE}`);
}

describe('popularBoardConfigs.lastClimbAt (SQL aggregate, real DB)', () => {
  let teardownFixture: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    await cleanupClimbs();
    teardownFixture = await seedAuroraCatalogFixtures([
      {
        boardType: BOARD_TYPE,
        productId: PRODUCT_ID,
        layoutId: LAYOUT_ID,
        sizeId: SIZE_ID,
        setIds: [SET_ID],
        associationIdBase: 941001,
        isListed: true,
      },
    ]);
    // The fixture helper doesn't set edges (not every consumer needs them) —
    // stamp them here so the LATERAL's containment predicate has something
    // real to compare against.
    await db
      .update(dbSchema.boardProductSizes)
      .set(SIZE_EDGES)
      .where(and(eq(dbSchema.boardProductSizes.boardType, BOARD_TYPE), eq(dbSchema.boardProductSizes.id, SIZE_ID)));
  });

  afterAll(async () => {
    await cleanupClimbs();
    if (teardownFixture) await teardownFixture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function findConfig(): Promise<CachedPopularConfig | undefined> {
    vi.spyOn(redisClientManager, 'isRedisConnected').mockReturnValue(false);
    const configs = await getPopularConfigs();
    return configs.find((config) => config.boardType === BOARD_TYPE && config.layoutId === LAYOUT_ID);
  }

  it('takes the chronological max across mixed space/T separators, ignoring NULL and out-of-config rows', async () => {
    await cleanupClimbs();
    await insertClimb({
      uuid: `${BOARD_TYPE}-A`,
      edges: IN_BOUNDS_EDGES,
      createdAt: '2024-01-01 10:00:00.123456',
      isListed: true,
      isDraft: false,
    });
    await insertClimb({
      // Space-separated, no fractional seconds — the real chronological max.
      uuid: `${BOARD_TYPE}-B`,
      edges: IN_BOUNDS_EDGES,
      createdAt: '2024-03-11 09:00:00',
      isListed: true,
      isDraft: false,
    });
    await insertClimb({
      // Same calendar date as B, ISO-T separated, earlier time. A raw text
      // MAX (no separator normalisation) would wrongly prefer this row over
      // B, since 'T' (0x54) sorts after ' ' (0x20).
      uuid: `${BOARD_TYPE}-F`,
      edges: IN_BOUNDS_EDGES,
      createdAt: '2024-03-11T08:00:00.000',
      isListed: true,
      isDraft: false,
    });
    await insertClimb({
      uuid: `${BOARD_TYPE}-E`,
      edges: IN_BOUNDS_EDGES,
      createdAt: null,
      isListed: true,
      isDraft: false,
    });
    await insertClimb({
      // Decoy: same layout but edges outside the config's size — must not
      // count even though its created_at is far in the future.
      uuid: `${BOARD_TYPE}-C`,
      edges: { edgeLeft: 0, edgeRight: 90, edgeBottom: 10, edgeTop: 90 },
      createdAt: '2030-01-01 00:00:00',
      isListed: true,
      isDraft: false,
    });
    await insertClimb({
      // Decoy: in-bounds but unlisted — must not count even though its
      // created_at is far in the future.
      uuid: `${BOARD_TYPE}-D`,
      edges: IN_BOUNDS_EDGES,
      createdAt: '2029-01-01 00:00:00',
      isListed: false,
      isDraft: false,
    });

    const config = await findConfig();
    expect(config).toBeDefined();
    expect(config?.lastClimbAt).toBe('2024-03-11T09:00:00.000Z');
  });
});

describe('normalizeCatalogTimestamp', () => {
  it.each([
    ['2024-03-11 09:00:00.123456', '2024-03-11T09:00:00.123Z'],
    ['2023-11-23T18:00:15.227', '2023-11-23T18:00:15.227Z'],
    ['2024-03-11T09:00:00Z', '2024-03-11T09:00:00.000Z'],
    // Sub-millisecond fraction, explicitly right-padded (0.5s = 500ms, not 5ms).
    ['2024-03-11T09:00:00.5', '2024-03-11T09:00:00.500Z'],
    [null, null],
    ['', null],
    ['unknown', null],
    ['2024-13-45T00:00:00', null],
  ])('normalizeCatalogTimestamp(%p) -> %p', (input, expected) => {
    expect(normalizeCatalogTimestamp(input)).toBe(expected);
  });

  it('rejects a value in the future rather than leaking a fabricated <lastmod>', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-19T00:00:00Z'));
    try {
      expect(normalizeCatalogTimestamp('2030-01-01 00:00:00')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('popularBoardConfigs cache: legacy row without lastClimbAt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves without throwing and leaves lastClimbAt absent, never a synthesised value', async () => {
    const legacyConfig: Omit<CachedPopularConfig, 'lastClimbAt'> = {
      boardType: 'legacy-cache-test',
      layoutId: 1,
      layoutName: 'Legacy Layout',
      sizeId: 1,
      sizeName: 'Legacy Size',
      sizeDescription: null,
      setIds: [1],
      setNames: ['Legacy Set'],
      climbCount: 5,
      totalAscents: 10,
      boardCount: 2,
      displayName: 'Legacy Layout Legacy Size',
    };

    const mockPublisher = {
      get: vi.fn().mockResolvedValue(JSON.stringify([legacyConfig])),
      set: vi.fn(),
    } as unknown as RedisClients['publisher'];

    vi.spyOn(redisClientManager, 'isRedisConnected').mockReturnValue(true);
    vi.spyOn(redisClientManager, 'getClients').mockReturnValue({
      publisher: mockPublisher,
      subscriber: {} as RedisClients['subscriber'],
      streamConsumer: {} as RedisClients['streamConsumer'],
    });

    const configs = await getPopularConfigs();

    expect(configs).toHaveLength(1);
    expect(configs[0].boardType).toBe('legacy-cache-test');
    expect(configs[0].lastClimbAt).toBeUndefined();
  });
});
