import { getCredentialGeneration, invalidateCredentialSnapshots } from '../../../lib/privacy/privacy-cache';
// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { QueueAction, QueueState } from '@boardsesh/queue';

// Offline cold start: the profile has not answered, so the queue owner comes from
// the phone, the token's account when the owner stamp names that same account.
const owner = vi.hoisted(() => ({
  getLocalUserId: vi.fn(async (): Promise<string | null> => null),
  readLocalUserId: vi.fn(async (): Promise<string | undefined> => undefined),
}));
vi.mock('../../../db', () => ({ getDatabaseHandle: () => ({}) }));
vi.mock('@boardsesh/offline-sync', () => ({ getLocalUserId: owner.getLocalUserId }));
vi.mock('../../../lib/local-user-id', () => ({ readLocalUserId: owner.readLocalUserId }));

function stampAndToken(stamp: string | null, token: string | undefined) {
  owner.getLocalUserId.mockReset().mockResolvedValue(stamp);
  owner.readLocalUserId.mockReset().mockResolvedValue(token);
}

const snapshots = vi.hoisted(() => ({ generation: 0, get: vi.fn(), set: vi.fn() }));
vi.mock('../../../lib/queue-snapshot-store', () => ({
  getStoredQueueSnapshot: snapshots.get,
  setStoredQueueSnapshot: snapshots.set,
  getQueueSnapshotGeneration: () => snapshots.generation,
}));
const sessions = vi.hoisted(() => ({ get: vi.fn(async () => null), clear: vi.fn() }));
vi.mock('../../../lib/session-store', () => ({
  getStoredSessionId: sessions.get,
  clearStoredSessionId: sessions.clear,
}));
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

function renderOfflineColdStart(dispatch: React.Dispatch<QueueAction>) {
  return renderHook(() =>
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
}

const savedReferences = {
  queue: [{ uuid: 'saved-slot', climb: { uuid: 'saved-climb' } }],
  currentClimbQueueItem: null,
  playlistSuggestionSource: null,
};

it('restores an offline queue when the token and the owner stamp name the same account', async () => {
  snapshots.get.mockReset();
  snapshots.set.mockReset();
  stampAndToken('viewer-a', 'viewer-a');
  snapshots.get.mockResolvedValue(savedReferences);
  const dispatch = vi.fn();
  const { unmount } = renderOfflineColdStart(dispatch);
  await waitFor(() => expect(owner.readLocalUserId).toHaveBeenCalled());
  await waitFor(() => expect(snapshots.get).toHaveBeenCalledWith({ userId: 'viewer-a', authSessionId: '' }));
  await waitFor(() =>
    expect(dispatch).toHaveBeenCalledWith({
      type: 'UPDATE_QUEUE',
      payload: { queue: savedReferences.queue, currentClimbQueueItem: null },
    }),
  );
  unmount();
});

it.each([
  ['the stamp names another account', 'viewer-a', 'viewer-b'],
  ['nothing is stamped', null, 'viewer-b'],
  ['the token names nobody', 'viewer-a', undefined],
])('restores no offline queue when %s', async (_case, stamp, token) => {
  snapshots.get.mockReset();
  snapshots.set.mockReset();
  stampAndToken(stamp, token);
  snapshots.get.mockResolvedValue(savedReferences);
  const dispatch = vi.fn();
  const { unmount } = renderOfflineColdStart(dispatch);
  // The owner decision has run (both reads made), not merely not yet started.
  await waitFor(() => expect(owner.readLocalUserId).toHaveBeenCalled());
  await waitFor(() => expect(owner.getLocalUserId).toHaveBeenCalled());
  await act(async () => {});
  await act(async () => {});
  expect(snapshots.get).not.toHaveBeenCalled();
  expect(snapshots.set).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  unmount();
});

it('reschedules a pending solo save after a sign-in or sign-out', async () => {
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
        credentialGeneration: generation,
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
    { initialProps: { generation: getCredentialGeneration() } },
  );
  await waitFor(() => expect(snapshots.get).toHaveBeenCalled());
  act(() => {
    invalidateCredentialSnapshots();
  });
  rerender({ generation: getCredentialGeneration() });
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

it('leaves saved queues untouched and starts empty in screenshot mode', async () => {
  sessions.get.mockClear();
  sessions.clear.mockClear();
  snapshots.get.mockReset();
  snapshots.set.mockReset();
  snapshots.get.mockResolvedValue({ queue: [{ uuid: 'saved-real-climb' }], currentClimbQueueItem: null });
  vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
  const dispatch = vi.fn();
  const { unmount } = renderHook(() =>
    useQueuePersistence({
      authenticatedUserId: 'viewer-a',
      identityReady: true,
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
  try {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SOLO_QUEUE_SAVE_DEBOUNCE_MS + 30));
    });
    expect(snapshots.get).not.toHaveBeenCalled();
    expect(snapshots.set).not.toHaveBeenCalled();
    expect(sessions.get).not.toHaveBeenCalled();
    expect(sessions.clear).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    unmount();
    vi.unstubAllEnvs();
  }
});
