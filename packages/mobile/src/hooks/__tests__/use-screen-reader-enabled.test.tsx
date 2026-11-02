// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
const signals = vi.hoisted(() => ({
  pending: [] as ((enabled: boolean) => void)[],
  changed: null as null | ((enabled: boolean) => void),
  removed: vi.fn(),
}));
vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isScreenReaderEnabled: () => new Promise<boolean>((resolve) => signals.pending.push(resolve)),
    addEventListener: (_event: string, changed: (enabled: boolean) => void) => {
      signals.changed = changed;
      return { remove: signals.removed };
    },
  },
}));
import { useScreenReaderEnabled } from '../use-screen-reader-enabled';
afterEach(() => {
  cleanup();
  signals.pending = [];
  signals.changed = null;
  signals.removed.mockClear();
});
describe('useScreenReaderEnabled', () => {
  it('starts off, then follows the first read and later changes', async () => {
    const hook = renderHook(useScreenReaderEnabled);
    expect(hook.result.current).toBe(false);
    await act(async () => {
      signals.pending[0](true);
    });
    expect(hook.result.current).toBe(true);
    act(() => signals.changed?.(false));
    expect(hook.result.current).toBe(false);
  });
  it('keeps a change newer than a read still in flight', async () => {
    const hook = renderHook(useScreenReaderEnabled);
    act(() => signals.changed?.(true));
    await act(async () => {
      signals.pending[0](false);
    });
    expect(hook.result.current).toBe(true);
  });
  it('unsubscribes on unmount', () => {
    const hook = renderHook(useScreenReaderEnabled);
    hook.unmount();
    expect(signals.removed).toHaveBeenCalledOnce();
  });
});
