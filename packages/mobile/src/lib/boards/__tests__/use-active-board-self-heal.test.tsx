// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';

const mocks = vi.hoisted(() => ({
  fetchBoardByUuid: vi.fn(),
  activeBoard: null as UserBoard | null,
  setActiveBoard: vi.fn(),
  clearActiveBoard: vi.fn(),
  writeGeneration: 0,
}));

const appState = vi.hoisted(() => {
  const state = { listener: null as ((nextState: string) => void) | null };
  return {
    state,
    addEventListener: vi.fn((_event: string, listener: (nextState: string) => void) => {
      state.listener = listener;
      return {
        remove: vi.fn(() => {
          state.listener = null;
        }),
      };
    }),
  };
});

vi.mock('../../graphql/hooks', () => ({ fetchBoardByUuid: mocks.fetchBoardByUuid }));
vi.mock('../../graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: mocks.activeBoard }),
  getActiveBoardWriteGeneration: () => mocks.writeGeneration,
  useSetActiveBoardIfCurrentGeneration: () => async (expectedGeneration: number, boardToSet: UserBoard) => {
    if (expectedGeneration !== mocks.writeGeneration) return false;
    mocks.writeGeneration += 1;
    await mocks.setActiveBoard(boardToSet);
    return true;
  },
  useClearActiveBoardIfCurrentGeneration: () => async (expectedGeneration: number) => {
    if (expectedGeneration !== mocks.writeGeneration) return false;
    mocks.writeGeneration += 1;
    await mocks.clearActiveBoard();
    return true;
  },
}));
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: appState.addEventListener },
}));

import { resetActiveBoardSelfHealValidationCache } from '../active-board-self-heal-validation-cache';
import { useActiveBoardSelfHeal, resetActiveBoardSelfHealForTests } from '../use-active-board-self-heal';

function board(uuid: string): UserBoard {
  return { uuid, boardType: 'kilter', layoutId: 1, sizeId: 2, setIds: '3,4', name: 'Wall' } as unknown as UserBoard;
}

