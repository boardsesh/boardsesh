process.env.AURORA_CREDENTIALS_SECRET = process.env.AURORA_CREDENTIALS_SECRET ?? 'test-aurora-secret';

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '@boardsesh/db/client';
import { BackgroundJobAttemptLostError } from '@boardsesh/db/queries';
import type { BackgroundJobContext } from '../types';
import { kilterCatalogSyncFamily } from '../kilter-catalog-sync';
import { insertLinkedKilterAccount, removeFixtures } from './provider-sync-fixtures';

// Keycloak stands in for the donor's token refresh; everything behind it runs.
vi.mock('../../../../../kilter-sync/src/api/keycloak.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    refreshAccessToken: async () => ({ access_token: 'kilter-access', expires_in: 300, token_type: 'Bearer' }),
  };
});

const database = createDb();
const DONOR = 'psync-kfence-donor';
const DONOR_CLIMB = 'psync-kclimb-kfence';
const CATALOG_ID = 990_401;
const PRODUCT = 'Psync Fence Product';
const PLU = 'psync-fence-plu';
const CATALOG_CLIMB = 'PSYNCKFENCE00000000000000000001';
const HOLES = [990_411, 990_412, 990_413];
const PLACEMENTS = [990_421, 990_422, 990_423];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Kilter's reference stream (one product layout) and its REST catalog (one climb and its stats). */
function stubKilter() {
  const reference = [
    JSON.stringify({
      data: {
        bucket: 'global',
        data: [
          {
            op_id: '1',
            op: 'PUT',
            object_type: 'product_layouts',
            object_id: PLU,
            data: {
              product_layout_uuid: PLU,
              product_name: PRODUCT,
              is_listed: 1,
              edge_left: 0,
              edge_right: 100,
              edge_bottom: 0,
              edge_top: 150,
            },
          },
        ],
      },
    }),
    JSON.stringify({ checkpoint_complete: {} }),
  ]
    .map((line) => `${line}\n`)
    .join('');
  const at = '2026-09-01T00:00:00Z';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const { pathname } = new URL(url);
      if (pathname.endsWith('/sync/stream')) {
        return new Response(reference, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
      }
      if (pathname === '/api/climbs/delteduuids') return json([]);
      if (pathname === `/api/climbs/all/${PLU}`) {
        return json([
          {
            climbUuid: CATALOG_CLIMB,
            climbConcat: HOLES.map((hole, index) => `h${hole}p${12 + index}`).join(''),
            name: 'Fence climb',
            description: '',
            edgeLeft: 0,
            edgeRight: 100,
            edgeBottom: 0,
            edgeTop: 150,
            frameCount: 1,
            framesPace: 0,
            userUuid: null,
            username: 'psync-fence-setter',
            productName: PRODUCT,
            productLayoutUuid: PLU,
            allowMatch: false,
            isDraft: false,
            isListed: true,
            isDeleted: false,
            accumulatedHoldSetValue: null,
            origin: null,
            createdAt: at,
            updatedAt: at,
          },
        ]);
      }
      if (pathname === `/api/climb-stat/all/${PLU}`) {
        return json([
          {
            climbUuid: CATALOG_CLIMB,
            angle: 40,
            ascentCount: 3,
            currentDifficultyId: 20,
            difficultyAverage: 20,
            qualityAverage: 3,
            faUsername: 'psync-fa',
            faAt: at,
          },
        ]);
      }
      throw new Error(`Unexpected request in test: ${url}`);
    }),
  );
}

/**
 * The family's context with the attempt fence modelled: the first `validBatches`
 * write batches commit, and every one after that finds the attempt gone, as
 * `withBackgroundJobAttempt` does once another attempt owns the run.
 */
function fencedContext(validBatches: number) {
  let batches = 0;
  const context: BackgroundJobContext = {
    runId: randomUUID(),
    family: 'kilter-catalog-sync',
    signal: new AbortController().signal,
    expiresAt: Date.now() + 60 * 60 * 1000,
    database,
    transaction: (callback) => {
      batches += 1;
      if (batches > validBatches) return Promise.reject(new BackgroundJobAttemptLostError());
      return database.transaction(callback);
    },
    enqueue: async () => {
      throw new Error('enqueue not expected');
    },
  };
  return { context, batchCount: () => batches };
}

const count = async (query: ReturnType<typeof sql>) =>
  Number((await database.execute<{ count: number }>(query))[0].count);

const catalogRows = () =>
  count(sql`SELECT (
      (SELECT count(*) FROM board_climbs WHERE upper(uuid) = ${CATALOG_CLIMB})
    + (SELECT count(*) FROM board_climb_ingest_skips WHERE upper(climb_uuid) = ${CATALOG_CLIMB})
    + (SELECT count(*) FROM board_layout_aliases WHERE layout_uuid = ${PLU})
    + (SELECT count(*) FROM board_climb_stats WHERE upper(climb_uuid) = ${CATALOG_CLIMB})
  )::int AS count`);

