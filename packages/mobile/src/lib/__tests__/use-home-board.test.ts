// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';

vi.mock('../../providers/auth-provider', () => ({ useAuth: vi.fn() }));
vi.mock('../graphql/use-active-board', () => ({ useActiveBoard: vi.fn() }));
vi.mock('../graphql/hooks/index', () => ({ useMyBoards: vi.fn(), useProfile: vi.fn() }));
vi.mock('../graphql/hooks/use-you-data', () => ({ useAllBoardsTicks: vi.fn() }));

import { useAuth } from '../../providers/auth-provider';
import { useActiveBoard } from '../graphql/use-active-board';
import { useMyBoards, useProfile } from '../graphql/hooks/index';
import { useAllBoardsTicks } from '../graphql/hooks/use-you-data';
import { useHomeBoard } from '../graphql/hooks/use-home-board';

function board(overrides: Partial<UserBoard>): UserBoard {
  return { uuid: 'b', boardType: 'kilter', layoutId: 1, uniqueClimbers: 0, totalAscents: 0, ...overrides } as UserBoard;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useAuth).mockReturnValue({ isAuthenticated: true } as never);
  vi.mocked(useProfile).mockReturnValue({ data: { id: 'u1' }, isLoading: false } as never);
  vi.mocked(useActiveBoard).mockReturnValue({ data: null, isLoading: false } as never);
  vi.mocked(useMyBoards).mockReturnValue({ data: undefined, isLoading: false } as never);
  vi.mocked(useAllBoardsTicks).mockReturnValue({ data: undefined, isLoading: false } as never);
});

describe('useHomeBoard', () => {
  it('prefers the explicit active board over everything else', () => {
    const active = board({ uuid: 'active', boardType: 'tension' });
    vi.mocked(useActiveBoard).mockReturnValue({ data: active, isLoading: false } as never);
    vi.mocked(useMyBoards).mockReturnValue({ data: { boards: [board({ uuid: 'other' })] }, isLoading: false } as never);
    const { result } = renderHook(() => useHomeBoard());
    expect(result.current.board?.uuid).toBe('active');
    expect(result.current.isResolving).toBe(false);
  });

  it('falls back to the single owned board', () => {
    vi.mocked(useMyBoards).mockReturnValue({ data: { boards: [board({ uuid: 'solo' })] }, isLoading: false } as never);
    const { result } = renderHook(() => useHomeBoard());
    expect(result.current.board?.uuid).toBe('solo');
    expect(result.current.boards).toHaveLength(1);
  });

  it('picks the most-ticked board type, then the highest-activity board of that type', () => {
    vi.mocked(useMyBoards).mockReturnValue({
      data: {
        boards: [
          board({ uuid: 'k1', boardType: 'kilter', uniqueClimbers: 5 }),
          board({ uuid: 'k2', boardType: 'kilter', uniqueClimbers: 20 }),
          board({ uuid: 't1', boardType: 'tension', uniqueClimbers: 99 }),
        ],
      },
      isLoading: false,
    } as never);
    vi.mocked(useAllBoardsTicks).mockReturnValue({
      data: { kilter: [1, 2, 3], tension: [1] },
      isLoading: false,
    } as never);
    const { result } = renderHook(() => useHomeBoard());
    // kilter is most-ticked (3 > 1); k2 is the highest-activity kilter board.
    expect(result.current.board?.uuid).toBe('k2');
    // Exposes the full owned-boards list, not just the inferred home board.
    expect(result.current.boards).toHaveLength(3);
  });

  it('returns null when no active board, no ticks, and multiple boards', () => {
    vi.mocked(useMyBoards).mockReturnValue({
      data: { boards: [board({ uuid: 'a', boardType: 'kilter' }), board({ uuid: 'b', boardType: 'tension' })] },
      isLoading: false,
    } as never);
    vi.mocked(useAllBoardsTicks).mockReturnValue({ data: {}, isLoading: false } as never);
    const { result } = renderHook(() => useHomeBoard());
    expect(result.current.board).toBeNull();
  });

  it('returns a stable empty boards array while myBoards has no data', () => {
    vi.mocked(useMyBoards).mockReturnValue({ data: undefined, isLoading: false } as never);
    const { result, rerender } = renderHook(() => useHomeBoard());
    expect(result.current.boards).toHaveLength(0);
    const firstBoards = result.current.boards;
    rerender();
    // Same reference across renders so consumers memoising on it don't churn.
    expect(result.current.boards).toBe(firstBoards);
  });

  it('is still resolving while the active-board (AsyncStorage) read is pending', () => {
    vi.mocked(useActiveBoard).mockReturnValue({ data: undefined, isLoading: true } as never);
    const { result } = renderHook(() => useHomeBoard());
    expect(result.current.isResolving).toBe(true);
  });

  it('keeps resolving while the profile loads and ticks are needed (>1 board)', () => {
    // The tick query is gated on `profile?.id`, so it reports `isLoading: false`
    // until the profile lands. `needsTicks` is true here (2 boards, no active
    // board), so `profileLoading` must keep `isResolving` true — otherwise a
    // one-shot caller locks the crew fallback before tick inference can run.
    vi.mocked(useMyBoards).mockReturnValue({
      data: { boards: [board({ uuid: 'k', boardType: 'kilter' }), board({ uuid: 't', boardType: 'tension' })] },
      isLoading: false,
    } as never);
    vi.mocked(useProfile).mockReturnValue({ data: undefined, isLoading: true } as never);
    vi.mocked(useAllBoardsTicks).mockReturnValue({ data: undefined, isLoading: false } as never);
    const { result } = renderHook(() => useHomeBoard());
    expect(result.current.isResolving).toBe(true);
    expect(result.current.board).toBeNull();
  });

  it('does not let a loading profile block when ticks are not needed (single board)', () => {
    // A single owned board needs no tick disambiguation, so `needsTicks` is
    // false and `profileLoading` must not gate `isResolving`.
    vi.mocked(useMyBoards).mockReturnValue({ data: { boards: [board({ uuid: 'solo' })] }, isLoading: false } as never);
    vi.mocked(useProfile).mockReturnValue({ data: undefined, isLoading: true } as never);
    const { result } = renderHook(() => useHomeBoard());
    expect(result.current.isResolving).toBe(false);
    expect(result.current.board?.uuid).toBe('solo');
  });
});
