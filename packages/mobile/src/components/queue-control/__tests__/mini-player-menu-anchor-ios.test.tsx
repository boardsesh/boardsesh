// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { MiniPlayerMenuAnchor } from '../MiniPlayerMenuAnchor.ios';
import {
  AccessoryPresentationContext,
  createAccessoryPresentationStore,
  type AccessoryPresentationEvent,
} from '../accessory-presentation';

type MeasureCallback = (x: number, y: number, width: number, height: number) => void;
const state = vi.hoisted(() => ({
  segments: ['(tabs)', 'climbs'] as string[],
  credentialGeneration: 0,
  verticalTabBar: false,
  credentialListeners: new Set<() => void>(),
  deferSource: false,
  pendingSource: [] as MeasureCallback[],
  sourceLayout: null as (() => void) | null,
  rootLayout: null as (() => void) | null,
  source: [576, 1136, 44, 44] as [number, number, number, number],
  root: [20, 64, 814, 1146] as [number, number, number, number],
}));

vi.mock('expo-router', () => ({ useSegments: () => state.segments }));
vi.mock('../../../hooks/use-vertical-tab-bar', () => ({ useVerticalTabBar: () => state.verticalTabBar }));
vi.mock('../../../lib/privacy/privacy-cache', () => ({
  getCredentialGeneration: () => state.credentialGeneration,
  subscribeToCredentialChanges: (listener: () => void) => {
    state.credentialListeners.add(listener);
    return () => state.credentialListeners.delete(listener);
  },
}));
vi.mock('react-native-paper', async () => {
  const { createPortal } = await vi.importActual<{
    createPortal: (children: ReactNode, container: Element) => ReactNode;
  }>('react-dom');
  return { Portal: ({ children }: { children: ReactNode }) => createPortal(children, document.body) };
});
vi.mock('../../AppMenu', () => ({
  AppMenu: ({
    accessibilityLabel,
    onSelectIndex,
  }: {
    accessibilityLabel: string;
    onSelectIndex: (index: number) => void;
  }) =>
    createElement(
      'button',
      { 'aria-label': accessibilityLabel, 'data-native-menu': true, onClick: () => onSelectIndex(0) },
      '⋯',
    ),
}));
vi.mock('react-native', async () => {
  const React = await import('react');
  const View = React.forwardRef(function View(
    {
      children,
      pointerEvents,
      style,
      onLayout,
      accessible,
      accessibilityElementsHidden,
    }: {
      children?: ReactNode;
      pointerEvents?: string;
      style?: object;
      onLayout?: () => void;
      accessible?: boolean;
      accessibilityElementsHidden?: boolean;
    },
    ref,
  ) {
    const source = pointerEvents === 'none';
    if (source) state.sourceLayout = onLayout ?? null;
    else if (onLayout) state.rootLayout = onLayout;
    React.useImperativeHandle(ref, () => ({
      measureInWindow(callback: MeasureCallback) {
        if (source && state.deferSource) state.pendingSource.push(callback);
        else callback(...(source ? state.source : state.root));
      },
    }));
    React.useLayoutEffect(() => onLayout?.(), [onLayout]);
    return createElement(
      'div',
      {
        style,
        'data-source-slot': source || undefined,
        'data-accessible': String(accessible),
        'aria-hidden': accessibilityElementsHidden || undefined,
      },
      children,
    );
  });
  return { View, StyleSheet: { absoluteFill: { position: 'absolute', inset: 0 } } };
});

const native: AccessoryPresentationEvent = {
  phase: 'settled',
  environment: 'regular',
  sourceId: 1,
  revision: 1,
  windowX: 73,
  windowY: 1126,
  width: 689,
  height: 64,
};
const menuProps = {
  iconName: 'more' as const,
  anchorSize: 44,
  accessibilityLabel: 'More for Crimp Line',
  actions: [{ label: 'Share' }],
  onSelectIndex: vi.fn(),
};
const nativeMenu = () => document.querySelector<HTMLButtonElement>('[data-native-menu]');

function mount(store = createAccessoryPresentationStore()) {
  const tree = () =>
    createElement(
      AccessoryPresentationContext.Provider,
      { value: store },
      createElement(MiniPlayerMenuAnchor, menuProps),
    );
  return { store, tree, ...render(tree()) };
}

beforeEach(() => {
  state.segments = ['(tabs)', 'climbs'];
  state.credentialGeneration = 0;
  state.verticalTabBar = false;
  state.deferSource = false;
  state.pendingSource = [];
  state.sourceLayout = null;
  state.rootLayout = null;
  state.source = [576, 1136, 44, 44];
  state.root = [20, 64, 814, 1146];
  menuProps.onSelectIndex.mockClear();
});
afterEach(cleanup);