async function cleanup() {
  await removeFixtures(database, [DONOR], [DONOR_CLIMB]);
  await database.execute(sql`DELETE FROM board_climb_stats WHERE upper(climb_uuid) = ${CATALOG_CLIMB}`);
  await database.execute(sql`DELETE FROM board_climb_holds WHERE upper(climb_uuid) = ${CATALOG_CLIMB}`);
  await database.execute(sql`DELETE FROM board_climb_aliases WHERE upper(canonical_uuid) = ${CATALOG_CLIMB}`);
  await database.execute(sql`DELETE FROM board_climbs WHERE upper(uuid) = ${CATALOG_CLIMB}`);
  await database.execute(sql`DELETE FROM board_climb_ingest_skips WHERE upper(climb_uuid) = ${CATALOG_CLIMB}`);
  await database.execute(sql`DELETE FROM board_layout_aliases WHERE layout_uuid = ${PLU}`);
  await database.execute(sql`DELETE FROM board_placements WHERE board_type = 'kilter' AND layout_id = ${CATALOG_ID}`);
  await database.execute(sql`DELETE FROM board_holes WHERE board_type = 'kilter' AND product_id = ${CATALOG_ID}`);
  await database.execute(sql`DELETE FROM board_layouts WHERE board_type = 'kilter' AND id = ${CATALOG_ID}`);
  await database.execute(sql`DELETE FROM board_products WHERE board_type = 'kilter' AND id = ${CATALOG_ID}`);
  await database.execute(sql`DELETE FROM board_shared_syncs WHERE board_type = 'kilter'`);
}

beforeEach(async () => {
  await cleanup();
  vi.stubEnv('KILTER_OAUTH_CLIENT_ID', 'fence-test-client');
  await insertLinkedKilterAccount(database, DONOR, DONOR_CLIMB);
  await database.execute(sql`UPDATE aurora_credentials SET sync_status = 'active', last_sync_at = now()
                              WHERE user_id = ${DONOR}`);
  await database.execute(sql`
    INSERT INTO board_products (board_type, id, name, is_listed) VALUES ('kilter', ${CATALOG_ID}, ${PRODUCT}, true)`);
  await database.execute(sql`
    INSERT INTO board_layouts (board_type, id, product_id, name, is_listed, is_mirrored)
    VALUES ('kilter', ${CATALOG_ID}, ${CATALOG_ID}, 'Psync Fence Layout', true, false)`);
  for (const [index, hole] of HOLES.entries()) {
    await database.execute(sql`
      INSERT INTO board_holes (board_type, id, product_id, name, x, y, mirror_group)
      VALUES ('kilter', ${hole}, ${CATALOG_ID}, ${`F${index}`}, ${index * 8}, 8, 0)`);
    await database.execute(sql`
      INSERT INTO board_placements (board_type, id, layout_id, hole_id, set_id)
      VALUES ('kilter', ${PLACEMENTS[index]}, ${CATALOG_ID}, ${hole}, 1)`);
  }
  stubKilter();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await cleanup();
});

describe('kilter-catalog-sync behind the attempt fence', () => {
  it('writes the catalog through fenced batches when the attempt holds', async () => {
    const { context, batchCount } = fencedContext(Number.POSITIVE_INFINITY);

    await kilterCatalogSyncFamily.execute(context, {});

    expect(await catalogRows()).toBeGreaterThan(0);
    // Claim, flushes, stats, aliases, locations, snapshot, stamp: every write was a fenced batch.
    expect(batchCount()).toBeGreaterThan(3);
    const [cursor] = await database.execute<{ value: string }>(sql`
      SELECT last_synchronized_at AS value FROM board_shared_syncs
       WHERE board_type = 'kilter' AND table_name = '__local_catalog_sync__'`);
    expect(cursor.value).toContain('#finished:');
  });

  it('stops at the first flush once the attempt is lost, and writes nothing further', async () => {
    // The claim commits; the attempt is lost before the first layout flush.
    const { context } = fencedContext(1);

    await expect(kilterCatalogSyncFamily.execute(context, {})).rejects.toBeInstanceOf(BackgroundJobAttemptLostError);

    // No climb, skip row, layout alias or stats row, and the stamp was refused
    // too: the slot keeps the claim, so the replacement attempt owns it.
    expect(await catalogRows()).toBe(0);
    const [cursor] = await database.execute<{ value: string }>(sql`
      SELECT last_synchronized_at AS value FROM board_shared_syncs
       WHERE board_type = 'kilter' AND table_name = '__local_catalog_sync__'`);
    expect(cursor.value).toContain('#claim:');
  });
});
