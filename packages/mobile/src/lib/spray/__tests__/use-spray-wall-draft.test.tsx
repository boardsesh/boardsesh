// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useDiscardSprayWallDraft } from '../use-create-spray-wall';
import type { SprayWallRenderData } from '@boardsesh/graphql/generated/graphql';

const requestMock = vi.hoisted(() => vi.fn());
const invalidateMock = vi.hoisted(() => vi.fn(async () => {}));
const retryMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request: requestMock }) }));
vi.mock('../../connectivity/connectivity-store', () => ({ retryConnectivityNow: retryMock }));
// The real cleanup also erases files; here it only has to withdraw the wall.
vi.mock('../spray-privacy-cleanup', async () => {
  const { unregisterSprayWall: withdraw } = await import('../spray-wall-registry');
  return { clearSprayWallPrivateCaches: (layoutId: number) => withdraw(layoutId) };
});
vi.mock('../spray-wall-loader', () => ({
  invalidateSprayWallRenderData: invalidateMock,
  primeSprayWallLook: vi.fn(),
  mapSprayWallRenderData: (layoutId: number, payload: SprayWallRenderData, versionId: number, receivedAtMs: number) => {
    if (!payload.photo.width || !payload.photo.height) return null;
    return {
      layoutId,
      wallUuid: payload.wall.uuid,
      version: payload.versionNumber,
      versionId,
      photoWidth: payload.photo.width,
      photoHeight: payload.photo.height,
      photoUrl: payload.photo.url,
      photoThumbUrl: null,
      photoExpiresAt: payload.photo.expiresAt,
      holds: payload.holds,
      angle: 40,
      renderSettings: null,
      viewerCanEdit: payload.wall.viewerCanEdit === true,
      registeredAtMs: receivedAtMs,
    };
  },
}));
import {
  prefetchSprayWallDraft,
  sprayWallDraftQueryKey,
  useKeepSprayDraftRegistered,
  useSprayWallDraft,
} from '../use-spray-wall-draft';
import {
  clearSprayWallRegistry,
  getSprayWall,
  registerSprayWall,
  resetSprayWallViewerAccess,
  unregisterSprayWall,
  withdrawAllSprayWalls,
} from '../spray-wall-registry';

const LAYOUT_ID = 4001;
function payload(versionId = '30', initial = false) {
  return {
    versionNumber: 3,
    homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    photo: {
      url: `https://private.example/${versionId}.jpg?signature=1`,
      thumbUrl: null,
      width: 900,
      height: 1200,
      expiresAt: 'later',
    },
    holds: [{ id: 7, cx: 1, cy: 2, r: 3 }],
    wall: {
      uuid: 'wall-1',
      viewerCanEdit: true,
      currentVersion: initial ? null : { id: '20', number: 2 },
      versions: [{ id: versionId, number: 3, status: 'DRAFT' }],
    },
  };
}
let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
function registerPublished() {
  registerSprayWall(LAYOUT_ID, {
    wallUuid: 'wall-1',
    version: 2,
    versionId: 20,
    angle: 40,
    photoWidth: 1200,
    photoHeight: 1600,
    photoUrl: 'published-photo',
    photoThumbUrl: null,
    photoExpiresAt: 'later',
    holds: [{ id: 99, cx: 90, cy: 80, r: 7 }],
  });
}
beforeEach(() => {
  clearSprayWallRegistry();
  requestMock.mockReset();
  invalidateMock.mockClear();
  retryMock.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  clearSprayWallRegistry();
});

