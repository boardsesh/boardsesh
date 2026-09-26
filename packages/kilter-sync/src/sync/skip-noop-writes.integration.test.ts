// Integration test for the kilter-sync no-op write guards: a second identical
// catalog pass must write nothing to board_climb_stats, board_climb_aliases or
// kilter_wall_sources, while every real change (and the daily restamp the tick
// recompute's absorption rule needs) still lands.
//
// Runs against a migrated local Postgres (the dev DB) with the same driver
// options the daemon uses (postgres-js, prepare: false), inside ONE outer
// transaction that is always rolled back, so it leaves nothing behind. Inside
// one transaction every row version shares an xmin, so "was this row
// rewritten" is read from ctid: an UPDATE, HOT or not, moves the row to a new
// ctid; a skipped ON CONFLICT only locks it in place.
//
// It self-skips when DATABASE_URL is not a local database, so it does NOT run
// in CI. Run it locally against the dev DB with:
//
//   DATABASE_URL=postgres://postgres:password@localhost:5432/main \
//     vp test run --reporter=agent packages/kilter-sync/src/sync/skip-noop-writes.integration.test.ts

import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { rowsFromResult } from '@boardsesh/db/client';
import { boardClimbs } from '@boardsesh/db/schema';

import { flushKilterLayoutBatch, loadKilterSelfAliasLower } from './catalog-sync';
import { upsertKilterWallSources, type WallSourceMapping } from './locations-sync';
import { upsertKilterStats, type KilterStatsUpsertRow } from './stats-upsert';

function localDatabaseUrl(): string | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  try {
    const hostname = new URL(databaseUrl).hostname.toLowerCase();
    return ['localhost', '127.0.0.1', 'postgres'].includes(hostname) ? databaseUrl : null;
  } catch {
    return null;
  }
}

const databaseUrl = localDatabaseUrl();
const describeIntegration = databaseUrl ? describe : describe.skip;

type Db = ReturnType<typeof drizzle>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Run `body` in a transaction that is always rolled back. */
async function inRolledBackTransaction(body: (tx: Tx) => Promise<void>): Promise<void> {
  const client = postgres(databaseUrl ?? '', { max: 1, prepare: false, onnotice: () => {} });
  const db = drizzle(client);
  const rollback = new Error('rollback');
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await client.end();
  }
}

async function queryRows<T>(tx: Tx, query: ReturnType<typeof sql>): Promise<T[]> {
  return rowsFromResult<T>(await tx.execute(query));
}

type StatsState = {
  ctid: string;
  sync_seq: string;
  updated_at: string;
  upstream_synced_at: string | null;
  upstream_ascensionist_count: string | null;
  ascensionist_count: string | null;
  quality_average: number | null;
  tick_graded_at: string | null;
};

async function statsState(tx: Tx, climbUuid: string): Promise<StatsState> {
  const [state] = await queryRows<StatsState>(
    tx,
    sql`SELECT ctid::text AS ctid, sync_seq::text AS sync_seq, updated_at::text AS updated_at,
               upstream_synced_at::text AS upstream_synced_at,
               upstream_ascensionist_count::text AS upstream_ascensionist_count,
               ascensionist_count::text AS ascensionist_count, quality_average, tick_graded_at::text AS tick_graded_at
          FROM board_climb_stats WHERE board_type = 'kilter' AND climb_uuid = ${climbUuid} AND angle = 40`,
  );
  if (!state) throw new Error(`no stats row for ${climbUuid}`);
  return state;
}

async function ctidOf(tx: Tx, query: ReturnType<typeof sql>): Promise<string> {
  const [row] = await queryRows<{ ctid: string }>(tx, query);
  if (!row) throw new Error('row not found');
  return row.ctid;
}

async function tableExists(tx: Tx, table: string): Promise<boolean> {
  const [row] = await queryRows<{ found: string | null }>(tx, sql`SELECT to_regclass(${table})::text AS found`);
  return Boolean(row?.found);
}

