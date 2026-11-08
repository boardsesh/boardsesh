process.env.AURORA_CREDENTIALS_SECRET = process.env.AURORA_CREDENTIALS_SECRET ?? 'test-aurora-secret';

import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '@boardsesh/db/client';
import { auroraCredentials } from '@boardsesh/db/schema';
import {
  BackgroundJobAttemptLostError,
  findSharedSyncDonorCredential,
  rotateLinkGeneration,
} from '@boardsesh/db/queries';
import type { BackgroundJobContext } from '../types';
import { kilterCatalogSyncFamily } from '../kilter-catalog-sync';
import { createSetterSyncNotifications, syncKilterCatalog } from '@boardsesh/kilter-sync/sync';
import { DonorRelinkedError, getStoredKilterAccessToken } from '@boardsesh/kilter-sync/api';
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
const FOLLOWER = 'psync-kfence-follower';
const SETTER = 'psync-fence-setter';
const HOLES = [990_411, 990_412, 990_413];
const PLACEMENTS = [990_421, 990_422, 990_423];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Kilter's reference stream (one product layout) and its REST catalog (one climb and its stats). */
function stubKilter(
  overrides: {
    name?: string;
    description?: string;
    framesPace?: number;
    climbConcat?: string;
    ascentCount?: number;
  } = {},
) {
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
  // Recent, so the new canonical is young enough to announce to followers.
  const at = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const { pathname } = new URL(url);
      if (pathname.endsWith('/sync/stream')) {
        return new Response(reference, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
      }
      if (pathname === '/api/climbs/delteduuids') return json([]);
      if (pathname === '/api/climbs/climbdetails/productName/edges') return json([]);
      if (pathname === `/api/climbs/all/${PLU}`) {
        return json([
          {
            climbUuid: CATALOG_CLIMB,
            climbConcat: overrides.climbConcat ?? HOLES.map((hole, index) => `h${hole}p${12 + index}`).join(''),
            name: overrides.name ?? 'Fence climb',
            description: overrides.description ?? '',
            edgeLeft: 0,
            edgeRight: 100,
            edgeBottom: 0,
            edgeTop: 150,
            frameCount: 1,
            framesPace: overrides.framesPace ?? 0,
            userUuid: null,
            username: SETTER,
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
            ascentCount: overrides.ascentCount ?? 3,
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

const setterNotifications = () =>
  count(sql`SELECT count(*)::int AS count FROM notifications
             WHERE recipient_id = ${FOLLOWER} AND type = 'new_climbs_synced'`);

async function cleanup() {
  const scopeKey = createHash('sha256')
    .update(JSON.stringify([PRODUCT, 0, 100, 0, 150]))
    .digest('hex');
  await database.execute(sql`DELETE FROM kilter_catalog_checkpoints WHERE scope_key = ${scopeKey}`);
  await database.execute(
    sql`DELETE FROM kilter_catalog_source_stats WHERE source_uuid = ${CATALOG_CLIMB.toLowerCase()}`,
  );
  await database.execute(sql`DELETE FROM kilter_catalog_deferred WHERE source_uuid = ${CATALOG_CLIMB.toLowerCase()}`);
  await database.execute(sql`DELETE FROM notifications WHERE recipient_id = ${FOLLOWER}`);
  await database.execute(sql`DELETE FROM setter_follows WHERE follower_id = ${FOLLOWER}`);
  await database.execute(sql`DELETE FROM users WHERE id = ${FOLLOWER}`);
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
  vi.stubEnv('KILTER_CATALOG_INCREMENTAL_ENABLED', 'false');
  await insertLinkedKilterAccount(database, DONOR, DONOR_CLIMB);
  await database.execute(sql`
    INSERT INTO users (id, email, name, created_at, updated_at)
    VALUES (${FOLLOWER}, ${FOLLOWER + '@test.com'}, 'Fence follower', now(), now())`);
  await database.execute(
    sql`INSERT INTO setter_follows (follower_id, setter_username) VALUES (${FOLLOWER}, ${SETTER})`,
  );
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
    expect(await setterNotifications()).toBe(1);
  });

  it("announces a flush's new climb in the flush itself, so a later lost attempt cannot drop it", async () => {
    // Cooldown claim, writer lease, baseline start, then the first atomic layout flush.
    const { context } = fencedContext(4);

    await expect(kilterCatalogSyncFamily.execute(context, {})).rejects.toBeInstanceOf(BackgroundJobAttemptLostError);

    expect(await count(sql`SELECT count(*)::int AS count FROM board_climbs WHERE upper(uuid) = ${CATALOG_CLIMB}`)).toBe(
      1,
    );
    // Committed with the climb: the retry sees the climb as existing and would
    // never announce it.
    expect(await setterNotifications()).toBe(1);
  });

  it('stops at the first flush once the attempt is lost, and writes nothing further', async () => {
    // Cooldown claim, writer lease and baseline start commit; the layout flush is refused.
    const { context } = fencedContext(3);

    await expect(kilterCatalogSyncFamily.execute(context, {})).rejects.toBeInstanceOf(BackgroundJobAttemptLostError);

    // No climb, skip row, layout alias or stats row, and the stamp was refused
    // too: the slot keeps the claim, so the replacement attempt owns it.
    expect(await catalogRows()).toBe(0);
    expect(await setterNotifications()).toBe(0);
    const [cursor] = await database.execute<{ value: string }>(sql`
      SELECT last_synchronized_at AS value FROM board_shared_syncs
       WHERE board_type = 'kilter' AND table_name = '__local_catalog_sync__'`);
    expect(cursor.value).toContain('#claim:');
  });
});

describe('imported metadata ownership and geometry on PostgreSQL', () => {
  const refresh = () =>
    syncKilterCatalog({
      db: database,
      mode: 'full',
      tokenProvider: async () => 'kilter-access',
      suppressNotifications: true,
    });
  const climbRows = () =>
    database.execute<{
      name: string;
      description: string;
      frames_pace: number;
      is_listed: boolean;
      sync_seq: number;
      updated_at: string;
      hold_fingerprint: string;
    }>(sql`SELECT name, description, frames_pace, is_listed, sync_seq,
             updated_at::text AS updated_at, hold_fingerprint
        FROM board_climbs WHERE uuid = ${CATALOG_CLIMB}`);

  it('refreshes source-owned scalars, preserves local visibility and reaches the client sync cursor', async () => {
    await refresh();
    await database.execute(sql`UPDATE board_climbs SET is_listed = false WHERE uuid = ${CATALOG_CLIMB}`);
    const [before] = await climbRows();
    stubKilter({ name: 'Fresh source name', description: 'Fresh source beta', framesPace: 250 });

    await refresh();

    const [after] = await climbRows();
    expect(after).toMatchObject({
      name: 'Fresh source name',
      description: 'Fresh source beta',
      frames_pace: 250,
      is_listed: false,
    });
    expect(Number(after.sync_seq)).toBeGreaterThan(Number(before.sync_seq));
    expect(Date.parse(after.updated_at)).toBeGreaterThanOrEqual(Date.parse(before.updated_at));
    expect(after.hold_fingerprint).toBe(before.hold_fingerprint);
  });

  it.each(['user', 'retained-origin'] as const)(
    'protects authored scalar fields through %s ownership',
    async (ownership) => {
      await refresh();
      if (ownership === 'user') {
        await database.execute(
          sql`UPDATE board_climbs SET user_id = ${DONOR}, is_boardsesh_authored = false WHERE uuid = ${CATALOG_CLIMB}`,
        );
      } else {
        await database.execute(
          sql`UPDATE board_climbs SET user_id = NULL, is_boardsesh_authored = true WHERE uuid = ${CATALOG_CLIMB}`,
        );
      }
      const [before] = await climbRows();
      stubKilter({ name: 'Must not replace local name', description: 'Must not replace local beta', framesPace: 999 });

      await refresh();

      const [after] = await climbRows();
      expect(after.name).toBe(before.name);
      expect(after.description).toBe(before.description);
      expect(after.frames_pace).toBe(before.frames_pace);
      expect(after.sync_seq).toBe(before.sync_seq);
    },
  );

  it('durably defers changed geometry and keeps its statistics off the old holds', async () => {
    await refresh();
    const [before] = await climbRows();
    const changedConcat = `h${HOLES[0]}p12h${HOLES[1]}p14`;
    stubKilter({
      name: 'New geometry name',
      description: 'Changed geometry beta',
      climbConcat: changedConcat,
      ascentCount: 99,
    });

    await refresh();

    const [after] = await climbRows();
    expect(after.name).toBe(before.name);
    expect(after.hold_fingerprint).toBe(before.hold_fingerprint);
    const [cached] = await database.execute<{ payload: { ascentCount: number } }>(sql`
      SELECT payload FROM kilter_catalog_source_stats WHERE source_uuid = ${CATALOG_CLIMB.toLowerCase()} AND angle = 40`);
    expect(cached.payload.ascentCount).toBe(3);
    const [aggregate] = await database.execute<{ upstream_ascensionist_count: number }>(sql`
      SELECT upstream_ascensionist_count FROM board_climb_stats WHERE climb_uuid = ${CATALOG_CLIMB} AND angle = 40`);
    expect(Number(aggregate.upstream_ascensionist_count)).toBe(3);
    const [deferred] = await database.execute<{
      payload: {
        climb: { name: string; climbConcat: string; description: string };
        stats: Array<{ angle: number; ascentCount: number }>;
      };
      reason: string;
    }>(sql`SELECT payload, reason FROM kilter_catalog_deferred WHERE source_uuid = ${CATALOG_CLIMB.toLowerCase()}`);
    expect(deferred.reason).toBe('unresolved_geometry_or_alias');
    expect(deferred.payload.climb).toMatchObject({
      name: 'New geometry name',
      description: 'Changed geometry beta',
      climbConcat: changedConcat,
    });
    expect(deferred.payload.stats).toContainEqual(expect.objectContaining({ angle: 40, ascentCount: 99 }));
  });
});

describe("Kilter setter notifications across a run's flushes", () => {
  const rows = async () =>
    database.execute<{ uuid: string; entity_id: string }>(sql`
      SELECT uuid, entity_id FROM notifications
       WHERE recipient_id = ${FOLLOWER} AND type = 'new_climbs_synced'`);
  const newClimb = (uuid: string) => ({ uuid, setterUsername: SETTER, layoutId: CATALOG_ID, name: uuid });

  it('gives a follower one notification per setter per run, however many flushes it spans', async () => {
    const runKey = randomUUID();
    // Two layout flushes of one run, each with a new climb by the same setter;
    // the second flush is then retried.
    await createSetterSyncNotifications(database, [newClimb('PSYNCKFENCE-FLUSH-1')], () => {}, { runKey });
    await createSetterSyncNotifications(database, [newClimb('PSYNCKFENCE-FLUSH-2')], () => {}, { runKey });
    await createSetterSyncNotifications(database, [newClimb('PSYNCKFENCE-FLUSH-2')], () => {}, { runKey });

    const once = await rows();
    expect(once).toHaveLength(1);
    // The first flush's head climb names it.
    expect(once[0].entity_id).toBe('PSYNCKFENCE-FLUSH-1');

    // A later run is a new notification.
    await createSetterSyncNotifications(database, [newClimb('PSYNCKFENCE-FLUSH-3')], () => {}, {
      runKey: randomUUID(),
    });
    expect(await rows()).toHaveLength(2);
  });
});

describe("the catalog donor's token, pinned to the link it was borrowed under", () => {
  const client = { clientId: 'fence-test-client' };
  const borrow = async () => {
    const donor = await findSharedSyncDonorCredential(database, {
      boardType: 'kilter',
      candidateFilter: eq(auroraCredentials.userId, DONOR),
    });
    if (!donor) throw new Error('expected the fixture donor');
    return { credentialId: donor.id, linkGeneration: donor.linkGeneration };
  };

  it('refreshes the token while the link is unchanged', async () => {
    const binding = await borrow();
    await expect(getStoredKilterAccessToken(database, DONOR, client, true, binding)).resolves.toBe('kilter-access');
  });

  it("refuses the new link's token after a relink mid-run (DONOR_RELINKED), without a refresh", async () => {
    const binding = await borrow();
    // The climber relinks while the catalog job runs on the borrowed link.
    await database.transaction((transaction) =>
      rotateLinkGeneration(transaction, { userId: DONOR, boardType: 'kilter', linked: true }),
    );

    await expect(getStoredKilterAccessToken(database, DONOR, client, true, binding)).rejects.toBeInstanceOf(
      DonorRelinkedError,
    );
  });
});
