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
    observedAt: `2026-08-30T00:00:${String(seq).padStart(2, '0')}.000Z`,
    stale: false,
    seq,
  };
}

describe('BoardPresenceStore Quantum layer ownership', () => {
  it('does not let a delayed older roster retake the writer slot', async () => {
    const store = createLocalStore();
    await store.commitBoardLayers('123', snapshot(1), 'reporter-a', 'claim-a');
    await store.commitBoardLayers('123', snapshot(2), 'reporter-b', 'claim-b');

    await expect(store.commitBoardLayers('123', snapshot(1), 'reporter-a', 'claim-a')).resolves.toMatchObject({
      accepted: false,
      snapshot: snapshot(2),
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
});
