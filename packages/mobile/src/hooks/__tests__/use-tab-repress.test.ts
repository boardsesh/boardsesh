// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

type TabPressListener = (event: { data?: { isPrevented?: boolean } }) => void;

const cfg = vi.hoisted(() => {
  const state = {
    isFocused: true,
    tabPressListeners: [] as Array<(event: { data?: { isPrevented?: boolean } }) => void>,
    unsubscribe: vi.fn(),
    parent: undefined as { addListener: (type: string, listener: TabPressListener) => () => void } | undefined,
  };
  // One object for every render, like the real navigation prop.
  const navigation = {
    isFocused: () => state.isFocused,
    getParent: () => state.parent,
  };
  return Object.assign(state, { navigation });
});

vi.mock('expo-router', () => ({
  useNavigation: () => cfg.navigation,
}));

import { useTabRepress } from '../use-tab-repress';

function pressTab(data?: { isPrevented?: boolean }) {
  for (const listener of cfg.tabPressListeners) listener({ data });
}

describe('useTabRepress', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    cfg.isFocused = true;
    cfg.tabPressListeners = [];
    cfg.unsubscribe.mockReset();
    cfg.parent = {
      addListener: (type, listener) => {
        if (type === 'tabPress') cfg.tabPressListeners.push(listener);
        return cfg.unsubscribe;
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls back on the next frame when the tab is pressed while this screen is showing', () => {
    const onRepress = vi.fn();
    renderHook(() => useTabRepress(onRepress));

    pressTab({ isPrevented: false });
    expect(onRepress).not.toHaveBeenCalled();
    vi.runAllTimers();

    expect(onRepress).toHaveBeenCalledOnce();
  });

  it('ignores the press that opens the tab from elsewhere', () => {
    // The navigator emits tabPress before switching, so a first tap from another
    // tab (or from a route pushed on top) finds this screen unfocused.
    cfg.isFocused = false;
    const onRepress = vi.fn();
    renderHook(() => useTabRepress(onRepress));

    pressTab({ isPrevented: false });
    vi.runAllTimers();

    expect(onRepress).not.toHaveBeenCalled();
  });

  it('ignores a press the native bar refused', () => {
    const onRepress = vi.fn();
    renderHook(() => useTabRepress(onRepress));

    pressTab({ isPrevented: true });
    vi.runAllTimers();

    expect(onRepress).not.toHaveBeenCalled();
  });

  it('accepts the JS tab bar press, which carries no data', () => {
    const onRepress = vi.fn();
    renderHook(() => useTabRepress(onRepress));

    pressTab(undefined);
    vi.runAllTimers();

    expect(onRepress).toHaveBeenCalledOnce();
  });

  it('collapses presses inside one frame into one call', () => {
    const onRepress = vi.fn();
    renderHook(() => useTabRepress(onRepress));

    pressTab({ isPrevented: false });
    pressTab({ isPrevented: false });
    vi.runAllTimers();

    expect(onRepress).toHaveBeenCalledOnce();
  });

  it('unsubscribes and drops a pending frame on unmount', () => {
    const onRepress = vi.fn();
    const { unmount } = renderHook(() => useTabRepress(onRepress));

    pressTab({ isPrevented: false });
    unmount();
    vi.runAllTimers();

    expect(cfg.unsubscribe).toHaveBeenCalledOnce();
    expect(onRepress).not.toHaveBeenCalled();
  });

  it('does nothing without a parent navigator', () => {
    cfg.parent = undefined;
    const onRepress = vi.fn();

    expect(() => renderHook(() => useTabRepress(onRepress))).not.toThrow();
  });
});
