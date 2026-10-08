import { getPrivacyRevocationGeneration, invalidatePrivacySnapshots } from '../../../lib/privacy/privacy-cache';
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { QueueState } from '@boardsesh/queue';

const catalog = vi.hoisted(() => ({ viewer: vi.fn(async (): Promise<string | null> => null) }));
vi.mock('../../../db', () => ({ getDatabaseHandle: () => ({}) }));
vi.mock('../../../offline/catalog-access', () => ({ getAuthorizedCatalogViewerId: catalog.viewer }));

const snapshots = vi.hoisted(() => ({ generation: 0, get: vi.fn(), set: vi.fn() }));
vi.mock('../../../lib/queue-snapshot-store', () => ({
  getStoredQueueSnapshot: snapshots.get,
  setStoredQueueSnapshot: snapshots.set,
  getQueueSnapshotGeneration: () => snapshots.generation,
}));
vi.mock('../../../lib/session-store', () => ({ getStoredSessionId: async () => null, clearStoredSessionId: vi.fn() }));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: vi.fn() }) }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
import { useQueuePersistence, SOLO_QUEUE_SAVE_DEBOUNCE_MS } from '../use-queue-persistence';

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

it('waits for a signed-in owner without overwriting their queue while the profile loads', async () => {
  snapshots.get.mockReset();
  snapshots.set.mockReset();
  snapshots.get.mockResolvedValue({ queue: [], currentClimbQueueItem: null, playlistSuggestionSource: null });
  const dispatch = vi.fn();
  const stateRef = { current: { queue: [], currentClimbQueueItem: null } as unknown as QueueState };
  const { rerender, unmount } = renderHook(
    ({ ready, userId }: { ready: boolean; userId: string | null }) =>
      useQueuePersistence({
        authenticatedUserId: userId,
        identityReady: ready,
        dispatch,
        sessionIdRef: { current: null },
        setSessionId: vi.fn(),
        stateRef,
        sessionId: null,
        queue: [],
        currentClimbQueueItem: null,
        playlistSuggestionSource: null,
        setPlaylistSuggestionSourceState: vi.fn(),
        activeBoardSettled: true,
      }),
    { initialProps: { ready: false, userId: null as string | null } },
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SOLO_QUEUE_SAVE_DEBOUNCE_MS + 30));
  });
  expect(snapshots.get).not.toHaveBeenCalled();
  expect(snapshots.set).not.toHaveBeenCalled();
  rerender({ ready: true, userId: 'viewer-a' });
  await waitFor(() => expect(snapshots.get).toHaveBeenCalledWith({ userId: 'viewer-a', authSessionId: '' }));
  await waitFor(() => expect(dispatch).toHaveBeenCalled());
  unmount();
});

it('restores an offline queue using the credential-bound catalogue viewer', async () => {
  snapshots.get.mockReset();
  snapshots.set.mockReset();
  catalog.viewer.mockResolvedValueOnce('verified-viewer');
  const references = {
    queue: [{ uuid: 'saved-slot', climb: { uuid: 'saved-climb' } }],
    currentClimbQueueItem: null,
    playlistSuggestionSource: null,
  };
  snapshots.get.mockResolvedValue(references);
  const dispatch = vi.fn();
  const { unmount } = renderHook(() =>
    useQueuePersistence({
      authenticatedUserId: null,
      identityReady: false,
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
  await waitFor(() => expect(snapshots.get).toHaveBeenCalledWith({ userId: 'verified-viewer', authSessionId: '' }));
  expect(dispatch).toHaveBeenCalledWith({
    type: 'UPDATE_QUEUE',
    payload: { queue: references.queue, currentClimbQueueItem: null },
  });
  unmount();
});

it('reschedules a pending solo save after privacy revalidation completes', async () => {
  snapshots.get.mockReset();
  snapshots.set.mockReset();
  snapshots.get.mockResolvedValue(null);
  const queue = [{ uuid: 'retained-slot', climb: { uuid: 'retained-climb' } }] as QueueState['queue'];
  const stateRef = { current: { queue, currentClimbQueueItem: null } as unknown as QueueState };
  const { rerender, unmount } = renderHook(
    ({ generation }: { generation: number }) =>
      useQueuePersistence({
        authenticatedUserId: 'viewer',
        identityReady: true,
        privacyRevocationGeneration: generation,
        dispatch: vi.fn(),
        sessionIdRef: { current: null },
        setSessionId: vi.fn(),
        stateRef,
        sessionId: null,
        queue,
        currentClimbQueueItem: null,
        playlistSuggestionSource: null,
        setPlaylistSuggestionSourceState: vi.fn(),
        activeBoardSettled: true,
      }),
    { initialProps: { generation: getPrivacyRevocationGeneration() } },
  );
  await waitFor(() => expect(snapshots.get).toHaveBeenCalled());
  act(() => {
    invalidatePrivacySnapshots();
  });
  rerender({ generation: getPrivacyRevocationGeneration() });
  await waitFor(() => expect(snapshots.get).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(snapshots.set).toHaveBeenCalledWith(
      { queue, currentClimbQueueItem: null, playlistSuggestionSource: null },
      { userId: 'viewer', authSessionId: '' },
      snapshots.generation,
    ),
  );
  unmount();
});
