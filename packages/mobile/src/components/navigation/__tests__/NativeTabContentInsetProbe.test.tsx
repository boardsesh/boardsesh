// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useEffect } from 'react';
import {
  resetNativeTabContentInsetForTests,
  useNativeTabContentInsetBottom,
} from '../../../lib/native-tab-content-inset-store';

const ctrl = vi.hoisted(() => ({
  nativeTabBar: true,
  focused: true,
  insetsBottom: 83,
}));

vi.mock('expo-router', async () => {
  const { useEffect: reactUseEffect } = await import('react');
  return {
    // Runs the focus effect like react-navigation does for a focused screen;
    // flipping ctrl.focused simulates an unfocused tab (effect never fires).
    useFocusEffect: (effect: () => void | (() => void)) => {
      reactUseEffect(() => {
        if (!ctrl.focused) return;
        return effect();
      }, [effect]);
    },
  };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: ctrl.insetsBottom, left: 0, right: 0 }),
}));
vi.mock('../../../hooks/use-bottom-accessory', () => ({
  useNativeTabBar: () => ctrl.nativeTabBar,
}));

import { NativeTabContentInsetProbe } from '../NativeTabContentInsetProbe';

// Store-reading harness: asserts what the probe published without reaching into
// store internals.
function StoreReader({ onValue }: { onValue: (value: number | null) => void }) {
  const value = useNativeTabContentInsetBottom();
  useEffect(() => {
    onValue(value);
  }, [onValue, value]);
  return null;
}

describe('NativeTabContentInsetProbe', () => {
  beforeEach(() => {
    resetNativeTabContentInsetForTests();
    ctrl.nativeTabBar = true;
    ctrl.focused = true;
    ctrl.insetsBottom = 83;
  });

  const lastPublished = () => {
    let latest: number | null = null;
    const capture = (value: number | null) => {
      latest = value;
    };
    // A fresh element per (re)render so React never bails out on an identical
    // element reference — the probe must re-read the mocked insets.
    const tree = () => (
      <>
        <NativeTabContentInsetProbe />
        <StoreReader onValue={capture} />
      </>
    );
    const view = render(tree());
    return { view, read: () => latest, rerender: () => view.rerender(tree()) };
  };

  it('publishes the in-tab inset when focused on the native tab bar', () => {
    const { read } = lastPublished();
    expect(read()).toBe(83);
  });

  it('renders nothing and publishes nothing off the native-tab-bar path', () => {
    ctrl.nativeTabBar = false;
    const { view, read } = lastPublished();
    expect(view.container.innerHTML).toBe('');
    expect(read()).toBeNull();
  });

  it('does not publish from an unfocused tab', () => {
    // An unfocused tab's detached view can report a bar-less inset; a publish
    // from it would put the Start capsule back under the bar (last-writer-wins).
    ctrl.focused = false;
    const { read } = lastPublished();
    expect(read()).toBeNull();
  });

  it('re-publishes when the in-tab inset changes while focused', () => {
    const { read, rerender } = lastPublished();
    expect(read()).toBe(83);
    ctrl.insetsBottom = 139;
    rerender();
    expect(read()).toBe(139);
  });
});
