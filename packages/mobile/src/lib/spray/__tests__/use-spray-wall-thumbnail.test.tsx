// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GET_SPRAY_WALL_THUMBNAIL,
  type GetSprayWallThumbnailQueryResponse,
} from '@boardsesh/graphql/operations/spray-walls';

const controls = vi.hoisted(() => ({
  request: vi.fn(),
  ensure: vi.fn(),
  cached: vi.fn(),
  offline: false,
}));
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request: controls.request }) }));
vi.mock('../../../hooks/use-is-offline', () => ({ useIsOffline: () => controls.offline }));
vi.mock('../spray-photo-cache', () => ({
  ensureSprayPhotoCached: controls.ensure,
  tryGetSprayPhotoPathSync: controls.cached,
}));

import { useSprayWallThumbnail } from '../use-spray-wall-thumbnail';
import {
  clearSprayWallRegistry,
  getSprayWall,
  registerSprayWall,
  resetSprayWallViewerAccess,
  setSprayWallLoader,
  unregisterSprayWall,
} from '../spray-wall-registry';

const IDENTITY = { wallUuid: 'wall-uuid', layoutId: 4200 };
const PHOTO = {
  url: 'https://private.example/photo?sig=1',
  width: 1200,
  height: 1600,
  expiresAt: '2099-01-01T00:00:00Z',
};

function response(): GetSprayWallThumbnailQueryResponse {
  return {
    sprayWall: { uuid: IDENTITY.wallUuid, layoutId: IDENTITY.layoutId, currentVersion: { id: '7', photo: PHOTO } },
  };
}

let queryClient: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}
function deferredResponse() {
  let resolve!: (payload: GetSprayWallThumbnailQueryResponse) => void;
  const promise = new Promise<GetSprayWallThumbnailQueryResponse>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => {
  clearSprayWallRegistry();
  controls.offline = false;
  controls.request.mockReset().mockResolvedValue(response());
  controls.ensure.mockReset().mockResolvedValue('/cache/spray-walls/4200-v7.jpg');
  controls.cached.mockReset().mockReturnValue(null);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  clearSprayWallRegistry();
});