describe('useActiveBoardSelfHeal', () => {
  beforeEach(() => {
    resetActiveBoardSelfHealForTests();
    mocks.fetchBoardByUuid.mockReset();
    mocks.setActiveBoard.mockReset().mockResolvedValue(undefined);
    mocks.clearActiveBoard.mockReset().mockResolvedValue(undefined);
    mocks.activeBoard = null;
    mocks.writeGeneration = 0;
    appState.state.listener = null;
    appState.addEventListener.mockClear();
  });

  it('re-persists the canonical board when the resolved uuid differs (merge tombstone)', async () => {
    mocks.activeBoard = board('loser-uuid');
    mocks.fetchBoardByUuid.mockResolvedValue(board('canonical-uuid'));

    renderHook(() => useActiveBoardSelfHeal());

    await waitFor(() => expect(mocks.setActiveBoard).toHaveBeenCalledTimes(1));
    expect(mocks.setActiveBoard.mock.calls[0][0].uuid).toBe('canonical-uuid');
    expect(mocks.clearActiveBoard).not.toHaveBeenCalled();
  });

  it('clears the stored board when the fetch returns null (plainly deleted)', async () => {
    mocks.activeBoard = board('gone-uuid');
    mocks.fetchBoardByUuid.mockResolvedValue(null);

    renderHook(() => useActiveBoardSelfHeal());

    await waitFor(() => expect(mocks.clearActiveBoard).toHaveBeenCalledTimes(1));
    expect(mocks.setActiveBoard).not.toHaveBeenCalled();
  });

  it('leaves the stored board untouched when the uuid still matches', async () => {
    mocks.activeBoard = board('same-uuid');
    mocks.fetchBoardByUuid.mockResolvedValue(board('same-uuid'));

    renderHook(() => useActiveBoardSelfHeal());

    await waitFor(() => expect(mocks.fetchBoardByUuid).toHaveBeenCalledTimes(1));
    expect(mocks.setActiveBoard).not.toHaveBeenCalled();
    expect(mocks.clearActiveBoard).not.toHaveBeenCalled();
  });

  it('does nothing when there is no stored active board', () => {
    mocks.activeBoard = null;
    renderHook(() => useActiveBoardSelfHeal());
    expect(mocks.fetchBoardByUuid).not.toHaveBeenCalled();
  });

  it('does not ask the account API to validate an installation-owned local board', () => {
    mocks.activeBoard = {
      ...board('local-board-uuid'),
      origin: 'local',
      ownerId: 'local-profile-uuid',
      angle: 40,
      createdAt: '2026-08-30T00:00:00.000Z',
    } as UserBoard;

    renderHook(() => useActiveBoardSelfHeal());

    expect(mocks.fetchBoardByUuid).not.toHaveBeenCalled();
    expect(mocks.setActiveBoard).not.toHaveBeenCalled();
    expect(mocks.clearActiveBoard).not.toHaveBeenCalled();
  });

  it('runs at most once per session across mounts', async () => {
    mocks.activeBoard = board('first-uuid');
    mocks.fetchBoardByUuid.mockResolvedValue(board('first-uuid'));

    const first = renderHook(() => useActiveBoardSelfHeal());
    await waitFor(() => expect(mocks.fetchBoardByUuid).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    first.unmount();

    renderHook(() => useActiveBoardSelfHeal());
    // Still one call — the module-level guard suppresses the re-run.
    expect(mocks.fetchBoardByUuid).toHaveBeenCalledTimes(1);
  });

  it('validates the same uuid again after an authenticated-account boundary', async () => {
    mocks.activeBoard = board('shared-board-uuid');
    mocks.fetchBoardByUuid.mockResolvedValue(board('shared-board-uuid'));

    const previousAccountHook = renderHook(() => useActiveBoardSelfHeal());
    await waitFor(() => expect(mocks.fetchBoardByUuid).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    previousAccountHook.unmount();

    resetActiveBoardSelfHealValidationCache();
    renderHook(() => useActiveBoardSelfHeal());

    await waitFor(() => expect(mocks.fetchBoardByUuid).toHaveBeenCalledTimes(2));
    expect(mocks.fetchBoardByUuid).toHaveBeenLastCalledWith('shared-board-uuid');
  });

  it('blocks queued and foreground retries from a mounted old-account hook after reset', async () => {
    let resolvePreviousAccountBoard: ((resolved: UserBoard) => void) | undefined;
    mocks.activeBoard = board('shared-pending-uuid');
    mocks.fetchBoardByUuid
      .mockImplementationOnce(
        () =>
          new Promise<UserBoard>((resolve) => {
            resolvePreviousAccountBoard = resolve;
          }),
      )
      .mockResolvedValueOnce(board('shared-pending-uuid'));

    const previousAccountHook = renderHook(() => useActiveBoardSelfHeal());
    await waitFor(() => expect(mocks.fetchBoardByUuid).toHaveBeenCalledTimes(1));

    // Queue a retry against the old account while its first validation is in
    // flight. Native keeps this root hook mounted while auth cleanup awaits.
    await act(async () => {
      appState.state.listener?.('active');
    });
    resetActiveBoardSelfHealValidationCache();
    // A foreground event during cleanup must not capture the reset epoch either.
    await act(async () => {
      appState.state.listener?.('active');
    });
    await act(async () => {
      resolvePreviousAccountBoard?.(board('shared-pending-uuid'));
      await Promise.resolve();
    });

    // Settling the old request must discard its queued retry and cannot mark the
    // UUID in the new account's cache, even though this hook is still mounted.
    expect(mocks.fetchBoardByUuid).toHaveBeenCalledTimes(1);
    await act(async () => {
      appState.state.listener?.('active');
    });
    expect(mocks.fetchBoardByUuid).toHaveBeenCalledTimes(1);

    previousAccountHook.unmount();

    // The next authenticated tree binds to the reset epoch and validates the
    // same UUID instead of inheriting an old-account cache result.
    renderHook(() => useActiveBoardSelfHeal());
    await waitFor(() => expect(mocks.fetchBoardByUuid).toHaveBeenCalledTimes(2));
    expect(mocks.fetchBoardByUuid).toHaveBeenLastCalledWith('shared-pending-uuid');
  });

  it('leaves the stored board as-is when the fetch throws (transient failure)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.activeBoard = board('net-uuid');
    mocks.fetchBoardByUuid.mockRejectedValue(new Error('offline'));

    renderHook(() => useActiveBoardSelfHeal());

    await waitFor(() => expect(mocks.fetchBoardByUuid).toHaveBeenCalledTimes(1));
    expect(mocks.setActiveBoard).not.toHaveBeenCalled();
    expect(mocks.clearActiveBoard).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[ActiveBoardSelfHeal] validation failed; will retry');
    warnSpy.mockRestore();
  });

  it('retries on a later mount after a transient failure and then heals', async () => {
    mocks.activeBoard = board('loser-uuid');
    // First attempt fails transiently; a later mount must retry rather than
    // burning the one attempt for the whole session.
    mocks.fetchBoardByUuid.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(board('canonical-uuid'));

    const first = renderHook(() => useActiveBoardSelfHeal());
    await waitFor(() => expect(mocks.fetchBoardByUuid).toHaveBeenCalledTimes(1));
    expect(mocks.setActiveBoard).not.toHaveBeenCalled();
    // Flush the rejected promise's catch/finally so the in-flight guard releases
    // before the next mount.
    await act(async () => {
      await Promise.resolve();
    });
    first.unmount();

    renderHook(() => useActiveBoardSelfHeal());
    await waitFor(() => expect(mocks.setActiveBoard).toHaveBeenCalledTimes(1));
    expect(mocks.setActiveBoard.mock.calls[0][0].uuid).toBe('canonical-uuid');
    expect(mocks.fetchBoardByUuid).toHaveBeenCalledTimes(2);
  });

  it('revalidates on foreground and heals a board merged later in the session', async () => {
    mocks.activeBoard = board('current-uuid');
    mocks.fetchBoardByUuid.mockResolvedValueOnce(board('current-uuid')).mockResolvedValueOnce(board('canonical-uuid'));

    renderHook(() => useActiveBoardSelfHeal());
    await waitFor(() => expect(mocks.fetchBoardByUuid).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      appState.state.listener?.('active');
    });

    await waitFor(() => expect(mocks.setActiveBoard).toHaveBeenCalledTimes(1));
    expect(mocks.fetchBoardByUuid).toHaveBeenCalledTimes(2);
    expect(mocks.setActiveBoard.mock.calls[0][0].uuid).toBe('canonical-uuid');
  });

  it('does not let an in-flight heal overwrite a newer board selection', async () => {
    let resolveOldBoard: ((resolved: UserBoard) => void) | undefined;
    mocks.activeBoard = board('old-uuid');
    mocks.fetchBoardByUuid
      .mockImplementationOnce(
        () =>
          new Promise<UserBoard>((resolve) => {
            resolveOldBoard = resolve;
          }),
      )
      .mockResolvedValueOnce(board('new-uuid'));

    const hook = renderHook(() => useActiveBoardSelfHeal());
    await waitFor(() => expect(mocks.fetchBoardByUuid).toHaveBeenCalledTimes(1));

    mocks.activeBoard = board('new-uuid');
    hook.rerender();
    await act(async () => {
      resolveOldBoard?.(board('old-canonical-uuid'));
      await Promise.resolve();
    });

    await waitFor(() => expect(mocks.fetchBoardByUuid).toHaveBeenCalledTimes(2));
    expect(mocks.fetchBoardByUuid).toHaveBeenLastCalledWith('new-uuid');
    expect(mocks.setActiveBoard).not.toHaveBeenCalled();
    expect(mocks.clearActiveBoard).not.toHaveBeenCalled();
  });

  it('does not heal after a newer selection write starts but before React Query renders it', async () => {
    let resolveOldBoard: ((resolved: UserBoard) => void) | undefined;
    mocks.activeBoard = board('old-uuid');
    mocks.fetchBoardByUuid.mockImplementationOnce(
      () =>
        new Promise<UserBoard>((resolve) => {
          resolveOldBoard = resolve;
        }),
    );

    renderHook(() => useActiveBoardSelfHeal());
    await waitFor(() => expect(mocks.fetchBoardByUuid).toHaveBeenCalledTimes(1));

    // `useSetActiveBoard` advances this synchronously before awaiting storage.
    // Deliberately do not change `activeBoard`: this pins the exact gap between
    // a user's write intent and the React Query render that the old test missed.
    mocks.writeGeneration += 1;
    await act(async () => {
      resolveOldBoard?.(board('old-canonical-uuid'));
      await Promise.resolve();
    });

    expect(mocks.setActiveBoard).not.toHaveBeenCalled();
    expect(mocks.clearActiveBoard).not.toHaveBeenCalled();
  });

  it('does not write a heal after the hook unmounts', async () => {
    let resolveOldBoard: ((resolved: UserBoard) => void) | undefined;
    mocks.activeBoard = board('unmounted-loser-uuid');
    mocks.fetchBoardByUuid.mockImplementationOnce(
      () =>
        new Promise<UserBoard>((resolve) => {
          resolveOldBoard = resolve;
        }),
    );

    const hook = renderHook(() => useActiveBoardSelfHeal());
    await waitFor(() => expect(mocks.fetchBoardByUuid).toHaveBeenCalledTimes(1));
    hook.unmount();

    await act(async () => {
      resolveOldBoard?.(board('unmounted-canonical-uuid'));
      await Promise.resolve();
    });

    expect(mocks.setActiveBoard).not.toHaveBeenCalled();
    expect(mocks.clearActiveBoard).not.toHaveBeenCalled();
  });
});
