// @vitest-environment jsdom
//
// The three states this hook has to tell apart, and the frame between two of
// them.
//
// `registerRenderData` writes to a module-level map, so it cannot run in a
// `useMemo` — which means there is one render where the payload has arrived and
// the registry has not been told yet. Reporting that frame as "unavailable"
// flashes a "this wall has no photo to edit yet" screen before the editor
// appears; reporting a payload that genuinely CANNOT be drawn as "loading" hangs
// a spinner forever. The verdict is therefore keyed on the payload, and this file
// is what stops a future refactor collapsing it back to a boolean.
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';

const requestMock = vi.hoisted(() => vi.fn());
const registerRenderDataMock = vi.hoisted(() => vi.fn());
const invalidateMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const retryConnectivityNowMock = vi.hoisted(() => vi.fn());

vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request: requestMock }) }));
vi.mock('../../connectivity/connectivity-store', () => ({ retryConnectivityNow: retryConnectivityNowMock }));
vi.mock('../spray-wall-loader', () => ({
  registerRenderData: registerRenderDataMock,
  invalidateSprayWallRenderData: invalidateMock,
}));

import {
  prefetchSprayWallDraft,
  sprayWallDraftQueryKey,
  useKeepSprayDraftRegistered,
  useSprayWallDraft,
} from '../use-spray-wall-draft';
import { BackendUnavailableError } from '../../connectivity/backend-unavailable-error';
import { shouldRetryQuery } from '../../graphql/query-retry';
import { clearSprayWallRegistry, getSprayWall, registerSprayWall, unregisterSprayWall } from '../spray-wall-registry';

const RENDER_DATA = {
  versionNumber: 3,
  homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  photo: { url: 'u', thumbUrl: null, width: 900, height: 1200, expiresAt: 'later' },
  holds: [],
  wall: { uuid: 'wall-1' },
};

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  requestMock.mockReset();
  registerRenderDataMock.mockReset();
  invalidateMock.mockClear();
  retryConnectivityNowMock.mockReset();
  retryConnectivityNowMock.mockResolvedValue('reachable');
});

