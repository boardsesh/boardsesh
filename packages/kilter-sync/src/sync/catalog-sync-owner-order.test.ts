import { describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import {
  legacyAuroraRawFrameHoldEvents,
  projectAuroraFramesToStoredRows,
} from '@boardsesh/board-constants/hold-states';

import { enrichFingerprintOwnersWithLegacyCompatibility } from './catalog-fingerprint-compat';
import { fingerprintFromHolds } from './fingerprint';
import {
  buildLayoutCatalogIndex,
  createStagingBatch,
  createGroupResult,
  loadLayoutCatalogIndex,
  loadLegacyFingerprintCompatibilityRows,
  stageCatalogClimb,
} from './catalog-sync';

describe('catalog fingerprint owner ordering', () => {
  it('routes duplicate legacy owners to the stable first UUID', () => {
    const frames = 'p100r12,"x100p100r13';
    const legacyFingerprint = fingerprintFromHolds(legacyAuroraRawFrameHoldEvents(frames, 'kilter'));
    const orderedExistingRows = [
      { uuid: 'a-stable-owner', fingerprint: legacyFingerprint },
      { uuid: 'z-secondary-owner', fingerprint: legacyFingerprint },
    ];
    const compatibilityRows = orderedExistingRows.map((row) => ({
      layoutId: 42,
      uuid: row.uuid,
      frames,
      fingerprint: row.fingerprint,
    }));
    const enriched = enrichFingerprintOwnersWithLegacyCompatibility(orderedExistingRows, compatibilityRows);
    const projectedFingerprint = fingerprintFromHolds(projectAuroraFramesToStoredRows(frames, 'kilter').rows);

    expect(enriched.get(legacyFingerprint)).toBe('a-stable-owner');
    expect(enriched.has(projectedFingerprint)).toBe(false);
  });
});

const compatibilityTestDatabaseUrl = process.env.KILTER_COMPAT_TEST_DB_URL;
const ownedCompatibilityDatabase = (() => {
  if (
    process.env.BOARDSESH_4161_SQL_APPROVED !== '1' ||
    process.env.BOARDSESH_4161_OWNED_PG_PORT !== '32785' ||
    process.env.BOARDSESH_4161_OWNED_CONTAINER_ID !==
      '47c56beae33b3f73ecce8556290f2f91b24f5f18f44ad538f478ff614126f210' ||
    !compatibilityTestDatabaseUrl ||
    compatibilityTestDatabaseUrl !== process.env.DATABASE_URL ||
    compatibilityTestDatabaseUrl !== process.env.POSTGRES_URL
  ) {
    return false;
  }
  const url = new URL(compatibilityTestDatabaseUrl);
  return (
    url.protocol === 'postgres:' &&
    url.hostname === '127.0.0.1' &&
    url.port === '32785' &&
    url.pathname === '/boardsesh_pr_sweep_4161' &&
    decodeURIComponent(url.username) === 'boardsesh_4161' &&
    decodeURIComponent(url.password) === 'fixture-only-4161' &&
    process.env.REDIS_URL === 'redis://127.0.0.1:9/0' &&
    (process.env.READ_REPLICA_URL ?? '') === ''
  );
})();

it.skipIf(!ownedCompatibilityDatabase)(
  'preloads single-frame legacy sentinels without loading normal single-frame catalog rows',
  async () => {
    if (!compatibilityTestDatabaseUrl) throw new Error('the exact owned 4161 database URL was not supplied');
    const [{ default: postgres }, { drizzle }] = await Promise.all([
      import('postgres'),
      import('drizzle-orm/postgres-js'),
    ]);
    const client = postgres(compatibilityTestDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client);
    try {
      const [identity] = await client<{ current_database: string }[]>`SELECT current_database()`;
      expect(identity?.current_database).toBe('boardsesh_pr_sweep_4161');
      await database.transaction(async (transaction) => {
        await transaction.execute(sql`CREATE TEMP TABLE board_climbs (
        board_type text, uuid text, layout_id integer, frames text, frames_count integer,
        hold_fingerprint text, user_id text, is_listed boolean, is_draft boolean
      ) ON COMMIT DROP`);
        const fixtures = [
          { uuid: 'legacy-single', frames: 'p100r12p200r999', framesCount: 1, userId: null },
          { uuid: 'legacy-owner-z', frames: 'p100r12p200r999', framesCount: 1, userId: null },
          { uuid: 'legacy-owner-a', frames: 'p100r12p200r999', framesCount: 1, userId: null },
          { uuid: 'legacy-multi', frames: 'p100r12,"p100r13', framesCount: 2, userId: null },
          { uuid: 'duplicate-hold', frames: 'p100r12p100r13', framesCount: 1, userId: null },
          { uuid: 'normal-single', frames: 'p100r12p200r13', framesCount: 1, userId: null },
          { uuid: 'user-authored', frames: 'p100r12p200r999', framesCount: 1, userId: 'author' },
        ];
        for (const fixture of fixtures) {
          const fingerprint = fingerprintFromHolds(legacyAuroraRawFrameHoldEvents(fixture.frames, 'kilter'));
          await transaction.execute(
            sql`INSERT INTO board_climbs VALUES (
              'kilter', ${fixture.uuid}, 1, ${fixture.frames}, ${fixture.framesCount}, ${fingerprint},
              ${fixture.userId}, true, false
            )`,
          );
        }
        const candidates = await loadLegacyFingerprintCompatibilityRows(transaction);
        expect(candidates.map((row) => row.uuid)).toEqual([
          'duplicate-hold',
          'legacy-multi',
          'legacy-owner-a',
          'legacy-owner-z',
          'legacy-single',
        ]);
        const legacyFingerprint = fingerprintFromHolds(legacyAuroraRawFrameHoldEvents('p100r12p200r999', 'kilter'));
        const loadedIndex = await loadLayoutCatalogIndex(transaction, 1, new Map(), new Set(), candidates);
        expect(loadedIndex.fingerprintToCanonical.get(legacyFingerprint)).toBe('legacy-owner-a');
        const legacy = fixtures[0]!;
        const fingerprint = legacyFingerprint;
        const index = buildLayoutCatalogIndex({
          layoutId: 1,
          existingSelfAliasLower: new Set(),
          holeToPlacement: new Map([
            [10, 100],
            [20, 200],
          ]),
          climbRows: [{ uuid: legacy.uuid, fingerprint, userId: null, isDraft: false, isListed: true }],
          legacyFingerprintCompatibilityRows: candidates.flatMap((row) =>
            row.frames && row.fingerprint ? [{ ...row, frames: row.frames, fingerprint: row.fingerprint }] : [],
          ),
        });
        const batch = createStagingBatch();
        const climbUuidToCanonical = new Map<string, string>();
        const result = stageCatalogClimb(
          {
            climbUuid: 'NEW',
            climbConcat: 'h10p12h20p999',
            frameCount: 1,
            name: 'Incoming duplicate',
            description: '',
            edgeLeft: 0,
            edgeRight: 0,
            edgeBottom: 0,
            edgeTop: 0,
            framesPace: 0,
            userUuid: '1',
            username: 'setter',
            productName: 'Kilter Board Original',
            productLayoutUuid: '27',
            allowMatch: true,
            isDraft: false,
            isListed: true,
            isDeleted: false,
            accumulatedHoldSetValue: 3,
            origin: 'NATIVE',
            createdAt: '2026-09-10T00:00:00Z',
            updatedAt: '2026-09-10T00:00:00Z',
          },
          {
            index,
            sourceLayoutUuid: '27',
            openSkips: new Map(),
            batch,
            climbUuidToCanonical,
            canonicalsToRelist: new Set(),
            deletedLowerUuids: new Set(),
            reroute: null,
            result: createGroupResult(),
            now: new Date('2026-09-21T00:00:00Z'),
          },
        );
        expect(result).toBe('folded');
        expect(climbUuidToCanonical.get('new')).toBe(legacy.uuid);
        expect(batch.newClimbInserts).toEqual([]);
      });
    } finally {
      await client.end();
    }
  },
);
