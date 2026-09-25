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
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const requestMock = vi.hoisted(() => vi.fn());
const registerRenderDataMock = vi.hoisted(() => vi.fn());
const invalidateMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request: requestMock }) }));
vi.mock('../spray-wall-loader', () => ({
  registerRenderData: registerRenderDataMock,
  invalidateSprayWallRenderData: invalidateMock,
}));

import { useSprayWallDraft } from '../use-spray-wall-draft';

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
