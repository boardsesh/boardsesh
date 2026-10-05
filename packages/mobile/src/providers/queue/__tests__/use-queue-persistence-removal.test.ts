// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { QueueState } from '@boardsesh/queue';

const snapshots = vi.hoisted(() => ({ generation: 0, get: vi.fn(), set: vi.fn() }));
vi.mock('../../../lib/queue-snapshot-store', () => ({
  getStoredQueueSnapshot: snapshots.get,
  setStoredQueueSnapshot: snapshots.set,
  getQueueSnapshotGeneration: () => snapshots.generation,
}));
vi.mock('../../../lib/session-store', () => ({ getStoredSessionId: async () => null, clearStoredSessionId: vi.fn() }));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: vi.fn() }) }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
import { useQueuePersistence } from '../use-queue-persistence';

it('does not restore a stale cold-start read after active wall removal', async () => {
  snapshots.generation = 0;
  let finishRead: ((snapshot: object) => void) | undefined;
  snapshots.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
  );
  const dispatch = vi.fn();
  const { unmount } = renderHook(() =>
    useQueuePersistence({
      dispatch,
      sessionIdRef: { current: null },
      setSessionId: vi.fn(),
      stateRef: { current: { queue: [], currentClimbQueueItem: null } as unknown as QueueState },
      sessionId: null,
      queue: [],
      currentClimbQueueItem: null,
      playlistSuggestionSource: null,
      setPlaylistSuggestionSourceState: vi.fn(),
      activeBoardSettled: true,
    }),
  );
  await waitFor(() => expect(snapshots.get).toHaveBeenCalled());
  snapshots.generation += 1;
  await act(async () => {
    finishRead?.({
      queue: [{ uuid: 'deleted-wall-climb' }],
      currentClimbQueueItem: null,
      playlistSuggestionSource: null,
    });
  });
  expect(dispatch).not.toHaveBeenCalled();
  unmount();
});
