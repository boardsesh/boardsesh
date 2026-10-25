// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

type TabPressListener = (event: { data?: { isPrevented?: boolean } }) => void;

const cfg = vi.hoisted(() => {
  const state = {
    isFocused: true,
    tabPressListeners: [] as TabPressListener[],
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

import { useTabReselect } from '../use-tab-reselect';

function pressTab(data?: { isPrevented?: boolean }) {
  for (const listener of cfg.tabPressListeners) listener({ data });
}

describe('useTabReselect', () => {
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
    const onReselect = vi.fn();
    renderHook(() => useTabReselect(onReselect));

    pressTab({ isPrevented: false });
    expect(onReselect).not.toHaveBeenCalled();
    vi.runAllTimers();

    expect(onReselect).toHaveBeenCalledOnce();
  });

  it('ignores the press that opens the tab from elsewhere', () => {
    // The navigator emits tabPress before switching, so a first tap from another
    // tab (or from a route pushed on top) finds this screen unfocused.
    cfg.isFocused = false;
    const onReselect = vi.fn();
    renderHook(() => useTabReselect(onReselect));

    pressTab({ isPrevented: false });
    vi.runAllTimers();

    expect(onReselect).not.toHaveBeenCalled();
  });

  it('ignores a press the native bar refused', () => {
    const onReselect = vi.fn();
    renderHook(() => useTabReselect(onReselect));

    pressTab({ isPrevented: true });
    vi.runAllTimers();

    expect(onReselect).not.toHaveBeenCalled();
  });

  it('accepts the JS tab bar press, which carries no data', () => {
    const onReselect = vi.fn();
    renderHook(() => useTabReselect(onReselect));

    pressTab(undefined);
    vi.runAllTimers();

    expect(onReselect).toHaveBeenCalledOnce();
  });

  it('collapses presses inside one frame into one call', () => {
    const onReselect = vi.fn();
    renderHook(() => useTabReselect(onReselect));

    pressTab({ isPrevented: false });
    pressTab({ isPrevented: false });
    vi.runAllTimers();

    expect(onReselect).toHaveBeenCalledOnce();
  });

  it('unsubscribes and drops a pending frame on unmount', () => {
    const onReselect = vi.fn();
    const { unmount } = renderHook(() => useTabReselect(onReselect));

    pressTab({ isPrevented: false });
    unmount();
    vi.runAllTimers();

    expect(cfg.unsubscribe).toHaveBeenCalledOnce();
    expect(onReselect).not.toHaveBeenCalled();
  });

  it('calls the latest callback without subscribing again', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ onReselect }) => useTabReselect(onReselect), {
      initialProps: { onReselect: first },
    });
    rerender({ onReselect: second });

    pressTab({ isPrevented: false });
    vi.runAllTimers();

    expect(cfg.tabPressListeners).toHaveLength(1);
    expect(cfg.unsubscribe).not.toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('does nothing without a parent navigator', () => {
    cfg.parent = undefined;
    const onReselect = vi.fn();

    expect(() => renderHook(() => useTabReselect(onReselect))).not.toThrow();
  });
});
