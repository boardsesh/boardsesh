// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Transition = { data?: { closing?: boolean } };

const platform = vi.hoisted(() => ({ OS: 'ios' }));
const router = vi.hoisted(() => ({ dismiss: vi.fn() }));
const navigation = vi.hoisted(() => ({
  listener: null as ((transition: Transition) => void) | null,
  unsubscribe: vi.fn(),
  addListener: vi.fn((_event: string, listener: (transition: Transition) => void) => {
    navigation.listener = listener;
    return navigation.unsubscribe;
  }),
}));

vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('expo-router', () => ({
  useRouter: () => router,
  useNavigation: () => navigation,
}));

import { usePlayerDismissAndWait } from '../use-player-dismiss-and-wait';

beforeEach(() => {
  platform.OS = 'ios';
  router.dismiss.mockClear();
  navigation.listener = null;
  navigation.unsubscribe.mockClear();
  navigation.addListener.mockClear();
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

  it('cleans up and resolves aborted when the player route unmounts first', async () => {
    const { result, unmount } = renderHook(() => usePlayerDismissAndWait());
    const resultPromise = result.current();

    unmount();

    await expect(resultPromise).resolves.toEqual({ status: 'aborted' });
    expect(navigation.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not wait for a native event on web', async () => {
    platform.OS = 'web';
    const { result } = renderHook(() => usePlayerDismissAndWait());

    await expect(result.current()).resolves.toEqual({ status: 'dismissed' });

    expect(router.dismiss).toHaveBeenCalledTimes(1);
    expect(navigation.addListener).not.toHaveBeenCalled();
  });
});