describe('useSprayWallDraft', () => {
  it('never reports the wall unavailable on the frame its payload lands', async () => {
    // The flash. `isUnavailable` must not be true at ANY point on the way from
    // loading to ready, because the screen renders a hard error on it.
    requestMock.mockResolvedValue({ sprayWallRenderData: RENDER_DATA });
    registerRenderDataMock.mockReturnValue(true);

    const seen: { isLoading: boolean; isUnavailable: boolean }[] = [];
    const { result } = renderHook(
      () => {
        const state = useSprayWallDraft(4001, 'wall-1', 3);
        seen.push({ isLoading: state.isLoading, isUnavailable: state.isUnavailable });
        return state;
      },
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isUnavailable).toBe(false);
    expect(result.current.homography).toEqual(RENDER_DATA.homography);
    expect(seen.some((state) => state.isUnavailable)).toBe(false);
  });

  it('reports a payload the registry refuses as unavailable, not as loading forever', async () => {
    // No readable photo size, or a homography with no inverse. A spinner here
    // would never stop.
    requestMock.mockResolvedValue({ sprayWallRenderData: RENDER_DATA });
    registerRenderDataMock.mockReturnValue(false);

    const { result } = renderHook(() => useSprayWallDraft(4001, 'wall-1', 3), { wrapper });

    await waitFor(() => expect(result.current.isUnavailable).toBe(true));
    expect(result.current.isLoading).toBe(false);
  });

  it('reports a version that does not resolve as unavailable', async () => {
    requestMock.mockResolvedValue({ sprayWallRenderData: null });

    const { result } = renderHook(() => useSprayWallDraft(4001, 'wall-1', 3), { wrapper });

    await waitFor(() => expect(result.current.isUnavailable).toBe(true));
    expect(registerRenderDataMock).not.toHaveBeenCalled();
    expect(result.current.homography).toBeNull();
  });

  it('asks for the version by NUMBER — without it the server answers the published one', async () => {
    requestMock.mockResolvedValue({ sprayWallRenderData: RENDER_DATA });
    registerRenderDataMock.mockReturnValue(true);

    const { result } = renderHook(() => useSprayWallDraft(4001, 'wall-1', 3), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(requestMock.mock.calls[0][1]).toEqual({ uuid: 'wall-1', version: 3 });
  });

  it('fetches nothing until it has been told which wall and which version', () => {
    const { result } = renderHook(() => useSprayWallDraft(4001, null, null), { wrapper });
    expect(requestMock).not.toHaveBeenCalled();
    // And says neither loading nor unavailable — it has not been asked anything.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isUnavailable).toBe(false);
  });

  it('puts the published generation back on teardown', async () => {
    requestMock.mockResolvedValue({ sprayWallRenderData: RENDER_DATA });
    registerRenderDataMock.mockReturnValue(true);

    const { result, unmount } = renderHook(() => useSprayWallDraft(4001, 'wall-1', 3), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(invalidateMock).not.toHaveBeenCalled();

    unmount();
    // A surface that outlives the editor must not be left drawing an unpublished
    // photo, nor served a payload cached from before this session's writes.
    expect(invalidateMock).toHaveBeenCalledTimes(1);
    expect(invalidateMock.mock.calls[0].slice(1)).toEqual(['wall-1', 4001]);
  });

  it('does not touch the registry on teardown when it never had a wall', () => {
    const { unmount } = renderHook(() => useSprayWallDraft(4001, null, null), { wrapper });
    unmount();
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});

describe('useSprayWallDraft — a read that is not getting anywhere', () => {
  // The app's own query policy where it matters here: one attempt runs whatever
  // the phone thinks of the network, and a retry waits for it to be online.
  function appLikeWrapper(retry: number | false | typeof shouldRetryQuery, retryDelay = 0) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry, retryDelay, networkMode: 'offlineFirst' } },
    });
    return function AppLikeWrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    };
  }

  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it('is not stalled while the first attempt is in flight, or once the wall has loaded', async () => {
    requestMock.mockResolvedValue({ sprayWallRenderData: RENDER_DATA });
    registerRenderDataMock.mockReturnValue(true);

    const seen: boolean[] = [];
    const { result } = renderHook(
      () => {
        const state = useSprayWallDraft(4001, 'wall-1', 3);
        seen.push(state.isStalled);
        return state;
      },
      { wrapper: appLikeWrapper(2) },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(seen.every((stalled) => !stalled)).toBe(true);
  });

  it('keeps the plain loading state while an automatic retry is in flight', async () => {
    // One dropped request, then a second attempt that is still out. The screen
    // must not flash "couldn't load" ahead of an editor that is about to open.
    let landSecondAttempt: (response: { sprayWallRenderData: typeof RENDER_DATA }) => void = () => {};
    requestMock.mockRejectedValueOnce(new Error('socket hang up'));
    requestMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          landSecondAttempt = resolve;
        }),
    );
    registerRenderDataMock.mockReturnValue(true);

    const seen: boolean[] = [];
    const { result } = renderHook(
      () => {
        const state = useSprayWallDraft(4001, 'wall-1', 3);
        seen.push(state.isStalled);
        return state;
      },
      { wrapper: appLikeWrapper(2, 20) },
    );

    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isStalled).toBe(false);

    await act(async () => landSecondAttempt({ sprayWallRenderData: RENDER_DATA }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // Not through the backoff, not through the second attempt, not at the end.
    expect(seen.some((stalled) => stalled)).toBe(false);
  });

  it('retry re-probes connectivity first, because an offline store refuses every request', async () => {
    // The client's gate, modelled: while the connectivity store reads offline a
    // request is refused before it reaches the network, and only a probe flips
    // the store back. A retry that only refetched would be refused again.
    let storeOffline = true;
    requestMock.mockImplementation(() =>
      storeOffline
        ? Promise.reject(new BackendUnavailableError('backend_unreachable'))
        : Promise.resolve({ sprayWallRenderData: RENDER_DATA }),
    );
    let finishProbe: (backend: string) => void = () => {};
    retryConnectivityNowMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishProbe = (backend) => {
            storeOffline = false;
            resolve(backend);
          };
        }),
    );
    registerRenderDataMock.mockReturnValue(true);

    // The app's real retry policy: a refused request is not retried.
    const { result } = renderHook(() => useSprayWallDraft(4001, 'wall-1', 3), {
      wrapper: appLikeWrapper(shouldRetryQuery),
    });
    await waitFor(() => expect(result.current.isStalled).toBe(true));
    expect(requestMock).toHaveBeenCalledTimes(1);

    act(() => result.current.retry());
    // The tap is answered at once, while the probe is still out.
    expect(result.current.isStalled).toBe(false);
    expect(retryConnectivityNowMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledTimes(1);

    await act(async () => finishProbe('reachable'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isStalled).toBe(false);
    expect(result.current.isUnavailable).toBe(false);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('goes back to stalled when the probe finds the backend still down', async () => {
    requestMock.mockRejectedValue(new BackendUnavailableError('backend_unreachable'));
    retryConnectivityNowMock.mockRejectedValue(new Error('probe failed'));

    const { result } = renderHook(() => useSprayWallDraft(4001, 'wall-1', 3), {
      wrapper: appLikeWrapper(shouldRetryQuery),
    });
    await waitFor(() => expect(result.current.isStalled).toBe(true));

    act(() => result.current.retry());
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.isStalled).toBe(true));
  });

  it('says so when a retry is parked offline, instead of spinning over nothing', async () => {
    // The stall behind #5959's shape: the first attempt fails, the phone reads
    // as offline, and the retry waits. `isPending` stays true the whole time.
    onlineManager.setOnline(false);
    requestMock.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useSprayWallDraft(4001, 'wall-1', 3), { wrapper: appLikeWrapper(2) });

    await waitFor(() => expect(result.current.isStalled).toBe(true));
    expect(result.current.isLoading).toBe(true);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('stays stalled once the read has given up, so the screen offers the retry', async () => {
    requestMock.mockRejectedValue(new Error('timed out'));

    const { result } = renderHook(() => useSprayWallDraft(4001, 'wall-1', 3), { wrapper: appLikeWrapper(false) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isStalled).toBe(true);
  });

  it('retry abandons the parked read and loads the wall from a fresh attempt', async () => {
    onlineManager.setOnline(false);
    requestMock.mockRejectedValueOnce(new Error('network down'));
    requestMock.mockResolvedValue({ sprayWallRenderData: RENDER_DATA });
    registerRenderDataMock.mockReturnValue(true);

    const { result } = renderHook(() => useSprayWallDraft(4001, 'wall-1', 3), { wrapper: appLikeWrapper(2) });
    await waitFor(() => expect(result.current.isStalled).toBe(true));

    // Still offline as far as the phone knows: the retry must not wait for it.
    act(() => result.current.retry());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isStalled).toBe(false);
    expect(result.current.isUnavailable).toBe(false);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('hands back the same result object while nothing about it changes', async () => {
    requestMock.mockResolvedValue({ sprayWallRenderData: RENDER_DATA });
    registerRenderDataMock.mockReturnValue(true);

    const { result, rerender } = renderHook(() => useSprayWallDraft(4001, 'wall-1', 3), {
      wrapper: appLikeWrapper(false),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const settled = result.current;
    rerender();
    expect(result.current).toBe(settled);
  });
});

describe('prefetchSprayWallDraft', () => {
  it('reads the draft once, so the editor that mounts next opens without asking again', async () => {
    requestMock.mockResolvedValue({ sprayWallRenderData: RENDER_DATA });
    registerRenderDataMock.mockReturnValue(true);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await prefetchSprayWallDraft(queryClient, 4001, 'wall-1', 3);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][1]).toEqual({ uuid: 'wall-1', version: 3 });

    const { result } = renderHook(() => useSprayWallDraft(4001, 'wall-1', 3), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(requestMock).toHaveBeenCalledTimes(1);
    // The generation notes travel with a prefetched payload too.
    expect(registerRenderDataMock).toHaveBeenCalledWith(
      4001,
      RENDER_DATA,
      undefined,
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('never rejects: a failed prefetch is simply read again by the editor', async () => {
    requestMock.mockRejectedValue(new Error('network down'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await expect(prefetchSprayWallDraft(queryClient, 4001, 'wall-1', 3)).resolves.toBeUndefined();
  });
});

describe('useKeepSprayDraftRegistered', () => {
  const LAYOUT_ID = 4001;

  function registerDraft(version = 3) {
    registerSprayWall(LAYOUT_ID, {
      wallUuid: 'wall-1',
      angle: 40,
      version,
      photoWidth: 900,
      photoHeight: 1200,
      photoUrl: 'u',
      photoThumbUrl: null,
      photoExpiresAt: 'later',
      holds: [],
    });
    return true;
  }

  function seededWrapper() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(sprayWallDraftQueryKey('wall-1', 3), { sprayWallRenderData: RENDER_DATA });
    return function SeededWrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    };
  }

  beforeEach(() => {
    clearSprayWallRegistry();
  });

  it('puts the draft back when the editor’s teardown reload takes it out', async () => {
    // The race the look step lives with: the editor's teardown forces a reload
    // of the PUBLISHED wall, which a wall being created does not have, and that
    // reload unregisters the wall after the next screen registered the draft.
    registerRenderDataMock.mockImplementation(() => registerDraft());
    registerDraft();
    renderHook(() => useKeepSprayDraftRegistered(LAYOUT_ID, 'wall-1', 3), { wrapper: seededWrapper() });
    expect(registerRenderDataMock).not.toHaveBeenCalled();

    unregisterSprayWall(LAYOUT_ID);

    await waitFor(() => expect(registerRenderDataMock).toHaveBeenCalledTimes(1));
    // With the viewer generation the draft was FETCHED under, so the registry
    // can believe the payload's `viewerCanEdit` for the wall's own owner.
    expect(registerRenderDataMock).toHaveBeenCalledWith(
      LAYOUT_ID,
      RENDER_DATA,
      undefined,
      expect.any(Number),
      expect.any(Number),
    );
    expect(getSprayWall(LAYOUT_ID)?.version).toBe(3);
  });

  it('replaces a different version the registry was handed, and then settles', async () => {
    registerRenderDataMock.mockImplementation(() => registerDraft());
    registerDraft(2);
    renderHook(() => useKeepSprayDraftRegistered(LAYOUT_ID, 'wall-1', 3), { wrapper: seededWrapper() });

    await waitFor(() => expect(getSprayWall(LAYOUT_ID)?.version).toBe(3));
    expect(registerRenderDataMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a cached payload, and does not loop on one the registry refuses', async () => {
    registerRenderDataMock.mockReturnValue(false);
    renderHook(() => useKeepSprayDraftRegistered(LAYOUT_ID, 'wall-1', 3), { wrapper: seededWrapper() });
    await waitFor(() => expect(registerRenderDataMock).toHaveBeenCalledTimes(1));

    registerRenderDataMock.mockClear();
    renderHook(() => useKeepSprayDraftRegistered(LAYOUT_ID, 'wall-1', 9), { wrapper: seededWrapper() });
    expect(registerRenderDataMock).not.toHaveBeenCalled();
  });
});
