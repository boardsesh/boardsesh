// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePlaylistRenderBoard } from '../use-playlist-render-board';

type ActiveBoard = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
} | null;

type ResolvedBoard = { boardName: string; layoutId: number; sizeId: number; setIds: number[] } | null;

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  activeBoard: { boardName: 'kilter', layoutId: 1, sizeId: 2, setIds: '3', angle: 40 } as ActiveBoard,
  resolved: { boardName: 'tension', layoutId: 9, sizeId: 5, setIds: [1, 2] } as ResolvedBoard,
  getBoardConfigForPlaylist: vi.fn(),
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }));

// t interpolates the board name so banner copy can be asserted to carry it.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && 'board' in opts ? `${key}|${String(opts.board)}` : key,
  }),
}));

vi.mock('@boardsesh/board-config', () => ({
  formatBoardDisplayName: (boardType: string) => boardType.charAt(0).toUpperCase() + boardType.slice(1),
}));

vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ boardConfig: mocks.activeBoard }),
}));

vi.mock('../board-details-for-playlist', () => ({
  getBoardConfigForPlaylist: (boardType: string, layoutId: number | null | undefined) =>
    mocks.getBoardConfigForPlaylist(boardType, layoutId),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeBoard = { boardName: 'kilter', layoutId: 1, sizeId: 2, setIds: '3', angle: 40 };
  mocks.resolved = { boardName: 'tension', layoutId: 9, sizeId: 5, setIds: [1, 2] };
  mocks.getBoardConfigForPlaylist.mockImplementation(() => mocks.resolved);
});

describe('usePlaylistRenderBoard', () => {
  it('renders against the active board with no banner when the boards match', () => {
    const { result } = renderHook(() => usePlaylistRenderBoard({ boardType: 'kilter', layoutId: 1 }));
    expect(result.current.renderBoard).toBe(mocks.activeBoard);
    expect(result.current.banner).toBeNull();
    // No need to resolve the playlist's own board when it matches the active one.
    expect(mocks.getBoardConfigForPlaylist).not.toHaveBeenCalled();
  });

  it('matches on board name when the playlist carries no layout (Aurora circuit)', () => {
    const { result } = renderHook(() => usePlaylistRenderBoard({ boardType: 'kilter', layoutId: null }));
    expect(result.current.renderBoard).toBe(mocks.activeBoard);
    expect(result.current.banner).toBeNull();
  });

  it('keeps the active board and shows a banner on a board-name mismatch', () => {
    const { result } = renderHook(() => usePlaylistRenderBoard({ boardType: 'tension', layoutId: 9 }));
    expect(result.current.renderBoard).toBe(mocks.activeBoard);
    expect(result.current.banner?.title).toContain('Tension');
    expect(result.current.banner?.subtitle).toContain('Tension');
    expect(mocks.getBoardConfigForPlaylist).not.toHaveBeenCalled();
  });

  it('treats a layout mismatch on the same board as a mismatch', () => {
    mocks.resolved = { boardName: 'kilter', layoutId: 8, sizeId: 7, setIds: [3] };
    const { result } = renderHook(() => usePlaylistRenderBoard({ boardType: 'kilter', layoutId: 8 }));
    expect(result.current.banner).not.toBeNull();
    expect(result.current.renderBoard).toBe(mocks.activeBoard);
    expect(mocks.getBoardConfigForPlaylist).not.toHaveBeenCalled();
  });

  it('resolves read-only + banner when there is no active board', () => {
    mocks.activeBoard = null;
    const { result } = renderHook(() => usePlaylistRenderBoard({ boardType: 'tension', layoutId: 9 }));
    expect(result.current.banner).not.toBeNull();
    // No active angle to fall back to → defaults to 0 (per-row angle is used).
    expect(result.current.renderBoard).toMatchObject({ boardName: 'tension', angle: 0 });
  });

  it('keeps the active board when the playlist board cannot be resolved', () => {
    mocks.resolved = null;
    const { result } = renderHook(() => usePlaylistRenderBoard({ boardType: 'moonboard', layoutId: 1 }));
    expect(result.current.renderBoard).toBe(mocks.activeBoard);
    expect(result.current.banner).not.toBeNull();
    expect(mocks.getBoardConfigForPlaylist).not.toHaveBeenCalled();
  });

  it('shows the banner alone when there is no active board and the fallback cannot be resolved', () => {
    mocks.activeBoard = null;
    mocks.resolved = null;
    const { result } = renderHook(() => usePlaylistRenderBoard({ boardType: 'moonboard', layoutId: 1 }));
    expect(result.current.renderBoard).toBeNull();
    expect(result.current.banner).not.toBeNull();
  });

  it('navigates to the board switcher when the banner CTA fires', () => {
    const { result } = renderHook(() => usePlaylistRenderBoard({ boardType: 'tension', layoutId: 9 }));
    result.current.banner?.onPress();
    expect(mocks.push).toHaveBeenCalledWith({ pathname: '/boards', params: { returnTo: '/(tabs)/discover' } });
  });

  it('always renders against the active board with no banner for smart playlists (null input)', () => {
    const { result } = renderHook(() => usePlaylistRenderBoard(null));
    expect(result.current.renderBoard).toBe(mocks.activeBoard);
    expect(result.current.banner).toBeNull();
    expect(mocks.getBoardConfigForPlaylist).not.toHaveBeenCalled();
  });
});