describe('draft render ownership', () => {
  it('maps a reset locally without replacing published photo or holds', async () => {
    registerPublished();
    const published = getSprayWall(LAYOUT_ID);
    requestMock.mockResolvedValue({ sprayWallRenderData: payload() });
    const { result } = renderHook(() => useSprayWallDraft(LAYOUT_ID, 'wall-1', 3, '30'), { wrapper });
    await waitFor(() => expect(result.current.wall?.versionId).toBe(30));
    expect(result.current.wall?.photoUrl).toContain('/30.jpg');
    expect(getSprayWall(LAYOUT_ID)).toBe(published);
    expect(getSprayWall(LAYOUT_ID)?.holds[0]?.id).toBe(99);
  });

  it('keeps refreshed draft holds local', async () => {
    registerPublished();
    const published = getSprayWall(LAYOUT_ID);
    requestMock.mockResolvedValue({ sprayWallRenderData: payload() });
    const { result } = renderHook(() => useSprayWallDraft(LAYOUT_ID, 'wall-1', 3, '30'), { wrapper });
    await waitFor(() => expect(result.current.wall?.versionId).toBe(30));
    const updated = payload();
    updated.holds[0]!.cx = 500;
    requestMock.mockResolvedValue({ sprayWallRenderData: updated });
    await act(async () => {
      await client.invalidateQueries({ queryKey: sprayWallDraftQueryKey('wall-1', 3) });
    });
    await waitFor(() => expect(result.current.wall?.holds[0]?.cx).toBe(500));
    expect(getSprayWall(LAYOUT_ID)).toBe(published);
  });

  // #5911: the hold editor swaps this in once it zooms past 3x.
  it('hands over the full-resolution photo URL with the wall', async () => {
    requestMock.mockResolvedValue({
      sprayWallRenderData: { ...payload(), photoFullUrl: 'https://private.example/30-full.jpg?signature=1' },
    });
    const { result } = renderHook(() => useSprayWallDraft(LAYOUT_ID, 'wall-1', 3, '30'), { wrapper });
    await waitFor(() => expect(result.current.wall?.versionId).toBe(30));
    expect(result.current.photoFullUrl).toBe('https://private.example/30-full.jpg?signature=1');
  });

  // Walls uploaded before #5911 have no full copy; the editor keeps the base.
  it('answers no full-resolution photo for a wall without one', async () => {
    requestMock.mockResolvedValue({ sprayWallRenderData: { ...payload(), photoFullUrl: null } });
    const { result } = renderHook(() => useSprayWallDraft(LAYOUT_ID, 'wall-1', 3, '30'), { wrapper });
    await waitFor(() => expect(result.current.wall?.versionId).toBe(30));
    expect(result.current.photoFullUrl).toBeNull();
  });

  // The same gates that withhold the wall withhold its sharper photo.
  it('withholds the full-resolution photo of a row it rejects', async () => {
    requestMock.mockResolvedValue({
      sprayWallRenderData: { ...payload('31'), photoFullUrl: 'https://private.example/31-full.jpg?signature=1' },
    });
    const { result } = renderHook(() => useSprayWallDraft(LAYOUT_ID, 'wall-1', 3, '30'), { wrapper });
    await waitFor(() => expect(result.current.isUnavailable).toBe(true));
    expect(result.current.photoFullUrl).toBeNull();
  });

  // A lapsed signature is refreshed in the background, never as a reload.
  it('refreshes the photo URLs without going back to loading', async () => {
    requestMock.mockResolvedValue({
      sprayWallRenderData: { ...payload(), photoFullUrl: 'https://private.example/30-full.jpg?signature=1' },
    });
    const { result } = renderHook(() => useSprayWallDraft(LAYOUT_ID, 'wall-1', 3, '30'), { wrapper });
    await waitFor(() => expect(result.current.wall?.versionId).toBe(30));
    requestMock.mockResolvedValue({
      sprayWallRenderData: { ...payload(), photoFullUrl: 'https://private.example/30-full.jpg?signature=2' },
    });
    const loadingSeen: boolean[] = [];
    act(() => result.current.refreshPhotoUrls());
    loadingSeen.push(result.current.isLoading);
    await waitFor(() => expect(result.current.photoFullUrl).toContain('signature=2'));
    loadingSeen.push(result.current.isLoading);
    expect(loadingSeen).toEqual([false, false]);
    expect(result.current.wall?.versionId).toBe(30);
  });

  it('rejects a refetch that resolves a reused number to a replacement row', async () => {
    registerPublished();
    requestMock.mockResolvedValue({ sprayWallRenderData: payload('31') });
    const { result } = renderHook(() => useSprayWallDraft(LAYOUT_ID, 'wall-1', 3, '30'), { wrapper });
    await waitFor(() => expect(result.current.isUnavailable).toBe(true));
    expect(result.current.wall).toBeNull();
    expect(getSprayWall(LAYOUT_ID)?.versionId).toBe(20);
  });

  it('does not reuse a discarded draft query when its number is reused', async () => {
    requestMock.mockResolvedValue({ sprayWallRenderData: payload('30') });
    await prefetchSprayWallDraft(client, LAYOUT_ID, 'wall-1', 3, '30');
    requestMock.mockResolvedValue({ sprayWallRenderData: payload('31') });
    const { result } = renderHook(() => useSprayWallDraft(LAYOUT_ID, 'wall-1', 3, '31'), { wrapper });
    await waitFor(() => expect(result.current.wall?.versionId).toBe(31));
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('registers an initial unpublished draft for the look carousel', async () => {
    requestMock.mockResolvedValue({ sprayWallRenderData: payload('30', true) });
    const { result } = renderHook(() => useSprayWallDraft(LAYOUT_ID, 'wall-1', 3, '30'), { wrapper });
    await waitFor(() => expect(result.current.wall?.versionId).toBe(30));
    await waitFor(() => expect(getSprayWall(LAYOUT_ID)?.versionId).toBe(30));
  });

  it('never reports unavailable on the frame a valid draft payload lands', async () => {
    requestMock.mockResolvedValue({ sprayWallRenderData: payload() });
    const seen: boolean[] = [];
    const { result } = renderHook(
      () => {
        const draft = useSprayWallDraft(LAYOUT_ID, 'wall-1', 3, '30');
        seen.push(draft.isUnavailable);
        return draft;
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.wall?.versionId).toBe(30));
    expect(result.current.isLoading).toBe(false);
    expect(seen).not.toContain(true);
  });

  it('withdraws local draft state when the account changes', async () => {
    requestMock.mockResolvedValue({ sprayWallRenderData: payload() });
    const { result } = renderHook(() => useSprayWallDraft(LAYOUT_ID, 'wall-1', 3, '30'), { wrapper });
    await waitFor(() => expect(result.current.wall?.versionId).toBe(30));
    act(() => {
      resetSprayWallViewerAccess();
    });
    expect(result.current.wall).toBeNull();
    expect(result.current.isUnavailable).toBe(true);
  });

  it('discards an old draft response that lands after sign-out, without reading again', async () => {
    let completeOld!: (response: unknown) => void;
    requestMock.mockReturnValueOnce(
      new Promise((resolve) => {
        completeOld = resolve;
      }),
    );
    const { result } = renderHook(() => useSprayWallDraft(LAYOUT_ID, 'wall-1', 3, '30'), { wrapper });
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    act(() => withdrawAllSprayWalls());
    await act(async () => {
      completeOld({ sprayWallRenderData: payload('30', true) });
    });
    await waitFor(() => expect(result.current.isUnavailable).toBe(true));
    expect(result.current.wall).toBeNull();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(getSprayWall(LAYOUT_ID)).toBeNull();
  });

  it('does not refresh an old editor’s wall when sign-out and unmount happen together', async () => {
    registerPublished();
    requestMock.mockResolvedValue({ sprayWallRenderData: payload() });
    const { result, unmount } = renderHook(() => useSprayWallDraft(LAYOUT_ID, 'wall-1', 3, '30'), { wrapper });
    await waitFor(() => expect(result.current.wall?.versionId).toBe(30));
    act(() => {
      withdrawAllSprayWalls();
      unmount();
    });
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it('puts the published wall back when a reset editor closes', async () => {
    registerPublished();
    requestMock.mockResolvedValue({ sprayWallRenderData: payload() });
    const { result, unmount } = renderHook(() => useSprayWallDraft(LAYOUT_ID, 'wall-1', 3, '30'), { wrapper });
    await waitFor(() => expect(result.current.wall?.versionId).toBe(30));
    unmount();
    expect(invalidateMock).toHaveBeenCalledWith(client, 'wall-1', LAYOUT_ID);
  });

  it('shows unavailable for an unreadable photo and never fetches without an id', async () => {
    const unreadable = payload();
    unreadable.photo.width = 0;
    requestMock.mockResolvedValue({ sprayWallRenderData: unreadable });
    const { result } = renderHook(() => useSprayWallDraft(LAYOUT_ID, 'wall-1', 3, '30'), { wrapper });
    await waitFor(() => expect(result.current.isUnavailable).toBe(true));
    requestMock.mockClear();
    renderHook(() => useSprayWallDraft(LAYOUT_ID, 'wall-1', 3, null), { wrapper });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('holds only an initial draft in the registry, never a published-wall reset', async () => {
    requestMock.mockResolvedValue({ sprayWallRenderData: payload() });
    await prefetchSprayWallDraft(client, LAYOUT_ID, 'wall-1', 3, '30');
    registerPublished();
    renderHook(() => useKeepSprayDraftRegistered(LAYOUT_ID, 'wall-1', 3, '30'), { wrapper });
    expect(getSprayWall(LAYOUT_ID)?.versionId).toBe(20);
  });

  it('does not reinstate an initial draft after wall removal', async () => {
    requestMock.mockResolvedValue({ sprayWallRenderData: payload('30', true) });
    await prefetchSprayWallDraft(client, LAYOUT_ID, 'wall-1', 3, '30');
    renderHook(() => useKeepSprayDraftRegistered(LAYOUT_ID, 'wall-1', 3, '30'), { wrapper });
    expect(getSprayWall(LAYOUT_ID)?.versionId).toBe(30);
    act(() => unregisterSprayWall(LAYOUT_ID));
    expect(getSprayWall(LAYOUT_ID)).toBeNull();
  });
});

describe('draft read recovery', () => {
  it('shows a stalled read and retries after checking connectivity', async () => {
    requestMock.mockRejectedValueOnce(new Error('network unavailable'));
    const { result } = renderHook(() => useSprayWallDraft(LAYOUT_ID, 'wall-1', 3, '30'), { wrapper });
    await waitFor(() => expect(result.current.isStalled).toBe(true));
    requestMock.mockResolvedValue({ sprayWallRenderData: payload() });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.wall?.versionId).toBe(30));
    expect(retryMock).toHaveBeenCalledTimes(1);
    expect(result.current.isStalled).toBe(false);
  });

  it('releases a failed prefetch so the mounted editor can read again', async () => {
    requestMock.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(prefetchSprayWallDraft(client, LAYOUT_ID, 'wall-1', 3, '30')).resolves.toBeUndefined();
    requestMock.mockResolvedValue({ sprayWallRenderData: payload() });
    const { result } = renderHook(() => useSprayWallDraft(LAYOUT_ID, 'wall-1', 3, '30'), { wrapper });
    await waitFor(() => expect(result.current.wall?.versionId).toBe(30));
  });
});

describe('initial wall discard', () => {
  it('withdraws initial geometry and draft queries after Start over succeeds', async () => {
    registerPublished();
    client.setQueryData(sprayWallDraftQueryKey('wall-1', 3, '30'), { sprayWallRenderData: payload('30', true) });
    requestMock.mockResolvedValue({});
    const { result } = renderHook(() => useDiscardSprayWallDraft(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ wallUuid: 'wall-1', versionId: '30', layoutId: LAYOUT_ID });
    });
    expect(getSprayWall(LAYOUT_ID)).toBeNull();
    expect(client.getQueryData(sprayWallDraftQueryKey('wall-1', 3, '30'))).toBeUndefined();
  });
});