describe('native mini-player root menu anchor', () => {
  it('keeps the slot but no live trigger before native settlement', () => {
    const { container } = mount();
    expect(container.querySelector('[data-source-slot]')?.getAttribute('aria-hidden')).toBe('true');
    expect(nativeMenu()).toBeNull();
  });

  it('hosts exactly one accessible native trigger outside the accessory slot', () => {
    const { store, container } = mount();
    act(() => store.publish(native));
    const button = nativeMenu();
    expect(button).not.toBeNull();
    if (button === null) throw new Error('Expected the native menu trigger');
    expect(container.contains(button)).toBe(false);
    expect(document.querySelectorAll('[data-native-menu]')).toHaveLength(1);
    expect(button.parentElement?.style.left).toBe('556px');
    expect(button.parentElement?.style.top).toBe('1072px');
    fireEvent.click(button);
    expect(menuProps.onSelectIndex).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each([{ phase: 'moving' }, { phase: 'detached' }, { environment: 'inline' }])(
    'withdraws the portaled trigger on %j',
    (change) => {
      const { store } = mount();
      act(() => store.publish(native));
      expect(nativeMenu()).not.toBeNull();
      act(() => store.publish({ ...native, ...change, revision: 2 }));
      expect(nativeMenu()).toBeNull();
    },
  );

  it.each([
    ['play'],
    ['wall-display'],
    ['settings', 'account'],
    ['(tabs)', 'climbs', 'holds'],
    ['(tabs)', 'climbs', 'zone'],
    ['(tabs)', 'profile', 'settings'],
  ])('does not float above a covered or pushed route %j', (...segments) => {
    const { store, rerender, tree } = mount();
    act(() => store.publish(native));
    state.segments = segments;
    rerender(tree());
    expect(nativeMenu()).toBeNull();
  });

  it('rejects a measurement completed after movement and remeasures at the new location', () => {
    state.deferSource = true;
    const { store } = mount();
    act(() => store.publish(native));
    const stale = state.pendingSource.at(-1);
    act(() => store.publish({ ...native, phase: 'moving', revision: 2 }));
    act(() => stale?.(...state.source));
    expect(nativeMenu()).toBeNull();
    state.deferSource = false;
    state.source = [400, 900, 44, 44];
    act(() => store.publish({ ...native, revision: 3, windowX: 100, windowY: 890, width: 689 }));
    expect(nativeMenu()?.parentElement?.style.left).toBe('380px');
    expect(nativeMenu()?.parentElement?.style.top).toBe('836px');
  });

  it.each(['source', 'root'] as const)(
    'withdraws an old hit target during a deferred %s layout measurement',
    (changed) => {
      const { store } = mount();
      act(() => store.publish(native));
      expect(nativeMenu()).not.toBeNull();
      state.deferSource = true;
      if (changed === 'source') state.source = [500, 1136, 44, 44];
      else state.root = [40, 64, 794, 1146];
      act(() => (changed === 'source' ? state.sourceLayout : state.rootLayout)?.());
      expect(nativeMenu()).toBeNull();
      const pending = state.pendingSource.at(-1);
      expect(pending).toBeDefined();
      act(() => pending?.(...state.source));
      expect(nativeMenu()?.parentElement?.style.left).toBe(changed === 'source' ? '480px' : '536px');
    },
  );

  it('follows the existing Duo rail exception for pushed filters', () => {
    state.verticalTabBar = true;
    state.segments = ['(tabs)', 'climbs', 'holds'];
    const { store, rerender, tree } = mount();
    act(() => store.publish(native));
    expect(nativeMenu()).not.toBeNull();
    state.segments = ['wall-display'];
    rerender(tree());
    expect(nativeMenu()).toBeNull();
  });

  it.each([
    ['onboarding'],
    ['wall-display'],
    ['privacy-consent'],
    ['(tabs)', 'climbs', 'setters'],
    ['(tabs)', 'profile', 'settings'],
  ])('does not mistake a mounted Duo accessory for a visible surface on %j', (...segments) => {
    state.verticalTabBar = true;
    state.segments = segments;
    const { store } = mount();
    act(() => store.publish(native));
    expect(nativeMenu()).toBeNull();
  });

  it('retires the native menu immediately on credential change and rejects old callbacks', () => {
    const { store } = mount();
    act(() => store.publish(native));
    const oldButton = nativeMenu();
    act(() => {
      state.credentialGeneration++;
      for (const listener of state.credentialListeners) listener();
    });
    expect(nativeMenu()).toBeNull();
    expect(document.body.contains(oldButton)).toBe(false);
    // Even an immediate, otherwise-valid remeasurement cannot relabel old actions
    // as belonging to the new account. Its real source must remount first.
    act(() => store.publish({ ...native, revision: 2 }));
    expect(nativeMenu()).toBeNull();
  });

  it('removes the portal on source unmount and ignores an outstanding measurement', () => {
    state.deferSource = true;
    const { store, unmount } = mount();
    act(() => store.publish(native));
    const stale = state.pendingSource.at(-1);
    unmount();
    act(() => stale?.(...state.source));
    expect(nativeMenu()).toBeNull();
  });
});
