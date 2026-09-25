// @vitest-environment jsdom
// Which source an expensive catalogue read uses: the downloaded board first,
// the network only for admins, a download offer for everyone else.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';

const state = vi.hoisted(() => ({
  enabledScopeKeys: [] as string[],
  downloadedScopeKeys: undefined as string[] | undefined,
  downloadedLoading: false,
  isAdmin: false,
  adminLoading: false,
  adminEnabled: [] as Array<boolean | undefined>,
}));

vi.mock('@boardsesh/offline-sync', () => ({
  offlineBoardKey: (scope: { boardType: string; layoutId: number; sizeId: number }) =>
    `${scope.boardType}:${scope.layoutId}:${scope.sizeId}`,
}));
vi.mock('../../../settings', () => ({
  useSetting: () => [state.enabledScopeKeys, vi.fn()],
}));
vi.mock('../../../offline/use-downloaded-scope-keys', () => ({
  useDownloadedScopeKeys: () => ({ data: state.downloadedScopeKeys, isLoading: state.downloadedLoading }),
}));
vi.mock('../../graphql/hooks', () => ({
  useIsAdmin: (options?: { enabled?: boolean }) => {
    state.adminEnabled.push(options?.enabled);
    return { isAdmin: state.isAdmin, isLoading: state.adminLoading };
  },
}));

import { useCatalogQuerySource, useCatalogQuerySourceState } from '../use-catalog-query-source';

const scope = { boardName: 'kilter', layoutId: 1, sizeId: 10 };

beforeEach(() => {
  state.enabledScopeKeys = [];
  state.downloadedScopeKeys = [];
  state.downloadedLoading = false;
  state.isAdmin = false;
  state.adminLoading = false;
  state.adminEnabled = [];
});
afterEach(() => cleanup());

describe('useCatalogQuerySource', () => {
  it('reads local when the exact scope is enabled and downloaded', () => {
    state.enabledScopeKeys = ['kilter:1:10'];
    state.downloadedScopeKeys = ['kilter:1:10'];
    const { result } = renderHook(() => useCatalogQuerySource(scope));
    expect(result.current).toBe('local');
  });

  it('prefers local over the network for an admin, and skips the admin query', () => {
    state.enabledScopeKeys = ['kilter:1:10'];
    state.downloadedScopeKeys = ['kilter:1:10'];
    state.isAdmin = true;
    const { result } = renderHook(() => useCatalogQuerySource(scope));
    expect(result.current).toBe('local');
    expect(state.adminEnabled.every((enabled) => enabled === false)).toBe(true);
  });

  it('does not treat another size of the same layout as local', () => {
    state.enabledScopeKeys = ['kilter:1:11'];
    state.downloadedScopeKeys = ['kilter:1:11'];
    const { result } = renderHook(() => useCatalogQuerySource(scope));
    expect(result.current).toBe('download');
  });

  it('does not treat a completed download the user turned off as local', () => {
    state.downloadedScopeKeys = ['kilter:1:10'];
    const { result } = renderHook(() => useCatalogQuerySource(scope));
    expect(result.current).toBe('download');
  });

  it('goes to the network for an admin whose board is not downloaded', () => {
    state.isAdmin = true;
    const { result } = renderHook(() => useCatalogQuerySource(scope));
    expect(result.current).toBe('network');
    expect(state.adminEnabled.at(-1)).toBe(true);
  });

  it('offers the download to everyone else', () => {
    const { result } = renderHook(() => useCatalogQuerySourceState(scope));
    expect(result.current).toEqual({ source: 'download', isResolving: false });
  });

  it('reports resolving while the downloaded scopes or the admin flag are loading', () => {
    state.downloadedScopeKeys = undefined;
    state.downloadedLoading = true;
    const downloaded = renderHook(() => useCatalogQuerySourceState(scope));
    expect(downloaded.result.current).toEqual({ source: 'download', isResolving: true });

    state.downloadedScopeKeys = [];
    state.downloadedLoading = false;
    state.adminLoading = true;
    const admin = renderHook(() => useCatalogQuerySourceState(scope));
    expect(admin.result.current).toEqual({ source: 'download', isResolving: true });
  });

  it('with no scope, offers nothing and asks nothing', () => {
    const { result } = renderHook(() => useCatalogQuerySourceState(null));
    expect(result.current).toEqual({ source: 'download', isResolving: false });
    expect(state.adminEnabled.at(-1)).toBe(false);
  });
});
