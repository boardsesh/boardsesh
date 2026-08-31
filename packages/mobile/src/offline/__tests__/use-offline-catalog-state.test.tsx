// @vitest-environment jsdom
// The catalog states are promises the SCREEN makes, so they have to answer to
// the same engine gate the download offer does — see the hook's own doc.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import type { OfflineBoardLike } from '@boardsesh/offline-sync';

const state = vi.hoisted(() => ({
  enabledScopeKeys: [] as string[],
  downloadedScopeKeys: [] as string[],
  offlineEngineEnabled: true,
}));

vi.mock('@boardsesh/offline-sync', () => ({
  offlineBoardKeyForBoard: (board: OfflineBoardLike) => `${board.boardType}:${board.layoutId}:${board.sizeId}`,
}));
vi.mock('../../providers/feature-flags-provider', () => ({
  useOfflineDownloadsEnabled: () => state.offlineEngineEnabled,
}));
vi.mock('../../settings', () => ({
  useSetting: () => [state.enabledScopeKeys, vi.fn()],
}));
vi.mock('../use-downloaded-scope-keys', () => ({
  useDownloadedScopeKeys: () => ({ data: state.downloadedScopeKeys }),
}));

import { useOfflineCatalogState } from '../use-offline-catalog-state';

const board = { boardType: 'kilter', layoutId: 1, sizeId: 10 } as OfflineBoardLike;

beforeEach(() => {
  state.enabledScopeKeys = [];
  state.downloadedScopeKeys = [];
  state.offlineEngineEnabled = true;
});
afterEach(() => cleanup());

describe('useOfflineCatalogState', () => {
  it('offers the download when nothing is downloaded or asked for', () => {
    const { result } = renderHook(() => useOfflineCatalogState(board));
    expect(result.current).toBe('missing');
  });

  it('reports the wait once the board is armed', () => {
    state.enabledScopeKeys = ['kilter:1:10'];
    const { result } = renderHook(() => useOfflineCatalogState(board));
    expect(result.current).toBe('queued');
  });

  it('says nothing once the catalog is on the device', () => {
    state.enabledScopeKeys = ['kilter:1:10'];
    state.downloadedScopeKeys = ['kilter:1:10'];
    const { result } = renderHook(() => useOfflineCatalogState(board));
    expect(result.current).toBeNull();
  });

  // The kill switch stops the scheduler, the listeners and the pull, so a scope
  // left enabled in settings from before the flip is not "landing on the next
  // reconnect" — nothing is running to land it.
  it.each([
    ['missing', [] as string[]],
    ['queued', ['kilter:1:10']],
  ])('says nothing about a %s catalog when the offline engine is off', (_label, enabled) => {
    state.enabledScopeKeys = enabled;
    state.offlineEngineEnabled = false;
    const { result } = renderHook(() => useOfflineCatalogState(board));
    expect(result.current).toBeNull();
  });
});
