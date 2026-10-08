// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
const signals = vi.hoisted(() => ({
  pending: [] as ((enabled: boolean) => void)[],
  changed: null as null | ((enabled: boolean) => void),
  foreground: null as null | ((state: string) => void),
  removed: vi.fn(),
}));
vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => new Promise<boolean>((resolve) => signals.pending.push(resolve)),
    addEventListener: (_event: string, changed: (enabled: boolean) => void) => {
      signals.changed = changed;
      return { remove: signals.removed };
    },
  },
  AppState: {
    addEventListener: (_event: string, changed: (state: string) => void) => {
      signals.foreground = changed;
      return { remove: signals.removed };
    },
  },
}));
import { useReduceMotion } from '../use-reduce-motion';
afterEach(() => {
  cleanup();
  signals.pending = [];
  signals.removed.mockClear();
});
describe('shared Reduce Motion signal', () => {
  it('shares one native read and subscription across text consumers', async () => {
    const first = renderHook(useReduceMotion);
    const second = renderHook(useReduceMotion);
    expect(signals.pending).toHaveLength(1);
    await act(async () => {
      signals.pending[0](true);
    });
    expect(first.result.current).toBe(true);
    expect(second.result.current).toBe(true);
    first.unmount();
    expect(signals.removed).not.toHaveBeenCalled();
    second.unmount();
    expect(signals.removed).toHaveBeenCalledTimes(2);
  });
  it('keeps a live notification newer than an outstanding read', async () => {
    const hook = renderHook(useReduceMotion);
    act(() => signals.changed?.(true));
    await act(async () => {
      signals.pending[0](false);
    });
    expect(hook.result.current).toBe(true);
  });
  it('rereads on foreground and rejects older foreground results', async () => {
    const hook = renderHook(useReduceMotion);
    act(() => signals.foreground?.('active'));
    await act(async () => {
      signals.pending[1](false);
    });
    await act(async () => {
      signals.pending[0](true);
    });
    expect(hook.result.current).toBe(false);
  });
});
