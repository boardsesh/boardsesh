// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DismissSurfaceAndWait } from '../../create-climb/use-create-climb-navigation';

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError }));

import { usePushAfterPlayerDismiss } from '../use-push-after-player-dismiss';

type DismissResult = Awaited<ReturnType<DismissSurfaceAndWait>>;

function deferredDismiss() {
  const settle: { resolve: (result: DismissResult) => void; reject: (error: unknown) => void } = {
    resolve: () => {},
    reject: () => {},
  };
  const dismiss = vi.fn<DismissSurfaceAndWait>(
    () =>
      new Promise<DismissResult>((resolve, reject) => {
        settle.resolve = resolve;
        settle.reject = reject;
      }),
  );
  return { dismiss, settle };
}

const DISMISSED = { status: 'dismissed' } as DismissResult;
const ABORTED = { status: 'aborted' } as DismissResult;

beforeEach(() => {
  reportHandledError.mockReset();
});

describe('usePushAfterPlayerDismiss', () => {
  it('pushes straight away on the pane, which has no player route to dismiss', () => {
    const push = vi.fn();
    const { result } = renderHook(() => usePushAfterPlayerDismiss(undefined));

    result.current(push);

    expect(push).toHaveBeenCalledTimes(1);
  });

  it('holds the push until the player has finished closing', async () => {
    const { dismiss, settle } = deferredDismiss();
    const push = vi.fn();
    const { result } = renderHook(() => usePushAfterPlayerDismiss(dismiss));

    result.current(push);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();

    await act(async () => settle.resolve(DISMISSED));
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('does not push when the dismiss was aborted', async () => {
    const { dismiss, settle } = deferredDismiss();
    const push = vi.fn();
    const { result } = renderHook(() => usePushAfterPlayerDismiss(dismiss));

    result.current(push);
    await act(async () => settle.resolve(ABORTED));

    expect(push).not.toHaveBeenCalled();
  });

  it('ignores a second tap while the player is closing, then takes the next one', async () => {
    const { dismiss, settle } = deferredDismiss();
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();
    const { result } = renderHook(() => usePushAfterPlayerDismiss(dismiss));

    result.current(first);
    result.current(second);
    expect(dismiss).toHaveBeenCalledTimes(1);
    await act(async () => settle.resolve(DISMISSED));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    result.current(third);
    await act(async () => settle.resolve(DISMISSED));
    expect(third).toHaveBeenCalledTimes(1);
  });

  it('reports a failed dismiss, pushes nothing, and stays usable', async () => {
    const { dismiss, settle } = deferredDismiss();
    const push = vi.fn();
    const { result } = renderHook(() => usePushAfterPlayerDismiss(dismiss));
    const failure = new Error('transition lost');

    result.current(push);
    await act(async () => settle.reject(failure));
    expect(push).not.toHaveBeenCalled();
    expect(reportHandledError).toHaveBeenCalledWith(failure, { tags: { source: 'play-drawer-route-handoff' } });

    result.current(push);
    await act(async () => settle.resolve(DISMISSED));
    expect(push).toHaveBeenCalledTimes(1);
  });
});
