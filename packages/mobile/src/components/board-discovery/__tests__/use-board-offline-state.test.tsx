// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';

const settingsCtrl = vi.hoisted(() => ({ enabled: [] as string[] }));
const downloadedCtrl = vi.hoisted(() => ({ keys: undefined as string[] | undefined }));

vi.mock('../../../settings', () => ({
  offlineBoardKeyForBoard: (board: UserBoard) => `${board.boardType}:${board.layoutId}:${board.sizeId}`,
  useSetting: () => [settingsCtrl.enabled],
}));
vi.mock('../../../offline/use-downloaded-scope-keys', () => ({
  useDownloadedScopeKeys: () => ({ data: downloadedCtrl.keys }),
}));

import { useBoardOfflineState } from '../use-board-offline-state';

function board(layoutId: number, sizeId: number): UserBoard {
  return { uuid: `b-${layoutId}-${sizeId}`, boardType: 'kilter', layoutId, sizeId } as unknown as UserBoard;
}

describe('useBoardOfflineState', () => {
  beforeEach(() => {
    settingsCtrl.enabled = [];
    downloadedCtrl.keys = undefined;
  });

  it('reports a board nobody has asked for as off', () => {
    const { result } = renderHook(() => useBoardOfflineState());
    expect(result.current(board(1, 10))).toBe('off');
  });

  it('reports an armed board as pending until its own scope lands', () => {
    settingsCtrl.enabled = ['kilter:1:10'];
    const { result } = renderHook(() => useBoardOfflineState());
    expect(result.current(board(1, 10))).toBe('pending');
  });

  it('reports a board with its own checkpoint as downloaded', () => {
    settingsCtrl.enabled = ['kilter:1:10'];
    downloadedCtrl.keys = ['kilter:1:10'];
    const { result } = renderHook(() => useBoardOfflineState());
    expect(result.current(board(1, 10))).toBe('downloaded');
  });

  // Two sizes of the same layout are separate scopes. A sibling finishing first
  // must not make its neighbour read as downloaded.
  it('keys strictly on the board’s own scope', () => {
    settingsCtrl.enabled = ['kilter:1:10', 'kilter:1:50'];
    downloadedCtrl.keys = ['kilter:1:10'];
    const { result } = renderHook(() => useBoardOfflineState());

    expect(result.current(board(1, 10))).toBe('downloaded');
    expect(result.current(board(1, 50))).toBe('pending');
  });

  it('stays stable across renders so memoised rows hold', () => {
    const { result, rerender } = renderHook(() => useBoardOfflineState());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
