import { describe, expect, it, vi } from 'vitest';
import { BoardPresenceStore } from '../board-presence-store';

function createLocalStore(): BoardPresenceStore {
  return new BoardPresenceStore({
    isRedisAvailable: () => false,
    isRedisRequired: () => false,
    logger: { error: vi.fn(), warn: vi.fn() },
  });
}

function snapshot(seq: number) {
  return {
    boardId: 123,
    layers: [],
    observedAt: new Date().toISOString(),
    stale: false,
    seq,
  };
}

describe('BoardPresenceStore Quantum layer ownership', () => {
  it('does not let a delayed older roster retake the writer slot', async () => {
    const store = createLocalStore();
    await store.commitBoardLayers('123', snapshot(1), 'reporter-a', 'claim-a');
    const newestSnapshot = snapshot(2);
    await store.commitBoardLayers('123', newestSnapshot, 'reporter-b', 'claim-b');

    await expect(store.commitBoardLayers('123', snapshot(1), 'reporter-a', 'claim-a')).resolves.toMatchObject({
      accepted: false,
      snapshot: newestSnapshot,
    });
    await expect(store.getBoardWriter('123')).resolves.toBe('reporter-b');
  });

  it('does not let an old same-user socket clear or stale a reconnect roster', async () => {
    const store = createLocalStore();
    await store.commitBoardLayers('123', snapshot(1), 'shared-user', 'old-connection');
    const newerSnapshot = snapshot(2);
    await store.commitBoardLayers('123', newerSnapshot, 'shared-user', 'new-connection');

    await expect(store.clearBoardWriterIf('123', 'shared-user', 'old-connection')).resolves.toBe(false);
    await expect(
      store.markBoardLayersStaleIfOwned('123', 'old-connection', { ...newerSnapshot, stale: true, seq: 3 }),
    ).resolves.toEqual({ snapshot: newerSnapshot, changed: false });
    await expect(store.getBoardLayers('123')).resolves.toEqual(newerSnapshot);
    await expect(store.getBoardWriter('123')).resolves.toBe('shared-user');
  });

  it('ages countdowns, prunes expired layers, and stales missed heartbeats', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T00:00:00.000Z'));
    try {
      const store = createLocalStore();
      await store.commitBoardLayers(
        '123',
        {
          ...snapshot(1),
          layers: [
            {
              color: '#00FF00',
              remainingSeconds: 120,
              climbUuid: null,
              angle: null,
              geometryKnown: false,
              placementIds: [],
            },
          ],
        },
        'reporter-a',
        'claim-a',
      );

      vi.setSystemTime(new Date('2026-08-30T00:00:31.000Z'));
      await expect(store.getBoardLayers('123')).resolves.toMatchObject({
        stale: true,
        layers: [{ remainingSeconds: 89 }],
      });

      vi.setSystemTime(new Date('2026-08-30T00:02:01.000Z'));
      await expect(store.getBoardLayers('123')).resolves.toMatchObject({ stale: true, layers: [] });
    } finally {
      vi.useRealTimers();
    }
  });
});
