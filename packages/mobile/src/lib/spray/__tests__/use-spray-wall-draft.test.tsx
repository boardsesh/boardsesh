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

  it('withdraws local draft state when the account changes', async () => {
    requestMock.mockResolvedValue({ sprayWallRenderData: payload() });
    const { result } = renderHook(() => useSprayWallDraft(LAYOUT_ID, 'wall-1', 3, '30'), { wrapper });
    await waitFor(() => expect(result.current.wall?.versionId).toBe(30));
    act(() => {
      resetSprayWallViewerAccess();
    });
    expect(result.current.wall).toBeNull();
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
      await result.current.mutateAsync({ wallUuid: 'wall-1', versionId: '30' });
    });
    expect(getSprayWall(LAYOUT_ID)).toBeNull();
    expect(client.getQueryData(sprayWallDraftQueryKey('wall-1', 3, '30'))).toBeUndefined();
  });
});
