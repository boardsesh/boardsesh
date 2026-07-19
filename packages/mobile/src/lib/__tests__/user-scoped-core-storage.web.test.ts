import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { UserStorageOwner } from '../user-storage-owner';

type DeleteBarrier = { promise: Promise<void>; release: () => void };

function createDeleteBarrier(): DeleteBarrier {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const storageState = vi.hoisted(() => ({
  secure: new Map<string, string>(),
  preferences: new Map<string, string>(),
  secureDeleteBarriers: new Map<string, Promise<void>>(),
  preferenceDeleteBarriers: new Map<string, Promise<void>>(),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => storageState.secure.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    storageState.secure.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    await storageState.secureDeleteBarriers.get(key);
    storageState.secure.delete(key);
  }),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storageState.preferences.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storageState.preferences.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      await storageState.preferenceDeleteBarriers.get(key);
      storageState.preferences.delete(key);
    }),
    getAllKeys: vi.fn(async () => Array.from(storageState.preferences.keys())),
    removeMany: vi.fn(async (keys: string[]) => {
      for (const key of keys) storageState.preferences.delete(key);
    }),
  },
}));

const userALogin: UserStorageOwner = { userId: 'user-a', authSessionId: 'login-a' };
const userBLogin: UserStorageOwner = { userId: 'user-b', authSessionId: 'login-b' };
const newerUserALogin: UserStorageOwner = { userId: 'user-a', authSessionId: 'login-a-new' };
const boardA = { uuid: 'board-a', name: 'A board' } as unknown as UserBoard;
const boardB = { uuid: 'board-b', name: 'B board' } as unknown as UserBoard;

beforeEach(async () => {
  storageState.secure.clear();
  storageState.preferences.clear();
  storageState.secureDeleteBarriers.clear();
  storageState.preferenceDeleteBarriers.clear();
  const { setCurrentUserStorageOwner } = await import('../user-storage-owner.web');
  setCurrentUserStorageOwner(null);
});

