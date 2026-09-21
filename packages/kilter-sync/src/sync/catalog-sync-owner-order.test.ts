import { describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
  legacyAuroraRawFrameHoldEvents,
  projectAuroraFramesToStoredRows,
} from '@boardsesh/board-constants/hold-states';

import {
  enrichFingerprintOwnersWithLegacyCompatibility,
  indexStoredFingerprintOwners,
} from './catalog-fingerprint-compat';
import { fingerprintFromHolds } from './fingerprint';
import {
  existingCatalogLayoutRowsQuery,
  legacyFingerprintCompatibilityRowsQuery,
  buildLayoutCatalogIndex,
  createStagingBatch,
  createGroupResult,
  stageCatalogClimb,
} from './catalog-sync';

const renderOnlyDb = drizzle({} as never);

describe('catalog fingerprint owner ordering', () => {
  it('orders the existing-layout query by raw UUID before first-owner indexing', () => {
    const rendered = existingCatalogLayoutRowsQuery(renderOnlyDb, 42).toSQL();
    const normalizedSql = rendered.sql.replaceAll(/\s+/g, ' ').trim().toLowerCase();

    expect(normalizedSql).toContain('order by "board_climbs"."uuid"');
    expect(normalizedSql).not.toContain('lower("board_climbs"."uuid")');
    expect(rendered.params).toEqual(['kilter', 42]);
  });

  it('routes duplicate legacy owners to the stable first UUID', () => {
    const frames = 'p100r12,"x100p100r13';
    const legacyFingerprint = fingerprintFromHolds(legacyAuroraRawFrameHoldEvents(frames, 'kilter'));
    const orderedExistingRows = [
      { uuid: 'a-stable-owner', fingerprint: legacyFingerprint },
      { uuid: 'z-secondary-owner', fingerprint: legacyFingerprint },
    ];
    const storedFingerprintOwners = indexStoredFingerprintOwners(orderedExistingRows);

    const compatibilityRows = orderedExistingRows.map((row) => ({
      layoutId: 42,
      uuid: row.uuid,
      frames,
      fingerprint: row.fingerprint,
    }));
    const enriched = enrichFingerprintOwnersWithLegacyCompatibility(storedFingerprintOwners, compatibilityRows);
    const projectedFingerprint = fingerprintFromHolds(projectAuroraFramesToStoredRows(frames, 'kilter').rows);

    expect(storedFingerprintOwners.get(legacyFingerprint)).toBe('a-stable-owner');
    expect(enriched.get(projectedFingerprint)).toBe('a-stable-owner');
  });
});

const compatibilityTestDatabaseUrl = process.env.KILTER_COMPAT_TEST_DB_URL;
const hasLocalCompatibilityDatabase =
  compatibilityTestDatabaseUrl && ['localhost', '127.0.0.1'].includes(new URL(compatibilityTestDatabaseUrl).hostname);

it.skipIf(!hasLocalCompatibilityDatabase)(
  'preloads single-frame legacy sentinels without loading normal single-frame catalog rows',
  async () => {
    const client = postgres(compatibilityTestDatabaseUrl!);
    const database = drizzle(client);
    try {
      await database.transaction(async (transaction) => {
        await transaction.execute(sql`CREATE TEMP TABLE board_climbs (
        board_type text, uuid text, layout_id integer, frames text, frames_count integer,
        hold_fingerprint text, user_id text
      ) ON COMMIT DROP`);
        const fixtures = [
          { uuid: 'legacy-single', frames: 'p100r12p200r999', framesCount: 1, userId: null },
          { uuid: 'legacy-multi', frames: 'p100r12,"p100r13', framesCount: 2, userId: null },
          { uuid: 'duplicate-hold', frames: 'p100r12p100r13', framesCount: 1, userId: null },
          { uuid: 'normal-single', frames: 'p100r12p200r13', framesCount: 1, userId: null },
          { uuid: 'user-authored', frames: 'p100r12p200r999', framesCount: 1, userId: 'author' },
        ];
        for (const fixture of fixtures) {
          const fingerprint = fingerprintFromHolds(legacyAuroraRawFrameHoldEvents(fixture.frames, 'kilter'));
          await transaction.execute(
            sql`INSERT INTO board_climbs VALUES ('kilter', ${fixture.uuid}, 1, ${fixture.frames}, ${fixture.framesCount}, ${fingerprint}, ${fixture.userId})`,
          );
        }
        const candidates = await legacyFingerprintCompatibilityRowsQuery(transaction);
        expect(candidates.map((row) => row.uuid)).toEqual(['duplicate-hold', 'legacy-multi', 'legacy-single']);
        const legacy = fixtures[0]!;
        const fingerprint = fingerprintFromHolds(legacyAuroraRawFrameHoldEvents(legacy.frames, 'kilter'));
        const index = buildLayoutCatalogIndex({
          layoutId: 1,
          selfAliasUuids: [],
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