describeIntegration('kilter-sync skips no-op writes (real Postgres)', () => {
  it('board_climb_stats: a second identical pass writes 0 rows and leaves sync_seq alone', async (testContext) => {
    await inRolledBackTransaction(async (tx) => {
      if (!(await tableExists(tx, 'public.board_climb_stats'))) {
        testContext.skip();
        return;
      }
      const tag = `noop-${Date.now()}`;
      const statRow = (climbUuid: string, overrides: Partial<KilterStatsUpsertRow> = {}): KilterStatsUpsertRow => ({
        climbUuid,
        angle: 40,
        displayDifficulty: 20,
        difficultyAverage: 20.25,
        qualityAverage: 4.5,
        faUsername: 'o\'brien, "the" {setter}',
        faAt: '2024-01-02 03:04:05',
        upstreamAscensionistCount: 12,
        ...overrides,
      });
      const climbA = `${tag}-a`;
      const climbB = `${tag}-b`;
      const firstPass = [statRow(climbA), statRow(climbB, { faUsername: null, faAt: null, displayDifficulty: null })];

      // Pass 1 inserts both rows.
      expect(await upsertKilterStats(tx, firstPass, { policy: 'raise-only', syncedAt: '2026-09-26T00:00:00Z' })).toBe(
        2,
      );
      const afterInsertA = await statsState(tx, climbA);
      const afterInsertB = await statsState(tx, climbB);

      // Pass 2 an hour later with identical values: nothing is rewritten, not
      // even the stamp, and the offline cursor does not move.
      expect(await upsertKilterStats(tx, firstPass, { policy: 'raise-only', syncedAt: '2026-09-26T01:00:00Z' })).toBe(
        0,
      );
      expect(await statsState(tx, climbA)).toEqual(afterInsertA);
      expect(await statsState(tx, climbB)).toEqual(afterInsertB);

      // A real upstream change writes exactly that row.
      expect(
        await upsertKilterStats(tx, [statRow(climbA, { upstreamAscensionistCount: 13 }), firstPass[1]], {
          policy: 'raise-only',
          syncedAt: '2026-09-26T02:00:00Z',
        }),
      ).toBe(1);
      const afterRaiseA = await statsState(tx, climbA);
      expect(afterRaiseA.upstream_ascensionist_count).toBe('13');
      expect(afterRaiseA.upstream_synced_at).toBe('2026-09-26 02:00:00');
      expect(afterRaiseA.ctid).not.toBe(afterInsertA.ctid);
      expect(await statsState(tx, climbB)).toEqual(afterInsertB);
      const secondPassRows = [statRow(climbA, { upstreamAscensionistCount: 13 }), firstPass[1]];

      // A day-old stamp on an unchanged row with no Boardsesh ascents stays:
      // absorption can only lower a Boardsesh count, and there is none.
      await tx.execute(
        sql`UPDATE board_climb_stats SET upstream_synced_at = '2026-09-25 01:00:00'
             WHERE board_type = 'kilter' AND climb_uuid = ${climbB} AND angle = 40`,
      );
      const staleB = await statsState(tx, climbB);
      expect(
        await upsertKilterStats(tx, secondPassRows, { policy: 'raise-only', syncedAt: '2026-09-26T03:00:00Z' }),
      ).toBe(0);
      expect(await statsState(tx, climbB)).toEqual(staleB);

      // Once Boardsesh ascents count on it, the day-old stamp is refreshed so
      // the tick recompute's absorption rule keeps working, and sync_seq stays
      // put because the trigger ignores upstream_synced_at.
      await tx.execute(
        sql`UPDATE board_climb_stats
               SET boardsesh_ascensionist_count = 1, ascensionist_count = 13
             WHERE board_type = 'kilter' AND climb_uuid = ${climbB} AND angle = 40`,
      );
      const countedB = await statsState(tx, climbB);
      expect(
        await upsertKilterStats(tx, secondPassRows, { policy: 'raise-only', syncedAt: '2026-09-26T03:00:00Z' }),
      ).toBe(1);
      const restampedB = await statsState(tx, climbB);
      expect(restampedB.upstream_synced_at).toBe('2026-09-26 03:00:00');
      expect(restampedB.sync_seq).toBe(countedB.sync_seq);
      expect(restampedB.updated_at).toBe(countedB.updated_at);

      // A tick-derived marker on a grade Grips now supplies is cleared, although
      // the grade value itself is unchanged (a column the sync_seq trigger
      // does not watch).
      await tx.execute(
        sql`UPDATE board_climb_stats SET tick_graded_at = '2026-09-20 00:00:00'
             WHERE board_type = 'kilter' AND climb_uuid = ${climbA} AND angle = 40`,
      );
      expect(
        await upsertKilterStats(tx, secondPassRows, { policy: 'raise-only', syncedAt: '2026-09-26T04:00:00Z' }),
      ).toBe(1);
      expect((await statsState(tx, climbA)).tick_graded_at).toBeNull();

      // New Boardsesh votes re-blend quality_average on the next pass.
      await tx.execute(
        sql`UPDATE board_climb_stats SET boardsesh_quality_sum = 1, boardsesh_quality_count = 1
             WHERE board_type = 'kilter' AND climb_uuid = ${climbA} AND angle = 40`,
      );
      const beforeBlendA = await statsState(tx, climbA);
      expect(
        await upsertKilterStats(tx, secondPassRows, { policy: 'raise-only', syncedAt: '2026-09-26T05:00:00Z' }),
      ).toBe(1);
      const blendedA = await statsState(tx, climbA);
      // (4.5 * 13 + 1) / (13 + 1)
      expect(blendedA.quality_average).toBeCloseTo((4.5 * 13 + 1) / 14, 10);
      expect(blendedA.sync_seq).not.toBe(beforeBlendA.sync_seq);

      // The catalog never lowers a count; the repair does.
      const lowered = [statRow(climbA, { upstreamAscensionistCount: 9 }), firstPass[1]];
      expect(await upsertKilterStats(tx, lowered, { policy: 'raise-only', syncedAt: '2026-09-26T06:00:00Z' })).toBe(0);
      expect(await upsertKilterStats(tx, lowered, { policy: 'authoritative', syncedAt: '2026-09-26T06:00:00Z' })).toBe(
        1,
      );
      const repairedA = await statsState(tx, climbA);
      expect(repairedA.upstream_ascensionist_count).toBe('9');
      expect(repairedA.ascensionist_count).toBe('9');
      expect(await upsertKilterStats(tx, lowered, { policy: 'authoritative', syncedAt: '2026-09-26T07:00:00Z' })).toBe(
        0,
      );
    });
  }, 30_000);

  it('board_climb_aliases: an unchanged alias is not rewritten; a source change or a day-old sighting is', async (testContext) => {
    await inRolledBackTransaction(async (tx) => {
      if (!(await tableExists(tx, 'public.board_climb_aliases'))) {
        testContext.skip();
        return;
      }
      const tag = `noop-${Date.now()}`;
      const canonical = `${tag}-canon`;
      const pureAlias = `${tag}-grips`;
      await tx.insert(boardClimbs).values({
        uuid: canonical,
        boardType: 'kilter',
        layoutId: 1,
        setterUsername: 'noop-tester',
        name: 'No-op guard',
        description: '',
        frames: '',
        isListed: true,
        isDraft: false,
      });
      const aliases = [
        { boardType: 'kilter', aliasUuid: canonical, canonicalUuid: canonical, source: 'kilter' },
        { boardType: 'kilter', aliasUuid: pureAlias, canonicalUuid: canonical, source: 'kilter' },
      ];
      const aliasCtid = (aliasUuid: string) =>
        ctidOf(
          tx,
          sql`SELECT ctid::text AS ctid FROM board_climb_aliases WHERE board_type = 'kilter' AND alias_uuid = ${aliasUuid}`,
        );

      await flushKilterLayoutBatch(tx, [], [], aliases);
      const firstCanonical = await aliasCtid(canonical);
      const firstPure = await aliasCtid(pureAlias);

      // The run-wide self-alias load sees the canonical's own row (lowercased)
      // and not the pure alias.
      const selfAliases = await loadKilterSelfAliasLower(tx);
      expect(selfAliases.has(canonical.toLowerCase())).toBe(true);
      expect(selfAliases.has(pureAlias.toLowerCase())).toBe(false);

      await flushKilterLayoutBatch(tx, [], [], aliases);
      expect(await aliasCtid(canonical)).toBe(firstCanonical);
      expect(await aliasCtid(pureAlias)).toBe(firstPure);

      // A non-kilter alias is re-claimed as kilter, which is what lets deletion
      // reconciliation remove it later; a day-old sighting is refreshed.
      await tx.execute(
        sql`UPDATE board_climb_aliases SET source = 'backfill' WHERE board_type = 'kilter' AND alias_uuid = ${pureAlias}`,
      );
      await tx.execute(
        sql`UPDATE board_climb_aliases SET last_seen_at = now() - interval '25 hours'
             WHERE board_type = 'kilter' AND alias_uuid = ${canonical}`,
      );
      await flushKilterLayoutBatch(tx, [], [], aliases);
      const [pure] = await queryRows<{ source: string }>(
        tx,
        sql`SELECT source FROM board_climb_aliases WHERE board_type = 'kilter' AND alias_uuid = ${pureAlias}`,
      );
      expect(pure?.source).toBe('kilter');
      const [refreshed] = await queryRows<{ fresh: boolean }>(
        tx,
        sql`SELECT last_seen_at >= now() - interval '1 minute' AS fresh
              FROM board_climb_aliases WHERE board_type = 'kilter' AND alias_uuid = ${canonical}`,
      );
      expect(refreshed?.fresh).toBe(true);
    });
  }, 30_000);

  it('kilter_wall_sources: an unchanged wall is not rewritten; unlisting and re-listing still work', async (testContext) => {
    await inRolledBackTransaction(async (tx) => {
      if (!(await tableExists(tx, 'public.kilter_wall_sources'))) {
        testContext.skip();
        return;
      }
      const [board] = await queryRows<{ uuid: string }>(tx, sql`SELECT uuid FROM user_boards LIMIT 1`);
      if (!board) {
        testContext.skip();
        return;
      }
      const tag = `noop-${Date.now()}`;
      const mapping = (suffix: string): WallSourceMapping => ({
        sourceKey: `kilter:${tag}:${suffix}`,
        sourceBoardUuid: board.uuid,
        gymUuid: `${tag}-gym`,
        productLayoutUuid: '27',
        wallUuid: `${tag}-${suffix}`,
        layoutId: 1,
        sizeId: 10,
        setIds: '1,20',
      });
      const wallOne = mapping('one');
      const wallTwo = mapping('two');
      const wallState = async (sourceKey: string) => {
        const [row] = await queryRows<{ ctid: string; is_listed: boolean }>(
          tx,
          sql`SELECT ctid::text AS ctid, is_listed FROM kilter_wall_sources WHERE source_key = ${sourceKey}`,
        );
        if (!row) throw new Error(`no wall source ${sourceKey}`);
        return row;
      };

      await upsertKilterWallSources(tx, [wallOne, wallTwo]);
      const firstOne = await wallState(wallOne.sourceKey);
      const firstTwo = await wallState(wallTwo.sourceKey);
      expect(firstOne.is_listed).toBe(true);

      await upsertKilterWallSources(tx, [wallOne, wallTwo]);
      expect(await wallState(wallOne.sourceKey)).toEqual(firstOne);
      expect(await wallState(wallTwo.sourceKey)).toEqual(firstTwo);

      // Wall two drops out of the reference: unlisted, wall one untouched.
      await upsertKilterWallSources(tx, [wallOne]);
      expect((await wallState(wallTwo.sourceKey)).is_listed).toBe(false);
      expect(await wallState(wallOne.sourceKey)).toEqual(firstOne);

      // It comes back: is_listed is part of the change guard, so it re-lists.
      await upsertKilterWallSources(tx, [wallOne, { ...wallTwo, setIds: '1,20,21' }]);
      expect((await wallState(wallTwo.sourceKey)).is_listed).toBe(true);
      const [changed] = await queryRows<{ set_ids: string }>(
        tx,
        sql`SELECT set_ids FROM kilter_wall_sources WHERE source_key = ${wallTwo.sourceKey}`,
      );
      expect(changed?.set_ids).toBe('1,20,21');
    });
  }, 30_000);
});
