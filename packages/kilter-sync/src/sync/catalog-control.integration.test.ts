import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  boardClimbs,
  boardClimbAliases,
  boardClimbStats,
  kilterCatalogCheckpoints,
  kilterCatalogControl,
  kilterCatalogDeferred,
  kilterCatalogSourceStats,
} from '@boardsesh/db/schema';
import { applyCatalogSourceStats } from './catalog-source-stats';
import type { KilterCatalogStat } from '../api/kilter-rest';
import {
  CatalogWriterLeaseLostError,
  completeCatalogCheckpoint,
  readCatalogCheckpoint,
  startCatalogBaseline,
  withCatalogWriterLease,
  type CatalogControlWrite,
} from './catalog-control';

function localDatabaseUrl(): string | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  try {
    return ['localhost', '127.0.0.1', 'postgres', 'postgres-test'].includes(new URL(databaseUrl).hostname)
      ? databaseUrl
      : null;
  } catch {
    return null;
  }
}

const databaseUrl = localDatabaseUrl();
const describeIntegration = databaseUrl ? describe : describe.skip;

// Each run uses its own schema and the generated migration: it needs no catalog
// data and never modifies existing control/checkpoint rows in the local DB.
describeIntegration('catalog writer fencing against PostgreSQL', () => {
  const schemaName = `kilter_catalog_${randomUUID().replaceAll('-', '')}`;
  const admin = databaseUrl ? postgres(databaseUrl, { max: 1, prepare: false }) : null;
  const client = databaseUrl
    ? postgres(databaseUrl, { max: 4, prepare: false, connection: { search_path: schemaName } })
    : null;
  const db = client ? drizzle(client) : null;
  const getDb = () => {
    if (!db) throw new Error('A local test database is required');
    return db;
  };

  beforeAll(async () => {
    if (!admin || !client) throw new Error('A local test database is required');
    await admin`CREATE SCHEMA ${admin(schemaName)}`;
    const migration = await readFile(
      new URL('../../../db/drizzle/0291_kilter_catalog_incremental.sql', import.meta.url),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      await client.unsafe(statement);
    }
    // Reuse the backend's existing table fixture rather than maintain another
    // copy of the aggregate columns and their CHECK constraints.
    const backendFixture = await readFile(
      new URL('../../../backend/src/__tests__/schema-sql.ts', import.meta.url),
      'utf8',
    );
    await client.unsafe('CREATE TABLE users (id text PRIMARY KEY)');
    for (const tableName of ['board_climbs', 'board_climb_aliases', 'board_climb_stats']) {
      const tableDefinition = backendFixture.match(
        new RegExp(`CREATE TABLE IF NOT EXISTS "${tableName}" \\([\\s\\S]*?\\n  \\);`),
      )?.[0];
      if (!tableDefinition) throw new Error(`Missing backend fixture table ${tableName}`);
      await client.unsafe(tableDefinition);
    }
    // The backend fixture adds this retained ownership flag later, through
    // its privacy migration. Apply that generated statement here as well.
    const privacyMigration = await readFile(
      new URL('../../../db/drizzle/0261_account_resource_privacy.sql', import.meta.url),
      'utf8',
    );
    const ownershipColumn = privacyMigration.match(
      /ALTER TABLE "board_climbs" ADD COLUMN "is_boardsesh_authored"[^;]+;/,
    )?.[0];
    if (!ownershipColumn) throw new Error('Missing authored-climb ownership column migration');
    await client.unsafe(ownershipColumn);
  });

  afterAll(async () => {
    await client?.end();
    if (admin) {
      await admin`DROP SCHEMA IF EXISTS ${admin(schemaName)} CASCADE`;
      await admin.end();
    }
  });

  it('refuses concurrent owners and rejects a stale owner after takeover', async () => {
    const database = getDb();
    let resumeOldOwner: (() => void) | undefined;
    let ownerClaimed: (() => void) | undefined;
    const claimed = new Promise<void>((resolve) => {
      ownerClaimed = resolve;
    });
    const oldOwner = withCatalogWriterLease({ db: database }, async ({ write }) => {
      ownerClaimed?.();
      await new Promise<void>((resolve) => {
        resumeOldOwner = resolve;
      });
      await write(async () => {
        throw new Error('A stale callback must never execute');
      });
    });
    const oldRejection = expect(oldOwner).rejects.toBeInstanceOf(CatalogWriterLeaseLostError);
    try {
      await claimed;
      await expect(withCatalogWriterLease({ db: database }, async () => {})).rejects.toBeInstanceOf(
        CatalogWriterLeaseLostError,
      );
      // Emulate elapsed database time without waiting for the 120-second TTL.
      await database.update(kilterCatalogControl).set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` });
      await withCatalogWriterLease({ db: database }, async ({ write }) => {
        resumeOldOwner?.();
        await oldRejection;
        await write(async () => {});
      });
    } finally {
      resumeOldOwner?.();
      await oldRejection;
    }
  });

  it('holds the lease row lock for the entire bounded write', async () => {
    const database = getDb();
    await withCatalogWriterLease({ db: database }, ({ write }) =>
      write(async () => {
        await expect(
          database.transaction((transaction) =>
            transaction.execute(sql`SELECT * FROM ${kilterCatalogControl} FOR UPDATE NOWAIT`),
          ),
        ).rejects.toMatchObject({ cause: { code: '55P03' } });
      }),
    );
  });

  it('rolls back all writes when the final database-clock expiry check fails', async () => {
    const database = getDb();
    const scope = { scopeKey: 'expired-batch', mappingVersion: 'v1' };
    await expect(
      withCatalogWriterLease({ db: database }, ({ write }) =>
        write(async (transaction) => {
          await transaction.insert(kilterCatalogCheckpoints).values(scope);
          await transaction
            .update(kilterCatalogControl)
            .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` });
        }),
      ),
    ).rejects.toBeInstanceOf(CatalogWriterLeaseLostError);
    expect(await readCatalogCheckpoint(database, scope)).toBeNull();
  });

  it('never certifies a failed checkpoint transaction or changed mapping', async () => {
    const database = getDb();
    const scope = { scopeKey: 'checkpoint-rollback', mappingVersion: 'v1' };
    const startedAt = new Date('2026-11-08T12:00:00Z');
    await withCatalogWriterLease({ db: database }, async ({ write }) => {
      await startCatalogBaseline(write, scope, startedAt);
      await expect(
        write(async (transaction) => {
          const sameTransaction: CatalogControlWrite = (work) => work(transaction);
          await completeCatalogCheckpoint(sameTransaction, scope, startedAt, { baseline: true });
          throw new Error('Final batch failed');
        }),
      ).rejects.toThrow('Final batch failed');
      expect(await readCatalogCheckpoint(database, scope)).toMatchObject({
        baselineCompletedAt: null,
        confirmedThrough: null,
      });
      await completeCatalogCheckpoint(write, scope, startedAt, { baseline: true });
      expect((await readCatalogCheckpoint(database, scope))?.confirmedThrough).toEqual(startedAt);
      expect(await readCatalogCheckpoint(database, { ...scope, mappingVersion: 'v2' })).toBeNull();
      await startCatalogBaseline(write, { ...scope, mappingVersion: 'v2' }, startedAt);
      await expect(completeCatalogCheckpoint(write, scope, startedAt)).rejects.toThrow('no matching complete baseline');
    });
    await database.delete(kilterCatalogCheckpoints).where(eq(kilterCatalogCheckpoints.scopeKey, scope.scopeKey));
  });

  function sourceStat(
    climbUuid: string,
    ascentCount: number,
    grade: number | null = null,
    quality: number | null = null,
  ): KilterCatalogStat {
    return {
      climbUuid,
      angle: 40,
      ascentCount,
      currentDifficultyId: grade,
      difficultyAverage: grade,
      qualityAverage: quality,
      faUsername: null,
      faAt: null,
    };
  }

  it('replaces an alias contribution while preserving canonical grades and Boardsesh quality/counts', async () => {
    const database = getDb();
    const canonicalUuid = 'Canonical';
    await database.insert(boardClimbs).values({ uuid: canonicalUuid, boardType: 'kilter', layoutId: 1 });
    await database.insert(boardClimbStats).values({
      boardType: 'kilter',
      climbUuid: canonicalUuid,
      angle: 40,
      upstreamAscensionistCount: 0,
      boardseshAscensionistCount: 3,
      boardseshQualitySum: 6,
      boardseshQualityCount: 2,
      displayDifficulty: 30,
      tickGradedAt: '2026-01-01T00:00:00Z',
    });
    await withCatalogWriterLease({ db: database }, async ({ write }) => {
      await write((transaction) =>
        applyCatalogSourceStats(
          transaction,
          [
            { canonicalUuid, stat: sourceStat('CANONICAL', 10, 20, 4) },
            { canonicalUuid, stat: sourceStat('Alias', 5, 25, 2) },
          ],
          { completeCoverage: true, confirmedAt: '2026-11-08T12:00:00Z' },
        ),
      );
      await write((transaction) =>
        applyCatalogSourceStats(transaction, [{ canonicalUuid, stat: sourceStat('ALIAS', 1, 28, 1) }], {
          completeCoverage: true,
          confirmedAt: '2026-11-08T12:15:00Z',
        }),
      );
    });
    const [aggregate] = await database
      .select()
      .from(boardClimbStats)
      .where(eq(boardClimbStats.climbUuid, canonicalUuid));
    expect(aggregate).toMatchObject({
      upstreamAscensionistCount: 11,
      boardseshAscensionistCount: 3,
      ascensionistCount: 14,
      displayDifficulty: 20,
      difficultyAverage: 20,
      tickGradedAt: null,
      upstreamQualityAverage: 4,
      boardseshQualitySum: 6,
      boardseshQualityCount: 2,
    });
    expect(aggregate.qualityAverage).toBeCloseTo(50 / 13);
    const cached = await database.select().from(kilterCatalogSourceStats);
    expect(cached.filter((entry) => entry.canonicalUuid === canonicalUuid)).toHaveLength(2);
    expect(cached.find((entry) => entry.sourceUuid === 'alias')?.payload.ascentCount).toBe(1);
  });

  it('updates existing zero-count rows, preserves tick grades and never creates empty rows', async () => {
    const database = getDb();
    await database.insert(boardClimbs).values([
      { uuid: 'existing-zero', boardType: 'kilter', layoutId: 1 },
      { uuid: 'new-empty', boardType: 'kilter', layoutId: 1 },
    ]);
    await database.insert(boardClimbStats).values({
      boardType: 'kilter',
      climbUuid: 'existing-zero',
      angle: 40,
      upstreamAscensionistCount: 7,
      boardseshAscensionistCount: 2,
      displayDifficulty: 26,
      tickGradedAt: '2026-01-01T00:00:00Z',
    });
    await withCatalogWriterLease({ db: database }, ({ write }) =>
      write((transaction) =>
        applyCatalogSourceStats(
          transaction,
          [
            { canonicalUuid: 'existing-zero', stat: sourceStat('existing-zero', 0) },
            { canonicalUuid: 'new-empty', stat: sourceStat('new-empty', 0) },
          ],
          { completeCoverage: true, confirmedAt: '2026-11-08T12:00:00Z' },
        ),
      ),
    );
    const [existing] = await database
      .select()
      .from(boardClimbStats)
      .where(eq(boardClimbStats.climbUuid, 'existing-zero'));
    expect(existing).toMatchObject({
      upstreamAscensionistCount: 0,
      boardseshAscensionistCount: 2,
      ascensionistCount: 2,
      displayDifficulty: 26,
    });
    expect(existing.tickGradedAt).not.toBeNull();
    expect(await database.select().from(boardClimbStats).where(eq(boardClimbStats.climbUuid, 'new-empty'))).toEqual([]);
  });

  it('rolls back cache replacements and their aggregate together', async () => {
    const database = getDb();
    const canonicalUuid = 'rollback-source';
    await database.insert(boardClimbs).values({ uuid: canonicalUuid, boardType: 'kilter', layoutId: 1 });
    await withCatalogWriterLease({ db: database }, async ({ write }) => {
      await write((transaction) =>
        applyCatalogSourceStats(transaction, [{ canonicalUuid, stat: sourceStat(canonicalUuid, 2, 20) }], {
          completeCoverage: true,
        }),
      );
      await expect(
        write(async (transaction) => {
          await applyCatalogSourceStats(transaction, [{ canonicalUuid, stat: sourceStat(canonicalUuid, 9, 28) }], {
            completeCoverage: true,
          });
          throw new Error('Batch durability failure');
        }),
      ).rejects.toThrow('Batch durability failure');
    });
    const [cached] = await database
      .select()
      .from(kilterCatalogSourceStats)
      .where(eq(kilterCatalogSourceStats.sourceUuid, canonicalUuid));
    const [aggregate] = await database
      .select()
      .from(boardClimbStats)
      .where(eq(boardClimbStats.climbUuid, canonicalUuid));
    expect(cached.payload.ascentCount).toBe(2);
    expect(aggregate).toMatchObject({ upstreamAscensionistCount: 2, displayDifficulty: 20 });
  });

  it('withholds authoritative decreases and freshness while an alias geometry is deferred', async () => {
    const database = getDb();
    const canonicalUuid = 'deferred-canonical';
    await database.insert(boardClimbs).values({ uuid: canonicalUuid, boardType: 'kilter', layoutId: 1 });
    await database
      .insert(boardClimbAliases)
      .values({ boardType: 'kilter', aliasUuid: 'deferred-alias', canonicalUuid, source: 'kilter' });
    await withCatalogWriterLease({ db: database }, async ({ write }) => {
      await write((transaction) =>
        applyCatalogSourceStats(
          transaction,
          [
            { canonicalUuid, stat: sourceStat(canonicalUuid, 10, 20) },
            { canonicalUuid, stat: sourceStat('deferred-alias', 5, 25) },
          ],
          { completeCoverage: true, confirmedAt: '2026-11-08T12:00:00Z' },
        ),
      );
      await write((transaction) =>
        transaction
          .insert(kilterCatalogDeferred)
          .values({ sourceUuid: 'deferred-alias', reason: 'changed_geometry', payload: {} }),
      );
      await write((transaction) =>
        applyCatalogSourceStats(transaction, [{ canonicalUuid, stat: sourceStat(canonicalUuid, 1, 20) }], {
          completeCoverage: true,
          confirmedAt: '2026-11-08T12:15:00Z',
        }),
      );
    });
    const [aggregate] = await database
      .select()
      .from(boardClimbStats)
      .where(eq(boardClimbStats.climbUuid, canonicalUuid));
    expect(aggregate.upstreamAscensionistCount).toBe(15);
    expect(aggregate.upstreamSyncedAt).toMatch(/^2026-11-08[ T]12:00:00/);
  });
});
