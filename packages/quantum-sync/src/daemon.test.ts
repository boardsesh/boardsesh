import { describe, expect, it, vi } from 'vitest';
import { runQuantumSyncDaemon } from './daemon';

describe('Quantum sync daemon', () => {
  it('runs immediately and then schedules the fixed 360-minute interval', async () => {
    const controller = new AbortController();
    const cycle = vi.fn(async () => controller.abort());
    const sleeps: number[] = [];

    await runQuantumSyncDaemon(
      cycle,
      {},
      {
        signal: controller.signal,
        now: () => new Date('2026-08-30T09:00:00.000Z'),
        sleep: async (milliseconds, signal) => {
          sleeps.push(milliseconds);
          if (signal?.aborted) {
            const error = new Error('aborted');
            error.name = 'AbortError';
            throw error;
          }
        },
      },
    );

    expect(cycle).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([360 * 60_000]);
  });

  it('rejects a non-positive interval', async () => {
    await expect(runQuantumSyncDaemon(async () => {}, { intervalMinutes: 0 })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });
});
