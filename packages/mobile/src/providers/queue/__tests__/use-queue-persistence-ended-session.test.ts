// @vitest-environment jsdom
// A cold start onto a stored session that ended meanwhile (#6903): the id is
// dropped without ever being set, so the restore announces it for the workout
// run to end too.
import { expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { QueueState } from '@boardsesh/queue';

vi.mock('../../../db', () => ({ getDatabaseHandle: () => ({}) }));
vi.mock('@boardsesh/offline-sync', () => ({ getLocalUserId: async () => null }));
vi.mock('../../../lib/local-user-id', () => ({ readLocalUserId: async () => undefined }));
vi.mock('../../../lib/queue-snapshot-store', () => ({
  getStoredQueueSnapshot: async () => null,
  setStoredQueueSnapshot: vi.fn(),
  getQueueSnapshotGeneration: () => 0,
}));
const sessions = vi.hoisted(() => ({
  status: 'ended' as string | null,
  clear: vi.fn(async () => undefined),
  announce: vi.fn(),
}));
vi.mock('../../../lib/session-store', () => ({
  getStoredSessionId: async () => 'stored-session',
  clearStoredSessionId: sessions.clear,
}));
vi.mock('../../../lib/graphql/client', () => ({
  getHttpClient: () => ({ request: async () => ({ sessionStatus: sessions.status }) }),
}));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../lib/ended-session-signal', () => ({ announceStoredSessionEnded: sessions.announce }));
import { useQueuePersistence } from '../use-queue-persistence';

function renderPersistence(setSessionId = vi.fn()) {
  return renderHook(() =>
    useQueuePersistence({
      dispatch: vi.fn(),
      sessionIdRef: { current: null },
      setSessionId,
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

it.each(['ended', null])('announces a stored session the server reports %s, without rejoining it', async (status) => {
  sessions.status = status;
  sessions.announce.mockClear();
  const setSessionId = vi.fn();
  const { unmount } = renderPersistence(setSessionId);
  await waitFor(() => expect(sessions.announce).toHaveBeenCalledExactlyOnceWith('stored-session'));
  expect(sessions.clear).toHaveBeenCalled();
  expect(setSessionId).not.toHaveBeenCalled();
  unmount();
});

it('announces nothing for a session still going', async () => {
  sessions.status = 'active';
  sessions.announce.mockClear();
  const setSessionId = vi.fn();
  const { unmount } = renderPersistence(setSessionId);
  await waitFor(() => expect(setSessionId).toHaveBeenCalledWith('stored-session'));
  expect(sessions.announce).not.toHaveBeenCalled();
  unmount();
});
