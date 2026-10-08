// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { usePullRefresh } from '../use-pull-refresh';

function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('usePullRefresh', () => {
  it('is not refreshing until the user pulls', () => {
    const { result } = renderHook(() => usePullRefresh(vi.fn(), true));
    expect(result.current.refreshing).toBe(false);
  });

  it('spins until the refetch promise settles', async () => {
    const pending = deferred();
    const refresh = vi.fn(() => pending.promise);
    const { result } = renderHook(() => usePullRefresh(refresh));

    act(() => result.current.onRefresh());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.refreshing).toBe(true);

    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(result.current.refreshing).toBe(false);
  });

  it('stops spinning when the refetch fails', async () => {
    const pending = deferred();
    const { result } = renderHook(() => usePullRefresh(() => pending.promise));

    act(() => result.current.onRefresh());
    await act(async () => {
      pending.reject(new Error('offline'));
      await pending.promise.catch(() => undefined);
    });
    expect(result.current.refreshing).toBe(false);
  });

  it('settles after Strict Mode replays mount effects', async () => {
    const pending = deferred();
    const { result } = renderHook(() => usePullRefresh(() => pending.promise), { wrapper: StrictMode });
    act(() => result.current.onRefresh());
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(result.current.refreshing).toBe(false);
  });

  it('ignores repeated pulls until the current refresh settles', async () => {
    const pending = deferred();
    const refresh = vi.fn(() => pending.promise);
    const { result } = renderHook(() => usePullRefresh(refresh));
    act(() => {
      result.current.onRefresh();
      result.current.onRefresh();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    act(() => result.current.onRefresh());
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('waits for a source that reports progress through its loading flag', async () => {
    const { result, rerender } = renderHook(({ busy }) => usePullRefresh(() => undefined, busy), {
      initialProps: { busy: false },
    });

    act(() => result.current.onRefresh());
    rerender({ busy: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.refreshing).toBe(true);

    rerender({ busy: false });
    expect(result.current.refreshing).toBe(false);
  });
});
