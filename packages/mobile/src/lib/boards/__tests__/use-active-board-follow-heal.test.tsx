// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';

const state = vi.hoisted(() => ({
  activeBoard: undefined as UserBoard | null | undefined,
  isPending: false,
  isAuthenticated: true,
  storedUserId: 'viewer-1' as string | undefined,
  storage: new Map<string, unknown>(),
  storageReadFails: false,
  flagsResolved: true,
  healKilled: false,
}));

const spies = vi.hoisted(() => ({
  fetchBoardByUuid: vi.fn((): Promise<UserBoard | null> => Promise.resolve(null)),
  followBoard: vi.fn((): Promise<boolean> => Promise.resolve(true)),
  track: vi.fn(),
}));

vi.mock('../../graphql/hooks', () => ({
  fetchBoardByUuid: spies.fetchBoardByUuid,
  useFollowBoard: () => ({ mutateAsync: spies.followBoard }),
}));
vi.mock('../../graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: state.activeBoard, isPending: state.isPending }),
}));
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: state.isAuthenticated }),
}));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useFeatureFlagsResolved: () => state.flagsResolved,
  useActiveBoardFollowHealEnabled: () => !state.healKilled,
}));
vi.mock('../../../hooks/use-current-user-id', () => ({
  useStoredUserId: (enabled: boolean) => ({ userId: enabled ? state.storedUserId : undefined, isLoading: false }),
}));
vi.mock('../../preference-store', () => ({
  getPreference: (key: string) =>
    state.storageReadFails
      ? Promise.reject(new Error('disk'))
      : Promise.resolve(state.storage.has(key) ? state.storage.get(key) : null),
  setPreference: (key: string, value: unknown) => {
    state.storage.set(key, value);
    return Promise.resolve();
  },
}));
vi.mock('../../analytics', () => ({ track: spies.track }));

import {
  ACTIVE_BOARD_FOLLOW_HEAL_STORAGE_KEY,
  resetActiveBoardFollowHealForTests,
  useActiveBoardFollowHeal,
} from '../use-active-board-follow-heal';
import { resetActiveBoardSelfHealValidationCache } from '../active-board-self-heal-validation-cache';

// Someone else's gym board, marked by its setter as a real wall — the board a
// pick before #5654 left bound but unfollowed.
const makeBoard = (over: Partial<UserBoard> = {}): UserBoard =>
  ({
    uuid: 'board-a',
    name: 'Crux Kilter 40°',
    boardType: 'kilter',
    ownerId: 'setter-1',
    isOwned: true,
    isPublic: true,
    isFollowedByMe: false,
    gymUuid: 'gym-1',
    ...over,
  }) as unknown as UserBoard;

