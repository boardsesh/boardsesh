// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import {
  resetNativeTabContentInsetForTests,
  useNativeTabContentInsetBottom,
} from '../../../lib/native-tab-content-inset-store';

// Per-probe control. `currentTabIndex` is stamped by <TabHost> during render
// (React renders depth-first, so a host's probe reads its own index before the
// next sibling host renders); the single-probe tests never mount a TabHost and
// run entirely on index 0.
const ctrl = vi.hoisted(() => ({
  nativeTabBar: true,
  currentTabIndex: 0,
  focusByIndex: [true] as boolean[],
  insetsByIndex: [83] as number[],
  focusOf(index: number): boolean {
    return this.focusByIndex[index] ?? false;
  },
  insetOf(index: number): number {
    return this.insetsByIndex[index] ?? 0;
  },
}));

vi.mock('expo-router', async () => {
  const { useEffect: reactUseEffect, useRef: reactUseRef } = await import('react');
  return {
    // Runs the focus effect like react-navigation does for a focused screen;
    // the per-index focus flag simulates an unfocused tab (effect cleans up /
    // never fires). The flag is in the deps so a focus flip re-runs the effect
    // on rerender, mirroring the focus/blur events. The index is captured ONCE
    // at mount (ref): a state-driven re-render of one publisher happens outside
    // its TabHost, so the module-level stamp would be stale there.
    useFocusEffect: (effect: () => void | (() => void)) => {
      const tabIndexRef = reactUseRef(ctrl.currentTabIndex);
      const focused = ctrl.focusOf(tabIndexRef.current);
      reactUseEffect(() => {
        if (!focused) return;
        return effect();
      }, [effect, focused]);
    },
  };
});
vi.mock('react-native-safe-area-context', async () => {
  const { useRef: reactUseRef } = await import('react');
  return {
    // Same mount-captured index as the useFocusEffect mock (see above).
    useSafeAreaInsets: () => {
      const tabIndexRef = reactUseRef(ctrl.currentTabIndex);
      return { top: 59, bottom: ctrl.insetOf(tabIndexRef.current), left: 0, right: 0 };
    },
  };
});
vi.mock('../../../hooks/use-bottom-accessory', () => ({
  useNativeTabBar: () => ctrl.nativeTabBar,
}));

import { NativeTabContentInsetProbe } from '../NativeTabContentInsetProbe';

// Simulates one tab's layout: stamps the index the mocked hooks resolve their
// per-tab focus/inset values with while this subtree renders.
function TabHost({ index, children }: { index: number; children: ReactNode }) {
  ctrl.currentTabIndex = index;
  return children;
}

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
    ctrl.currentTabIndex = 0;
    ctrl.focusByIndex = [true];
    ctrl.insetsByIndex = [83];
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
    ctrl.focusByIndex = [false];
    const { read } = lastPublished();
    expect(read()).toBeNull();
  });

  it('re-publishes when the in-tab inset changes while focused', () => {
    const { read, rerender } = lastPublished();
    expect(read()).toBe(83);
    ctrl.insetsByIndex = [139];
    rerender();
    expect(read()).toBe(139);
  });

  it('lets only the focused probe win when several tabs mount probes at once', () => {
    // expo-router mounts every tab's screen (no freeze), so all five probes are
    // live. Tab B is unfocused and its detached view reports a bar-less inset
    // (34) — exactly the stale value that must never reach the last-writer-wins
    // store. Then focus moves to tab B, whose view attaches and reports the
    // accessory inset; B's publish must now win.
    let latest: number | null = null;
    const capture = (value: number | null) => {
      latest = value;
    };
    ctrl.focusByIndex = [true, false];
    ctrl.insetsByIndex = [83, 34];
    const tree = () => (
      <>
        <TabHost index={0}>
          <NativeTabContentInsetProbe />
        </TabHost>
        <TabHost index={1}>
          <NativeTabContentInsetProbe />
        </TabHost>
        <StoreReader onValue={capture} />
      </>
    );
    const view = render(tree());
    expect(latest).toBe(83);

    ctrl.focusByIndex = [false, true];
    ctrl.insetsByIndex = [83, 139];
    view.rerender(tree());
    expect(latest).toBe(139);
  });
});