describe('browser login-scoped core persistence', () => {
  it('never hydrates A session, board, or queue during a cold start as B', async () => {
    const { setCurrentUserStorageOwner } = await import('../user-storage-owner.web');
    const { getStoredSessionId, setStoredSessionId } = await import('../session-store.web');
    const { getStoredActiveBoard, setStoredActiveBoard } = await import('../active-board-store.web');
    const { getStoredQueueSnapshot, setStoredQueueSnapshot } = await import('../queue-snapshot-store.web');

    setCurrentUserStorageOwner(userALogin);
    await setStoredSessionId('session-a');
    await setStoredActiveBoard(boardA);
    await setStoredQueueSnapshot({ queue: [], currentClimbQueueItem: null, playlistSuggestionSource: null });

    // A closes, then the app loads from scratch with B's settled NextAuth login.
    setCurrentUserStorageOwner(null);
    setCurrentUserStorageOwner(userBLogin);

    await expect(getStoredSessionId()).resolves.toBeNull();
    await expect(getStoredActiveBoard()).resolves.toBeNull();
    await expect(getStoredQueueSnapshot()).resolves.toBeNull();
  });

  it('ignores legacy unowned values instead of assigning them to the next login', async () => {
    storageState.secure.set('boardsesh_active_session_id', 'legacy-session');
    storageState.preferences.set('boardsesh_active_board_v2', JSON.stringify(boardA));
    storageState.preferences.set(
      'boardsesh_local_queue_snapshot_v1',
      JSON.stringify({ queue: [], currentClimbQueueItem: null, playlistSuggestionSource: null }),
    );
    const { setCurrentUserStorageOwner } = await import('../user-storage-owner.web');
    const { getStoredSessionId } = await import('../session-store.web');
    const { getStoredActiveBoard } = await import('../active-board-store.web');
    const { getStoredQueueSnapshot } = await import('../queue-snapshot-store.web');
    setCurrentUserStorageOwner(userBLogin);

    await expect(getStoredSessionId()).resolves.toBeNull();
    await expect(getStoredActiveBoard()).resolves.toBeNull();
    await expect(getStoredQueueSnapshot()).resolves.toBeNull();
  });

  it('reclaims a prior login of the same user only after the retention window', async () => {
    const { sweepOrphanedUserStorage } = await import('../user-storage-owner.web');
    const { getStoredActiveBoard, setStoredActiveBoard } = await import('../active-board-store.web');
    const { getStoredQueueSnapshot, setStoredQueueSnapshot } = await import('../queue-snapshot-store.web');

    const startTime = 1_000_000_000_000;
    const beyondRetention = startTime + 31 * 24 * 60 * 60 * 1000;

    // Old login of user A, plus a live login for user B in another tab; both
    // recorded as active at startTime.
    await setStoredActiveBoard(boardA, userALogin);
    await setStoredQueueSnapshot(
      { queue: [], currentClimbQueueItem: null, playlistSuggestionSource: null },
      userALogin,
    );
    await setStoredActiveBoard(boardB, userBLogin);
    await sweepOrphanedUserStorage(userALogin, startTime);
    await sweepOrphanedUserStorage(userBLogin, startTime);

    // A rapid re-login as user A right away must NOT drop the old scope — a
    // concurrent tab could still own it.
    await sweepOrphanedUserStorage(newerUserALogin, startTime + 1000);
    await expect(getStoredActiveBoard(userALogin)).resolves.toEqual(boardA);

    // Once the old A login has been inactive past the window, it is reclaimed;
    // the new A login and (older, other-user) B are preserved.
    await sweepOrphanedUserStorage(newerUserALogin, beyondRetention);
    await expect(getStoredActiveBoard(userALogin)).resolves.toBeNull();
    await expect(getStoredQueueSnapshot(userALogin)).resolves.toBeNull();
    await expect(getStoredActiveBoard(userBLogin)).resolves.toEqual(boardB);

    // A fresh write under the new A login survives a repeat sweep.
    await setStoredActiveBoard(boardA, newerUserALogin);
    await sweepOrphanedUserStorage(newerUserALogin, beyondRetention);
    await expect(getStoredActiveBoard(newerUserALogin)).resolves.toEqual(boardA);
  });

  it('re-runs the sweep after a sign-out, even for the same user (dedup reset)', async () => {
    const { setCurrentUserStorageOwner } = await import('../user-storage-owner.web');
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      setItem: ReturnType<typeof vi.fn>;
    };
    asyncStorage.setItem.mockClear();
    const activityIndexWrites = () =>
      asyncStorage.setItem.mock.calls.filter(([key]) => key === 'boardsesh_web_owner_activity_v1').length;

    setCurrentUserStorageOwner(userALogin);
    await vi.waitFor(() => expect(activityIndexWrites()).toBe(1));

    // Re-setting the same owner without a sign-out is deduped — no new sweep.
    setCurrentUserStorageOwner(userALogin);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(activityIndexWrites()).toBe(1);

    // A sign-out (null owner) resets the dedup, so the next sign-in sweeps again.
    setCurrentUserStorageOwner(null);
    setCurrentUserStorageOwner(userALogin);
    await vi.waitFor(() => expect(activityIndexWrites()).toBe(2));
  });

  it('keeps a newer login write when another tab finishes deleting the old login scope', async () => {
    const { userScopedStorageKey } = await import('../user-storage-owner.web');
    const { clearStoredSessionId, getStoredSessionId, setStoredSessionId } = await import('../session-store.web');
    const { clearStoredActiveBoard, getStoredActiveBoard, setStoredActiveBoard } =
      await import('../active-board-store.web');

    await setStoredSessionId('old-session', userALogin);
    await setStoredActiveBoard(boardA, userALogin);
    const oldSessionKey = userScopedStorageKey('boardsesh_active_session_id', userALogin);
    const oldBoardKey = userScopedStorageKey('boardsesh_active_board_v2', userALogin);
    if (!oldSessionKey || !oldBoardKey) throw new Error('expected scoped storage keys');
    const sessionDelete = createDeleteBarrier();
    const boardDelete = createDeleteBarrier();
    storageState.secureDeleteBarriers.set(oldSessionKey, sessionDelete.promise);
    storageState.preferenceDeleteBarriers.set(oldBoardKey, boardDelete.promise);

    const delayedSessionClear = clearStoredSessionId(userALogin);
    const delayedBoardClear = clearStoredActiveBoard(userALogin);
    await setStoredSessionId('new-session', newerUserALogin);
    await setStoredActiveBoard(boardB, newerUserALogin);
    sessionDelete.release();
    boardDelete.release();
    await Promise.all([delayedSessionClear, delayedBoardClear]);

    await expect(getStoredSessionId(newerUserALogin)).resolves.toBe('new-session');
    await expect(getStoredActiveBoard(newerUserALogin)).resolves.toEqual(boardB);
  });
});