/** Let the heal's async chain (storage read, fetch, follow, storage write) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  resetActiveBoardFollowHealForTests();
  state.activeBoard = makeBoard();
  state.isPending = false;
  state.isAuthenticated = true;
  state.storedUserId = 'viewer-1';
  state.storage = new Map();
  state.storageReadFails = false;
  state.flagsResolved = true;
  state.healKilled = false;
  spies.fetchBoardByUuid.mockImplementation(() => Promise.resolve(makeBoard()));
  spies.followBoard.mockImplementation(() => Promise.resolve(true));
});

afterEach(cleanup);

describe('useActiveBoardFollowHeal', () => {
  it("follows the board the app launched on when it is someone else's and not followed", async () => {
    renderHook(() => useActiveBoardFollowHeal());

    await waitFor(() => expect(spies.followBoard).toHaveBeenCalledTimes(1));
    expect(spies.fetchBoardByUuid).toHaveBeenCalledWith('board-a');
    expect(spies.followBoard).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'board-a' }));
    await waitFor(() => expect(state.storage.get(ACTIVE_BOARD_FOLLOW_HEAL_STORAGE_KEY)).toEqual(['viewer-1:board-a']));
    expect(spies.track).toHaveBeenCalledWith('Active Board Follow Healed', { boardType: 'kilter', hasGym: true });
  });

  it('runs once per user and board, across launches', async () => {
    renderHook(() => useActiveBoardFollowHeal());
    await waitFor(() => expect(state.storage.get(ACTIVE_BOARD_FOLLOW_HEAL_STORAGE_KEY)).toBeDefined());
    cleanup();

    // Next launch: the stored snapshot still says "not followed" (it was stored
    // before the follow), but the device remembers the heal.
    resetActiveBoardFollowHealForTests();
    vi.clearAllMocks();
    renderHook(() => useActiveBoardFollowHeal());
    await settle();

    expect(spies.fetchBoardByUuid).not.toHaveBeenCalled();
    expect(spies.followBoard).not.toHaveBeenCalled();
  });

  it('never asks the server about a board the snapshot says the viewer built', async () => {
    state.activeBoard = makeBoard({ ownerId: 'viewer-1' });
    renderHook(() => useActiveBoardFollowHeal());
    await settle();

    expect(spies.fetchBoardByUuid).not.toHaveBeenCalled();
    expect(spies.followBoard).not.toHaveBeenCalled();
  });

  it('never asks the server about a board the snapshot says the viewer follows', async () => {
    state.activeBoard = makeBoard({ isFollowedByMe: true });
    renderHook(() => useActiveBoardFollowHeal());
    await settle();

    expect(spies.fetchBoardByUuid).not.toHaveBeenCalled();
  });

  // The server is the truth: the follow may have happened on another device.
  it('remembers without following when the server says the board is already followed', async () => {
    spies.fetchBoardByUuid.mockImplementation(() => Promise.resolve(makeBoard({ isFollowedByMe: true })));
    renderHook(() => useActiveBoardFollowHeal());

    await waitFor(() => expect(state.storage.get(ACTIVE_BOARD_FOLLOW_HEAL_STORAGE_KEY)).toEqual(['viewer-1:board-a']));
    expect(spies.followBoard).not.toHaveBeenCalled();
    expect(spies.track).not.toHaveBeenCalled();
  });

  it("does not try to follow someone else's private board", async () => {
    spies.fetchBoardByUuid.mockImplementation(() => Promise.resolve(makeBoard({ isPublic: false })));
    renderHook(() => useActiveBoardFollowHeal());

    await waitFor(() => expect(state.storage.get(ACTIVE_BOARD_FOLLOW_HEAL_STORAGE_KEY)).toBeDefined());
    expect(spies.followBoard).not.toHaveBeenCalled();
  });

  // The fleet-wide off switch: a silent server write shipped by OTA needs one.
  it('does nothing when the kill switch is on', async () => {
    state.healKilled = true;
    renderHook(() => useActiveBoardFollowHeal());
    await settle();

    expect(spies.fetchBoardByUuid).not.toHaveBeenCalled();
    expect(spies.followBoard).not.toHaveBeenCalled();
    expect(state.storage.has(ACTIVE_BOARD_FOLLOW_HEAL_STORAGE_KEY)).toBe(false);
  });

  // An unresolved kill switch reads as "on", so acting on the first frame would
  // send the follow before a switch that IS set could stop it.
  it('waits for the flags to resolve before acting', async () => {
    state.flagsResolved = false;
    const { rerender } = renderHook(() => useActiveBoardFollowHeal());
    await settle();
    expect(spies.fetchBoardByUuid).not.toHaveBeenCalled();

    state.flagsResolved = true;
    rerender();
    await waitFor(() => expect(spies.followBoard).toHaveBeenCalledTimes(1));
  });

  it('stays off when the flags resolve with the kill switch set', async () => {
    state.flagsResolved = false;
    const { rerender } = renderHook(() => useActiveBoardFollowHeal());
    await settle();

    state.flagsResolved = true;
    state.healKilled = true;
    rerender();
    await settle();

    expect(spies.fetchBoardByUuid).not.toHaveBeenCalled();
  });

  // The launch board is pinned before the flags answer, so a pick made while
  // PostHog is still loading is not mistaken for the board the app launched on.
  it('still leaves a board picked while the flags were loading to adoption', async () => {
    state.flagsResolved = false;
    state.activeBoard = null;
    const { rerender } = renderHook(() => useActiveBoardFollowHeal());
    await settle();

    state.activeBoard = makeBoard({ uuid: 'board-b' });
    state.flagsResolved = true;
    rerender();
    await settle();

    expect(spies.fetchBoardByUuid).not.toHaveBeenCalled();
  });

  it('does nothing while signed out', async () => {
    state.isAuthenticated = false;
    renderHook(() => useActiveBoardFollowHeal());
    await settle();

    expect(spies.fetchBoardByUuid).not.toHaveBeenCalled();
    expect(spies.followBoard).not.toHaveBeenCalled();
  });

  it('waits for the viewer id before deciding', async () => {
    state.storedUserId = undefined;
    const { rerender } = renderHook(() => useActiveBoardFollowHeal());
    await settle();
    expect(spies.fetchBoardByUuid).not.toHaveBeenCalled();

    state.storedUserId = 'viewer-1';
    rerender();
    await waitFor(() => expect(spies.followBoard).toHaveBeenCalledTimes(1));
  });

  // A board picked this session went through adoption, which follows it. Healing
  // it too would race that follow.
  it('leaves a board picked during the session to adoption', async () => {
    state.activeBoard = null;
    const { rerender } = renderHook(() => useActiveBoardFollowHeal());
    await settle();

    state.activeBoard = makeBoard({ uuid: 'board-b' });
    rerender();
    await settle();

    expect(spies.fetchBoardByUuid).not.toHaveBeenCalled();
  });

  it('decides on the launch board only once the stored board has been read', async () => {
    state.isPending = true;
    state.activeBoard = undefined;
    const { rerender } = renderHook(() => useActiveBoardFollowHeal());
    await settle();

    state.isPending = false;
    state.activeBoard = makeBoard();
    rerender();
    await waitFor(() => expect(spies.followBoard).toHaveBeenCalledTimes(1));
  });

  it('tries again on the next launch when the network is down', async () => {
    spies.fetchBoardByUuid.mockImplementation(() => Promise.reject(new Error('offline')));
    renderHook(() => useActiveBoardFollowHeal());
    await waitFor(() => expect(spies.fetchBoardByUuid).toHaveBeenCalledTimes(1));
    await settle();
    expect(state.storage.has(ACTIVE_BOARD_FOLLOW_HEAL_STORAGE_KEY)).toBe(false);
    cleanup();

    resetActiveBoardFollowHealForTests();
    spies.fetchBoardByUuid.mockImplementation(() => Promise.resolve(makeBoard()));
    renderHook(() => useActiveBoardFollowHeal());
    await waitFor(() => expect(spies.followBoard).toHaveBeenCalledTimes(1));
  });

  it('does not remember a follow the server refused', async () => {
    spies.followBoard.mockImplementation(() => Promise.reject(new Error('Board not found')));
    renderHook(() => useActiveBoardFollowHeal());
    await waitFor(() => expect(spies.followBoard).toHaveBeenCalledTimes(1));
    await settle();

    expect(state.storage.has(ACTIVE_BOARD_FOLLOW_HEAL_STORAGE_KEY)).toBe(false);
    expect(spies.track).not.toHaveBeenCalled();
  });

  // Signing out while the board fetch is in flight must not follow the board
  // for whoever signs in next.
  it('drops a heal that crosses an account boundary', async () => {
    let resolveFetch: (board: UserBoard) => void = () => {};
    spies.fetchBoardByUuid.mockImplementation(
      () =>
        new Promise<UserBoard>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    renderHook(() => useActiveBoardFollowHeal());
    await waitFor(() => expect(spies.fetchBoardByUuid).toHaveBeenCalledTimes(1));

    resetActiveBoardSelfHealValidationCache();
    resolveFetch(makeBoard());
    await settle();

    expect(spies.followBoard).not.toHaveBeenCalled();
    expect(state.storage.has(ACTIVE_BOARD_FOLLOW_HEAL_STORAGE_KEY)).toBe(false);
  });

  // A sign-out after the follow landed: the follow stands, but the device must
  // not write the old account's heal after the boundary. The next launch as that
  // climber costs one read, which finds the board followed and remembers it.
  it('does not remember a follow that settles after an account boundary', async () => {
    let resolveFollow: (followed: boolean) => void = () => {};
    spies.followBoard.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveFollow = resolve;
        }),
    );
    renderHook(() => useActiveBoardFollowHeal());
    await waitFor(() => expect(spies.followBoard).toHaveBeenCalledTimes(1));

    resetActiveBoardSelfHealValidationCache();
    resolveFollow(true);
    await settle();
    expect(state.storage.has(ACTIVE_BOARD_FOLLOW_HEAL_STORAGE_KEY)).toBe(false);
    cleanup();

    // Next launch, same climber. The stored snapshot predates the follow.
    resetActiveBoardFollowHealForTests();
    vi.clearAllMocks();
    spies.fetchBoardByUuid.mockImplementation(() => Promise.resolve(makeBoard({ isFollowedByMe: true })));
    renderHook(() => useActiveBoardFollowHeal());

    await waitFor(() => expect(state.storage.get(ACTIVE_BOARD_FOLLOW_HEAL_STORAGE_KEY)).toEqual(['viewer-1:board-a']));
    expect(spies.fetchBoardByUuid).toHaveBeenCalledTimes(1);
    expect(spies.followBoard).not.toHaveBeenCalled();
  });

  // The tombstone self-heal swaps in the survivor; that board is the launch
  // board on the next start.
  it('leaves a merged-away board to the tombstone self-heal', async () => {
    spies.fetchBoardByUuid.mockImplementation(() => Promise.resolve(makeBoard({ uuid: 'board-survivor' })));
    renderHook(() => useActiveBoardFollowHeal());
    await waitFor(() => expect(spies.fetchBoardByUuid).toHaveBeenCalledTimes(1));
    await settle();

    expect(spies.followBoard).not.toHaveBeenCalled();
    expect(state.storage.has(ACTIVE_BOARD_FOLLOW_HEAL_STORAGE_KEY)).toBe(false);
  });

  it('skips the heal when the device cannot say whether it already ran', async () => {
    state.storageReadFails = true;
    renderHook(() => useActiveBoardFollowHeal());
    await settle();
    await settle();

    expect(spies.fetchBoardByUuid).not.toHaveBeenCalled();
  });

  it('sends one request even when the root remounts mid-heal', async () => {
    const first = renderHook(() => useActiveBoardFollowHeal());
    first.unmount();
    renderHook(() => useActiveBoardFollowHeal());

    await waitFor(() => expect(spies.followBoard).toHaveBeenCalledTimes(1));
    await settle();
    expect(spies.fetchBoardByUuid).toHaveBeenCalledTimes(1);
  });
});
