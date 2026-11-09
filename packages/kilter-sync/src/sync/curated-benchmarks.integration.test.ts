// Integration test for the Kilter Verified pass: which rows it marks, which it
// clears, and that a repeat pass writes nothing.
//
// Runs against a migrated local Postgres inside ONE outer transaction that is
// always rolled back, so it leaves nothing behind. Inside one transaction every
// row version shares an xmin, so "was this row rewritten" is read from ctid.
//
// It self-skips when DATABASE_URL is not a local database, so it does NOT run in
// CI. Run it locally with:
//
//   DATABASE_URL=postgres://postgres:password@localhost:5432/main \
//     vp test run --reporter=agent packages/kilter-sync/src/sync/curated-benchmarks.integration.test.ts

import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { rowsFromResult } from '@boardsesh/db/client';
import { boardClimbAliases, boardClimbs, boardClimbStats, kilterAuroraBenchmarks, users } from '@boardsesh/db/schema';

import type { KilterCuratedStat } from '../api/kilter-rest';
import { applyCuratedBenchmarks } from './curated-benchmarks';

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

const PREFIX = 'CURATEDTEST';
const uuid = (name: string) => `${PREFIX}${name}`;

async function seedClimb(tx: Tx, name: string, options: { userId?: string } = {}): Promise<void> {
  await tx.insert(boardClimbs).values({
    uuid: uuid(name),
    boardType: 'kilter',
    layoutId: 1,
    name,
    isListed: true,
    isDraft: false,
    userId: options.userId ?? null,
  });
  await tx
    .insert(boardClimbAliases)
    .values({ boardType: 'kilter', aliasUuid: uuid(name), canonicalUuid: uuid(name), source: 'kilter' });
}

async function seedStat(tx: Tx, name: string, angle: number, benchmarkDifficulty: number | null): Promise<void> {
  await tx
    .insert(boardClimbStats)
    .values({ boardType: 'kilter', climbUuid: uuid(name), angle, displayDifficulty: 20, benchmarkDifficulty });
}

type StoredRow = {
  climb_uuid: string;
  angle: number;
  benchmark_difficulty: number | null;
  ctid: string;
  sync_seq: string;
};

async function storedRows(tx: Tx): Promise<Map<string, StoredRow>> {
  const rows = rowsFromResult<StoredRow>(
    await tx.execute(sql`
      SELECT climb_uuid, angle, benchmark_difficulty, ctid::text AS ctid, sync_seq::text AS sync_seq
      FROM board_climb_stats
      WHERE board_type = 'kilter' AND climb_uuid LIKE ${`${PREFIX}%`}
    `),
  );
  return new Map(rows.map((row) => [`${row.climb_uuid.slice(PREFIX.length)}@${row.angle}`, row]));
}

const curated = (
  name: string,
  angle: number,
  currentDifficultyId: number,
  officialKilterDifficulty: number | null = null,
): KilterCuratedStat => ({
  climbUuid: uuid(name),
  angle,
  currentDifficultyId,
  officialKilterDifficulty,
});

function runPass(tx: Tx, stats: KilterCuratedStat[], minAngleRows = 1) {
  const database = tx as unknown as Parameters<typeof applyCuratedBenchmarks>[0]['db'];
  return applyCuratedBenchmarks({
    db: database,
    write: (callback) => callback(database),
    stats,
    deletedLowerUuids: null,
    log: () => {},
    minAngleRows,
  });
}

