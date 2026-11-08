import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  CATALOG_DELTA_OVERLAP_MS,
  CatalogWriterLeaseLostError,
  catalogDeltaSince,
  catalogMappingVersion,
  completeCatalogCheckpoint,
  startCatalogBaseline,
  withCatalogWriterLease,
  type CatalogControlWrite,
} from './catalog-control';

type CatalogDb = Parameters<typeof withCatalogWriterLease>[0]['db'];
const render = (fragment: SQL) => new PgDialect().sqlToQuery(fragment).sql;

function databaseFixture(options: { claim?: boolean; renewals?: boolean[] } = {}) {
  const events: string[] = [];
  const conditions: SQL[] = [];
  const assignments: Record<string, unknown>[] = [];
  const renewals = [...(options.renewals ?? [true, true])];
  const claim = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn(async () => (options.claim === false ? [] : [{ ownerId: 'owner' }])),
  };
  const db = {
    insert: vi.fn(() => claim),
    update: vi.fn(() => {
      const query = {
        set: vi.fn((assignment: Record<string, unknown>) => {
          assignments.push(assignment);
          return query;
        }),
        where: vi.fn((condition: SQL) => {
          conditions.push(condition);
          return query;
        }),
        returning: vi.fn(async () => {
          events.push('renew');
          return renewals.shift() ? [{ ownerId: 'owner' }] : [];
        }),
      };
      return query;
    }),
    transaction: vi.fn(async (work: (transaction: CatalogDb) => Promise<unknown>) => {
      events.push('begin');
      try {
        const result = await work(db as unknown as CatalogDb);
        events.push('commit');
        return result;
      } catch (error) {
        events.push('rollback');
        throw error;
      }
    }),
  };
  return { db: db as unknown as CatalogDb, events, conditions, assignments, claim };
}

afterEach(() => vi.useRealTimers());

describe('catalog request checkpoints', () => {
  it('overlaps the request-start watermark by exactly five minutes', () => {
    const startedAt = new Date('2026-11-08T12:00:00Z');
    expect(catalogDeltaSince(startedAt).toISOString()).toBe('2026-11-08T11:55:00.000Z');
    expect(startedAt.getTime() - catalogDeltaSince(startedAt).getTime()).toBe(CATALOG_DELTA_OVERLAP_MS);
    expect(() => catalogDeltaSince(new Date('invalid'))).toThrow('Invalid catalog checkpoint');
  });

  it('changes the scope version when any resolved mapping changes', () => {
    const mapping = [['layout-a', 1]];
    expect(catalogMappingVersion(mapping)).toBe(catalogMappingVersion([['layout-a', 1]]));
    expect(catalogMappingVersion(mapping)).not.toBe(catalogMappingVersion([['layout-a', 2]]));
  });

  it('withdraws old certification before a new baseline begins', async () => {
    const { db, claim } = databaseFixture();
    const write: CatalogControlWrite = (work) => db.transaction(work);
    const startedAt = new Date('2026-11-08T12:00:00Z');
    await startCatalogBaseline(write, { scopeKey: 'product:edges', mappingVersion: 'v2' }, startedAt);
    expect(claim.values).toHaveBeenCalledWith({
      scopeKey: 'product:edges',
      mappingVersion: 'v2',
      baselineStartedAt: startedAt,
    });
    expect(claim.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({ baselineCompletedAt: null, confirmedThrough: null, mappingVersion: 'v2' }),
      }),
    );
  });

  it('rejects progress for a missing baseline or changed scope', async () => {
    const { db, conditions } = databaseFixture({ renewals: [false] });
    const write: CatalogControlWrite = (work) => db.transaction(work);
    await expect(
      completeCatalogCheckpoint(write, { scopeKey: 'product:edges', mappingVersion: 'v2' }, new Date()),
    ).rejects.toThrow('no matching complete baseline');
    expect(render(conditions[0])).toContain('"baseline_completed_at" IS NOT NULL');
    expect(render(conditions[0])).toContain('"mapping_version"');
  });
});

describe('catalog writer lease', () => {
  it('checks database-clock ownership around each transaction inside the attempt fence', async () => {
    const { db, events, conditions } = databaseFixture();
    const attemptFence: CatalogControlWrite = (work) => {
      events.push('attempt');
      return db.transaction(work);
    };
    const result = await withCatalogWriterLease({ db, transaction: attemptFence }, ({ write }) =>
      write(async () => {
        events.push('write');
        return 42;
      }),
    );
    expect(result).toBe(42);
    expect(events).toEqual(['attempt', 'begin', 'commit', 'attempt', 'begin', 'renew', 'write', 'renew', 'commit']);
    for (const condition of conditions.slice(0, 2)) {
      expect(render(condition)).toContain('"owner_id"');
      expect(render(condition)).toContain('"lease_until" > clock_timestamp()');
    }
  });

  it('never enters work when another live owner holds the lease', async () => {
    const { db } = databaseFixture({ claim: false });
    const callback = vi.fn();
    await expect(withCatalogWriterLease({ db }, callback)).rejects.toBeInstanceOf(CatalogWriterLeaseLostError);
    expect(callback).not.toHaveBeenCalled();
  });

  it('rolls back a write that outlives its lease', async () => {
    const { db, events } = databaseFixture({ renewals: [true, false] });
    await expect(
      withCatalogWriterLease({ db }, ({ write }) =>
        write(async () => {
          events.push('write');
        }),
      ),
    ).rejects.toBeInstanceOf(CatalogWriterLeaseLostError);
    expect(events.slice(-4)).toEqual(['renew', 'write', 'renew', 'rollback']);
  });

  it('aborts outstanding reads after heartbeat takeover or provider cancellation', async () => {
    vi.useFakeTimers();
    const { db } = databaseFixture({ renewals: [false] });
    const work = withCatalogWriterLease({ db }, async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      signal.throwIfAborted();
    });
    const rejection = expect(work).rejects.toBeInstanceOf(CatalogWriterLeaseLostError);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
  });
});
