// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useCallback, useEffect, useState } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import type { BoardConfig } from '../../../providers/drawer-host-provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCreateClimbNavigation, type DismissSurfaceAndWait } from '../use-create-climb-navigation';

type Transition = { data?: { closing?: boolean } };

const platform = vi.hoisted(() => ({ OS: 'ios' }));
const router = vi.hoisted(() => ({ dismiss: vi.fn(), push: vi.fn() }));
const navigation = vi.hoisted(() => ({
  listener: null as ((transition: Transition) => void) | null,
  unsubscribe: vi.fn(),
  addListener: vi.fn((_event: string, listener: (transition: Transition) => void) => {
    navigation.listener = listener;
    return navigation.unsubscribe;
  }),
}));
const navigationSource = vi.hoisted(() => ({
  current: null as null | {
    addListener: (event: string, listener: (transition: Transition) => void) => () => void;
  },
}));

vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('expo-router', () => ({
  useRouter: () => router,
  useNavigation: () => navigationSource.current ?? navigation,
}));
vi.mock('../../../lib/sentry', () => ({ captureToSentry: vi.fn() }));

import { usePlayerDismissAndWait } from '../use-player-dismiss-and-wait';

beforeEach(() => {
  platform.OS = 'ios';
  router.dismiss.mockReset();
  router.push.mockReset();
  navigation.listener = null;
  navigation.unsubscribe.mockClear();
  navigation.addListener.mockClear();
  navigationSource.current = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('usePlayerDismissAndWait', () => {
  it('subscribes before dismiss and resolves only the closing transitionEnd', async () => {
    const { result } = renderHook(() => usePlayerDismissAndWait());
    const settled = vi.fn();

    const resultPromise = result.current();
    void resultPromise.then(settled);

    expect(navigation.addListener).toHaveBeenCalledWith('transitionEnd', expect.any(Function));
    expect(navigation.addListener.mock.invocationCallOrder[0]).toBeLessThan(router.dismiss.mock.invocationCallOrder[0]);

    act(() => navigation.listener?.({ data: { closing: false } }));
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(navigation.unsubscribe).not.toHaveBeenCalled();

    act(() => navigation.listener?.({ data: { closing: true } }));
    await expect(resultPromise).resolves.toEqual({ status: 'dismissed' });
    expect(navigation.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('returns aborted from a stale player callback without dismissing the route underneath', async () => {
    const { result, unmount } = renderHook(() => usePlayerDismissAndWait());
    const dismissStalePlayer = result.current;

    unmount();

    await expect(dismissStalePlayer()).resolves.toEqual({ status: 'aborted' });
    expect(router.dismiss).not.toHaveBeenCalled();
    expect(navigation.addListener).not.toHaveBeenCalled();
  });

  it('waits through synchronous player unmount after its own dismiss request', async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => usePlayerDismissAndWait());
    router.dismiss.mockImplementationOnce(unmount);

    const resultPromise = result.current();
    const settled = vi.fn();
    void resultPromise.then(settled);

    await act(async () => vi.advanceTimersByTimeAsync(549));
    expect(settled).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(1));
    await expect(resultPromise).resolves.toEqual({ status: 'dismissed' });
    expect(navigation.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('settles through a bounded ceiling when transitionEnd never arrives', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => usePlayerDismissAndWait());
    const resultPromise = result.current();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    await expect(resultPromise).resolves.toEqual({ status: 'dismissed' });
    expect(navigation.unsubscribe).toHaveBeenCalledTimes(1);

    act(() => navigation.listener?.({ data: { closing: true } }));
    expect(navigation.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not wait for a native event on web', async () => {
    platform.OS = 'web';
    const { result } = renderHook(() => usePlayerDismissAndWait());

    await expect(result.current()).resolves.toEqual({ status: 'dismissed' });

    expect(router.dismiss).toHaveBeenCalledTimes(1);
    expect(navigation.addListener).not.toHaveBeenCalled();
  });

  it('keeps the callback stable while subscribing through the latest route navigation object', async () => {
    let replacementListener: ((transition: Transition) => void) | null = null;
    const replacementUnsubscribe = vi.fn();
    const replacementNavigation = {
      addListener: vi.fn((_event: string, listener: (transition: Transition) => void) => {
        replacementListener = listener;
        return replacementUnsubscribe;
      }),
    };
    const { result, rerender } = renderHook(() => usePlayerDismissAndWait());
    const initialCallback = result.current;

    navigationSource.current = replacementNavigation;
    rerender();

    expect(result.current).toBe(initialCallback);
    const resultPromise = result.current();
    expect(replacementNavigation.addListener).toHaveBeenCalledWith('transitionEnd', expect.any(Function));

    act(() => replacementListener?.({ data: { closing: true } }));
    await expect(resultPromise).resolves.toEqual({ status: 'dismissed' });
    expect(replacementUnsubscribe).toHaveBeenCalledTimes(1);
  });
});

const handoffClimb = {
  uuid: 'climb-1',
  name: 'Sloper Traverse',
  frames: 'p1129r15p1130r12',
  description: 'Start matched on the jug',
} as unknown as Climb;
const handoffBoard = {
  boardName: 'kilter',
  layoutId: 8,
  sizeId: 17,
  setIds: '26,27',
  angle: 40,
} as unknown as BoardConfig;

function PlayerDismissBridge({ onReady }: { onReady: (waiter: DismissSurfaceAndWait) => void }) {
  const dismissPlayerAndWait = usePlayerDismissAndWait();
  useEffect(() => onReady(dismissPlayerAndWait), [dismissPlayerAndWait, onReady]);
  return null;
}

function PlayerCreateHandoffHarness({ onPlayerUnmountReady }: { onPlayerUnmountReady: (unmount: () => void) => void }) {
  const [isPlayerMounted, setIsPlayerMounted] = useState(true);
  const [dismissPlayerAndWait, setDismissPlayerAndWait] = useState<DismissSurfaceAndWait>();
  const { openRemix } = useCreateClimbNavigation({ dismissPlayerAndWait });
  const acceptPlayerWaiter = useCallback((waiter: DismissSurfaceAndWait) => {
    setDismissPlayerAndWait(() => waiter);
  }, []);
  const dismissPlayerRoute = useCallback(() => {
    setIsPlayerMounted(false);
  }, []);

  useEffect(() => onPlayerUnmountReady(dismissPlayerRoute), [dismissPlayerRoute, onPlayerUnmountReady]);

  return (
    <>
      <button type="button" onClick={() => openRemix(handoffClimb, handoffBoard)}>
        Open create
      </button>
      {isPlayerMounted ? <PlayerDismissBridge onReady={acceptPlayerWaiter} /> : null}
    </>
  );
}

describe('player-to-create handoff', () => {
  it('pushes create after the player unmounts before its native transition event', async () => {
    vi.useFakeTimers();
    let unmountPlayerRoute = () => {};
    render(<PlayerCreateHandoffHarness onPlayerUnmountReady={(unmount) => (unmountPlayerRoute = unmount)} />);
    router.dismiss.mockImplementationOnce(unmountPlayerRoute);

    fireEvent.click(screen.getByRole('button', { name: 'Open create' }));

    await act(async () => vi.advanceTimersByTimeAsync(550));

    expect(router.dismiss).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/create',
      params: {
        forkFrames: 'p1129r15p1130r12',
        forkName: 'Sloper Traverse',
        forkDescription: 'Start matched on the jug',
        boardName: 'kilter',
        layoutId: '8',
        sizeId: '17',
        setIds: '26,27',
        angle: '40',
      },
    });
  });
});