describe('useSprayWallThumbnail', () => {
  it('reads a published photo directly by known UUID without registering geometry', async () => {
    const { result } = renderHook(() => useSprayWallThumbnail(IDENTITY), { wrapper });
    await waitFor(() =>
      expect(result.current).toEqual({ uri: 'file:///cache/spray-walls/4200-v7.jpg', aspectRatio: 0.75 }),
    );
    expect(controls.request).toHaveBeenCalledExactlyOnceWith(GET_SPRAY_WALL_THUMBNAIL, {
      uuid: IDENTITY.wallUuid,
      includeDrafts: false,
    });
    expect(controls.ensure).toHaveBeenCalledExactlyOnceWith(
      { layoutId: IDENTITY.layoutId, versionId: 7 },
      { url: PHOTO.url, expiresAt: PHOTO.expiresAt },
    );
    expect(getSprayWall(IDENTITY.layoutId)).toBeNull();
  });

  it('selects the exact unfinished draft instead of requiring a published wall', async () => {
    controls.request.mockResolvedValue({
      sprayWall: {
        ...response().sprayWall,
        currentVersion: null,
        versions: [
          { id: '8', photo: PHOTO },
          { id: '9', photo: { ...PHOTO, url: 'https://private.example/draft' } },
        ],
      },
    });
    const { result } = renderHook(() => useSprayWallThumbnail({ ...IDENTITY, draftVersionId: '9' }), { wrapper });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(controls.request).toHaveBeenCalledWith(GET_SPRAY_WALL_THUMBNAIL, {
      uuid: IDENTITY.wallUuid,
      includeDrafts: true,
    });
    expect(controls.ensure).toHaveBeenCalledWith(
      { layoutId: IDENTITY.layoutId, versionId: 9 },
      { url: 'https://private.example/draft', expiresAt: PHOTO.expiresAt },
    );
    expect(getSprayWall(IDENTITY.layoutId)).toBeNull();
  });

  it.each(['missing draft', 'wrong layout', 'unreadable wall'])('keeps the placeholder for %s', async (reason) => {
    const payload = response();
    if (reason === 'wrong layout') payload.sprayWall!.layoutId += 1;
    if (reason === 'unreadable wall') payload.sprayWall = null;
    controls.request.mockResolvedValue(payload);
    const { result } = renderHook(
      () => useSprayWallThumbnail({ ...IDENTITY, draftVersionId: reason === 'missing draft' ? '99' : null }),
      { wrapper },
    );
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(result.current).toBeNull();
    expect(controls.ensure).not.toHaveBeenCalled();
  });

  it.each(['withdrawal', 'account change'])('discards a late private response after %s', async (change) => {
    const pending = deferredResponse();
    controls.request.mockReturnValueOnce(pending.promise).mockResolvedValue({ sprayWall: null });
    const { result } = renderHook(() => useSprayWallThumbnail(IDENTITY), { wrapper });
    await waitFor(() => expect(controls.request).toHaveBeenCalledOnce());
    act(() => {
      if (change === 'withdrawal') unregisterSprayWall(IDENTITY.layoutId);
      else resetSprayWallViewerAccess();
    });
    await act(async () => pending.resolve(response()));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(result.current).toBeNull();
    expect(controls.ensure).not.toHaveBeenCalled();
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .every((query) => {
          const payload = query.state.data as GetSprayWallThumbnailQueryResponse | undefined;
          return payload?.sprayWall == null;
        }),
    ).toBe(true);
  });

  it('discards a cached photo resolving after withdrawal', async () => {
    let resolvePhoto!: (path: string) => void;
    controls.ensure.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolvePhoto = resolve;
      }),
    );
    const { result } = renderHook(() => useSprayWallThumbnail(IDENTITY), { wrapper });
    await waitFor(() => expect(controls.ensure).toHaveBeenCalledOnce());
    controls.request.mockResolvedValue({ sprayWall: null });
    act(() => unregisterSprayWall(IDENTITY.layoutId));
    await act(async () => resolvePhoto('/cache/withdrawn.jpg'));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(result.current).toBeNull();
  });

  it('retries a failed download with a renewed signature for the same version', async () => {
    controls.ensure.mockResolvedValueOnce(null).mockResolvedValue('/cache/renewed.jpg');
    const { result } = renderHook(() => useSprayWallThumbnail(IDENTITY), { wrapper });
    await waitFor(() => expect(controls.ensure).toHaveBeenCalledOnce());
    expect(result.current).toBeNull();
    const payload = response();
    payload.sprayWall!.currentVersion!.photo = { ...PHOTO, url: 'https://private.example/photo?sig=2' };
    controls.request.mockResolvedValue(payload);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['sprayWallThumbnail'] });
    });
    await waitFor(() => expect(result.current?.uri).toBe('file:///cache/renewed.jpg'));
    expect(controls.ensure).toHaveBeenCalledTimes(2);
  });

  it('keeps an authorized registered photo visible offline without a network read', () => {
    controls.offline = true;
    registerSprayWall(IDENTITY.layoutId, {
      wallUuid: IDENTITY.wallUuid,
      angle: 40,
      version: 1,
      versionId: 7,
      photoWidth: PHOTO.width,
      photoHeight: PHOTO.height,
      photoUrl: PHOTO.url,
      photoThumbUrl: null,
      photoExpiresAt: PHOTO.expiresAt,
      holds: [],
    });
    controls.cached.mockReturnValue('/cache/offline.jpg');
    const { result } = renderHook(() => useSprayWallThumbnail(IDENTITY), { wrapper });
    expect(result.current).toEqual({ uri: 'file:///cache/offline.jpg', aspectRatio: 0.75 });
    expect(controls.request).not.toHaveBeenCalled();
  });

  it('hydrates a cold downloaded wall through the offline loader', async () => {
    controls.offline = true;
    controls.cached.mockReturnValue('/cache/offline.jpg');
    const loader = vi.fn(async (layoutId: number) => {
      registerSprayWall(layoutId, {
        wallUuid: IDENTITY.wallUuid,
        angle: 40,
        version: 1,
        versionId: 7,
        photoWidth: PHOTO.width,
        photoHeight: PHOTO.height,
        photoUrl: PHOTO.url,
        photoThumbUrl: null,
        photoExpiresAt: PHOTO.expiresAt,
        holds: [],
      });
    });
    setSprayWallLoader(loader);
    const { result } = renderHook(() => useSprayWallThumbnail(IDENTITY), { wrapper });
    await waitFor(() => expect(result.current?.uri).toBe('file:///cache/offline.jpg'));
    expect(loader).toHaveBeenCalledExactlyOnceWith(IDENTITY.layoutId);
    expect(controls.request).not.toHaveBeenCalled();
  });

  it('never asks the published loader to hydrate an unfinished wall offline', () => {
    controls.offline = true;
    const loader = vi.fn(async () => {});
    setSprayWallLoader(loader);
    const { result } = renderHook(() => useSprayWallThumbnail({ ...IDENTITY, draftVersionId: '9' }), { wrapper });
    expect(result.current).toBeNull();
    expect(loader).not.toHaveBeenCalled();
    expect(controls.request).not.toHaveBeenCalled();
  });
});