describeIntegration('applyCuratedBenchmarks', () => {
  it('marks listed angles, clears the rest, and leaves user climbs alone', async () => {
    await inRolledBackTransaction(async (tx) => {
      const ownerId = uuid('OWNER');
      await tx.insert(users).values({ id: ownerId, email: `${ownerId}@example.com` });
      for (const name of ['OFFICIAL', 'FALLBACK', 'LEGACYKEPT', 'LEGACYGONE', 'NANROW', 'CASING'])
        await seedClimb(tx, name);
      await seedClimb(tx, 'USEROWNED', { userId: ownerId });

      await seedStat(tx, 'OFFICIAL', 40, 18); // official grade replaces it
      await seedStat(tx, 'OFFICIAL', 50, 19); // same climb, angle not on the list: cleared
      await seedStat(tx, 'FALLBACK', 40, null); // no official grade: takes the current grade
      await seedStat(tx, 'LEGACYKEPT', 40, 25); // no official grade: keeps its value
      await seedStat(tx, 'LEGACYGONE', 40, 22); // not on the list: cleared
      await tx
        .insert(kilterAuroraBenchmarks)
        .values({ climbUuid: uuid('LEGACYGONE'), angle: 40, benchmarkDifficulty: 22 });
      await seedStat(tx, 'NANROW', 40, Number.NaN); // NaN is not a real mark
      await seedStat(tx, 'CASING', 40, null); // Kilter sends this uuid in lower case
      await seedStat(tx, 'USEROWNED', 40, 21); // never ours to touch

      const stats = [
        curated('OFFICIAL', 40, 19, 23),
        curated('FALLBACK', 40, 21),
        curated('LEGACYKEPT', 40, 24),
        curated('NANROW', 40, 17),
        { ...curated('CASING', 40, 18), climbUuid: uuid('CASING').toLowerCase() },
        curated('NOTINBOARDSESH', 40, 20),
        curated('USEROWNED', 40, 20, 26),
      ];
      const before = await storedRows(tx);
      const first = await runPass(tx, stats);
      const after = await storedRows(tx);

      expect(first.unresolvedClimbs).toBe(1);
      expect(first.refused).toBe(false);
      expect(after.get('OFFICIAL@40')?.benchmark_difficulty).toBe(23);
      expect(after.get('OFFICIAL@50')?.benchmark_difficulty).toBeNull();
      expect(after.get('FALLBACK@40')?.benchmark_difficulty).toBe(21);
      expect(after.get('LEGACYKEPT@40')?.benchmark_difficulty).toBe(25);
      expect(after.get('LEGACYGONE@40')?.benchmark_difficulty).toBeNull();
      const frozen = await tx
        .select({ benchmarkDifficulty: kilterAuroraBenchmarks.benchmarkDifficulty })
        .from(kilterAuroraBenchmarks)
        .where(eq(kilterAuroraBenchmarks.climbUuid, uuid('LEGACYGONE')));
      expect(frozen).toEqual([{ benchmarkDifficulty: 22 }]);
      expect(after.get('NANROW@40')?.benchmark_difficulty).toBe(17);
      expect(after.get('CASING@40')?.benchmark_difficulty).toBe(18);
      expect(after.get('USEROWNED@40')?.benchmark_difficulty).toBe(21);

      // Clients pull on sync_seq, so a changed row has to move it.
      expect(after.get('FALLBACK@40')?.sync_seq).not.toBe(before.get('FALLBACK@40')?.sync_seq);

      const second = await runPass(tx, stats);
      const afterSecond = await storedRows(tx);
      expect(second.marked).toBe(0);
      expect(second.cleared).toBe(0);
      for (const [key, row] of afterSecond) expect(row.ctid, key).toBe(after.get(key)?.ctid);
    });
  });

  it('a later official grade replaces a kept value, and a grade drift does not', async () => {
    await inRolledBackTransaction(async (tx) => {
      await seedClimb(tx, 'DRIFT');
      await seedStat(tx, 'DRIFT', 40, null);
      await runPass(tx, [curated('DRIFT', 40, 20)]);
      expect((await storedRows(tx)).get('DRIFT@40')?.benchmark_difficulty).toBe(20);

      const drift = await runPass(tx, [curated('DRIFT', 40, 21)]);
      expect(drift.marked).toBe(0);
      expect((await storedRows(tx)).get('DRIFT@40')?.benchmark_difficulty).toBe(20);

      await runPass(tx, [curated('DRIFT', 40, 21, 24)]);
      expect((await storedRows(tx)).get('DRIFT@40')?.benchmark_difficulty).toBe(24);
    });
  });

  it('refuses to run until the frozen Aurora grades exist', async () => {
    await inRolledBackTransaction(async (tx) => {
      await seedClimb(tx, 'LEGACYSAFE');
      await seedStat(tx, 'LEGACYSAFE', 40, 22);
      await tx.execute(sql`DROP TABLE kilter_aurora_benchmarks`);

      await expect(runPass(tx, [curated('LEGACYSAFE', 40, 20, 24)])).rejects.toThrow();
    });
  });

  it('refuses a list under the floor and changes nothing', async () => {
    await inRolledBackTransaction(async (tx) => {
      await seedClimb(tx, 'LEGACYSAFE');
      await seedStat(tx, 'LEGACYSAFE', 40, 22);
      const before = await storedRows(tx);

      const report = await runPass(tx, [curated('NOTINBOARDSESH', 40, 20)], 2);

      expect(report.refused).toBe(true);
      expect(report.cleared).toBe(0);
      const after = await storedRows(tx);
      expect(after.get('LEGACYSAFE@40')?.benchmark_difficulty).toBe(22);
      expect(after.get('LEGACYSAFE@40')?.ctid).toBe(before.get('LEGACYSAFE@40')?.ctid);
    });
  });
});
