import React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { CncBoardConfigInput } from '@boardsesh/shared-schema';

const state = vi.hoisted(() => ({ compute: vi.fn() }));
vi.mock('../configurator/cnc-computation-client', () => ({ computeCnc: state.compute }));
import { useCncLayout } from '../configurator/use-cnc-layout';
import { useCncArtworkValidation } from '../configurator/use-cnc-artwork-validation';

const CONFIG: CncBoardConfigInput = {
  boardName: 'kilter',
  layoutId: 8,
  sizeId: 25,
  setIds: '26,27,28,29',
  options: {},
};
const ARTWORK_CONFIG: CncBoardConfigInput = {
  ...CONFIG,
  artwork: [
    {
      text: 'Send',
      font: 'liberation-sans',
      mode: 'engrave',
      placement: { panelIndex: 0, xMm: 100, yMm: 100, widthMm: 100, rotationDeg: 0 },
    },
  ],
};
const LAYOUT = { wall: { width_mm: 2440, height_mm: 3000 }, panels: [{ index: 0 }], holes: [] };
function deferred() {
  let resolve: (result: Record<string, unknown>) => void = () => {
    throw new Error('not initialized');
  };
  const promise = new Promise<Record<string, unknown>>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
function layoutWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, Wrapper };
}
async function tick(milliseconds = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  state.compute.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('CNC layout request and cache ownership', () => {
  it('keeps private layouts separate for each login and shares only hole-free layouts', async () => {
    state.compute.mockResolvedValue(LAYOUT);
    const { client, Wrapper } = layoutWrapper();
    const first = renderHook(
      () => useCncLayout(CONFIG, { includeHoles: true, authToken: 'buyer-a', cacheScope: 'a-session-1' }),
      { wrapper: Wrapper },
    );
    await tick();
    expect(first.result.current.summary?.wallWidthMm).toBe(2440);
    first.unmount();
    renderHook(() => useCncLayout(CONFIG, { includeHoles: true, authToken: 'buyer-b', cacheScope: 'b-session-2' }), {
      wrapper: Wrapper,
    });
    await tick();
    expect(state.compute).toHaveBeenCalledTimes(2);
    expect(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey[3]),
    ).toEqual(['a-session-1', 'b-session-2']);
    const publicLayout = renderHook(() => useCncLayout(CONFIG, { authToken: 'buyer-b', cacheScope: 'b-session-2' }), {
      wrapper: Wrapper,
    });
    await tick();
    expect(state.compute.mock.calls[2][2]).toMatchObject({
      includeHoles: false,
      authToken: undefined,
      isCurrent: undefined,
    });
    expect(publicLayout.result.current.summary?.panelCount).toBe(1);
    expect(client.getQueryCache().getAll().at(-1)?.queryKey[3]).toBe('public');
  });

  it('keeps a private layout that lands after the configurator unmounts out of the cache', async () => {
    const pending = deferred();
    state.compute.mockReturnValue(pending.promise);
    const { client, Wrapper } = layoutWrapper();
    const mounted = renderHook(
      () => useCncLayout(CONFIG, { includeHoles: true, authToken: 'buyer-a', cacheScope: 'a' }),
      { wrapper: Wrapper },
    );
    await tick();
    const [layoutQuery] = client.getQueryCache().getAll();
    // A second subscriber stops react-query cancelling the fetch on unmount,
    // so only the request scope's mount fence can refuse the late layout.
    const stopObserving = new QueryObserver(client, { queryKey: layoutQuery.queryKey, enabled: false }).subscribe(
      () => {},
    );
    const isCurrent = state.compute.mock.calls[0][2].isCurrent as () => boolean;
    expect(isCurrent()).toBe(true);
    mounted.unmount();
    expect(isCurrent()).toBe(false);
    await act(async () => {
      pending.resolve(LAYOUT);
    });
    await tick();
    expect(layoutQuery.state.data).toBeUndefined();
    expect(layoutQuery.state.error?.message).toBe('STALE_CNC_REQUEST');
    stopObserving();
  });

  it('aborts an obsolete configuration when its debounced replacement starts', async () => {
    state.compute.mockImplementation(() => new Promise(() => {}));
    const { Wrapper } = layoutWrapper();
    const mounted = renderHook(({ config }) => useCncLayout(config), {
      wrapper: Wrapper,
      initialProps: { config: CONFIG },
    });
    await tick();
    const originalSignal = state.compute.mock.calls[0][2].signal as AbortSignal;
    mounted.rerender({ config: { ...CONFIG, options: { sheetStock: '3600x1220' } } });
    await tick(399);
    expect(state.compute).toHaveBeenCalledOnce();
    await tick(1);
    expect(originalSignal.aborted).toBe(true);
    expect(state.compute).toHaveBeenCalledTimes(2);
  });
});

describe('CNC artwork validation staleness', () => {
  it('clears a prior pass immediately while the replacement placement is being checked', async () => {
    state.compute.mockResolvedValueOnce({ ok: true, collisions: [] }).mockImplementation(() => new Promise(() => {}));
    const mounted = renderHook(({ config }) => useCncArtworkValidation(config, 'buyer-a'), {
      initialProps: { config: ARTWORK_CONFIG },
    });
    await tick(500);
    expect(mounted.result.current.ok).toBe(true);
    mounted.rerender({ config: { ...ARTWORK_CONFIG, options: { sheetStock: '3600x1220' } } });
    expect(mounted.result.current.ok).toBeNull();
    expect(mounted.result.current.isChecking).toBe(true);
    await tick(500);
    expect(mounted.result.current.ok).toBeNull();
  });

  it('ignores a late answer to an old placement', async () => {
    const oldPlacement = deferred();
    const newPlacement = deferred();
    state.compute.mockReturnValueOnce(oldPlacement.promise).mockReturnValueOnce(newPlacement.promise);
    const mounted = renderHook(({ config }) => useCncArtworkValidation(config, 'buyer-a'), {
      initialProps: { config: ARTWORK_CONFIG },
    });
    await tick(500);
    const oldSignal = state.compute.mock.calls[0][2].signal as AbortSignal;
    mounted.rerender({ config: { ...ARTWORK_CONFIG, options: { sheetStock: '3600x1220' } } });
    expect(mounted.result.current.ok).toBeNull();
    expect(oldSignal.aborted).toBe(true);
    await tick(500);
    await act(async () => {
      newPlacement.resolve({ ok: false, collisions: [{ artwork_index: 0, kind: 'keepout', panel_index: 0 }] });
    });
    expect(mounted.result.current.ok).toBe(false);
    await act(async () => {
      oldPlacement.resolve({ ok: true, collisions: [] });
    });
    expect(mounted.result.current.ok).toBe(false);
    expect(mounted.result.current.collisions[0].kind).toBe('keepout');
  });

  it('aborts polling and resets the verdict on sign out', async () => {
    state.compute.mockImplementation(() => new Promise(() => {}));
    const mounted = renderHook(({ token }) => useCncArtworkValidation(ARTWORK_CONFIG, token), {
      initialProps: { token: 'buyer-a' as string | null },
    });
    await tick(500);
    const signal = state.compute.mock.calls[0][2].signal as AbortSignal;
    mounted.rerender({ token: null });
    expect(signal.aborted).toBe(true);
    expect(mounted.result.current).toEqual({ ok: null, collisions: [], isChecking: false, errorKey: null });
  });
});
