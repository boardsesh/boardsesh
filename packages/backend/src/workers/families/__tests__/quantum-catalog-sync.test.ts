import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbInstance } from '@boardsesh/db/client';
import type { BackgroundJobContext } from '../types';
import { quantumCatalogSyncFamily } from '../quantum-catalog-sync';

const syncCatalog = vi.hoisted(() => vi.fn());
vi.mock('../../../services/ewalls-catalog-sync', () => ({ syncQuantumCatalogOnce: syncCatalog }));

beforeEach(() => {
  syncCatalog.mockReset();
  vi.stubEnv('FEATURE_FLAG_OVERRIDES', 'quantum-catalog-sync');
});
afterEach(() => vi.unstubAllEnvs());

describe('Quantum catalog shared-worker integration', () => {
  it('uses the existing routine worker and one six-hour schedule', async () => {
    expect(quantumCatalogSyncFamily.roles).toEqual(['routine-provider']);
    expect(quantumCatalogSyncFamily.singletonKey?.({})).toBe('quantum');
    expect(quantumCatalogSyncFamily.payload.safeParse({}).success).toBe(true);
    expect(quantumCatalogSyncFamily.payload.safeParse({ source: 'foreign' }).success).toBe(false);
    expect(quantumCatalogSyncFamily.schedules).toHaveLength(1);
    expect(quantumCatalogSyncFamily.schedules?.[0].cron).toBe('43 */6 * * *');
    expect(await quantumCatalogSyncFamily.schedules?.[0].fanOut({} as DbInstance)).toEqual([{ payload: {} }]);
  });

  it('passes every catalog transaction through the active job attempt fence', async () => {
    const attemptLost = new Error('attempt no longer owns its run');
    const transaction = vi.fn(async () => {
      throw attemptLost;
    });
    const context: BackgroundJobContext = {
      runId: 'quantum-run',
      family: 'quantum-catalog-sync',
      signal: new AbortController().signal,
      expiresAt: Date.now() + 600_000,
      database: {} as DbInstance,
      transaction,
      enqueue: async () => {
        throw new Error('unexpected enqueue');
      },
    };
    syncCatalog.mockImplementation(async (options: { transaction: BackgroundJobContext['transaction'] }) => {
      await options.transaction(async () => undefined);
    });
    await expect(quantumCatalogSyncFamily.execute(context, {})).rejects.toBe(attemptLost);
    expect(transaction).toHaveBeenCalledOnce();
    expect(syncCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ database: context.database, signal: context.signal }),
    );
  });

  it.each(['quantum-catalog-sync=false', 'quantum-catalog-sync=variant'])(
    'skips fan-out and a previously queued job when the switch is %s',
    async (override) => {
      vi.stubEnv('FEATURE_FLAG_OVERRIDES', override);
      const transaction = vi.fn();
      expect(await quantumCatalogSyncFamily.schedules?.[0].fanOut({} as DbInstance)).toEqual([]);
      await quantumCatalogSyncFamily.execute(
        {
          runId: 'queued-run',
          family: 'quantum-catalog-sync',
          signal: new AbortController().signal,
          expiresAt: Date.now() + 600_000,
          database: {} as DbInstance,
          transaction,
          enqueue: vi.fn(),
        },
        {},
      );
      expect(transaction).not.toHaveBeenCalled();
      expect(syncCatalog).not.toHaveBeenCalled();
    },
  );
});
