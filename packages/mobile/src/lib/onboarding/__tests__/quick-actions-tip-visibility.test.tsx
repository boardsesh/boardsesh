// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../preferences/secure-store-adapter', () => ({
  secureStorePreferences: { get: vi.fn(), set: vi.fn().mockResolvedValue(undefined), remove: vi.fn() },
}));

let quickActionsTip: typeof import('../quick-actions-tip');
let useQuickActionsTipVisibility: (typeof import('../use-quick-actions-tip-visibility'))['useQuickActionsTipVisibility'];

beforeEach(async () => {
  vi.resetModules();
  quickActionsTip = await import('../quick-actions-tip');
  ({ useQuickActionsTipVisibility } = await import('../use-quick-actions-tip-visibility'));
});
afterEach(cleanup);

describe('quick-actions tip visibility', () => {
  it('stays hidden after menu use while an armed tip waits behind the reveal banner', async () => {
    const { result, rerender } = renderHook(({ revealVisible }) => useQuickActionsTipVisibility(true, revealVisible), {
      initialProps: { revealVisible: true },
    });
    expect(result.current).toBe(false);
    await act(async () => {
      await quickActionsTip.markQuickActionsUsed();
    });
    rerender({ revealVisible: false });
    expect(result.current).toBe(false);
  });

  it('retires an already-visible tip immediately when the menu opens', async () => {
    const { result } = renderHook(() => useQuickActionsTipVisibility(true, false));
    expect(result.current).toBe(true);
    await act(async () => {
      await quickActionsTip.markQuickActionsUsed();
    });
    expect(result.current).toBe(false);
  });

  it('shows after the reveal banner clears when the menu has not been used', () => {
    const { result, rerender } = renderHook(
      ({ armed, revealVisible }) => useQuickActionsTipVisibility(armed, revealVisible),
      { initialProps: { armed: false, revealVisible: false } },
    );
    expect(result.current).toBe(false);
    rerender({ armed: true, revealVisible: true });
    expect(result.current).toBe(false);
    rerender({ armed: true, revealVisible: false });
    expect(result.current).toBe(true);
  });

  it('notifies subscribed screens once and leaves unsubscribed screens alone', async () => {
    const activeScreen = vi.fn();
    const unmountedScreen = vi.fn();
    const unsubscribeActive = quickActionsTip.subscribeToQuickActionsUsed(activeScreen);
    const unsubscribeUnmounted = quickActionsTip.subscribeToQuickActionsUsed(unmountedScreen);
    unsubscribeUnmounted();
    await quickActionsTip.markQuickActionsUsed();
    await quickActionsTip.markQuickActionsUsed();
    expect(activeScreen).toHaveBeenCalledTimes(1);
    expect(unmountedScreen).not.toHaveBeenCalled();
    unsubscribeActive();
  });
});
