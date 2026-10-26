// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';

// The iPhone host of NativeTabletContent across the phone split (iPhone Duo
// opened into landscape): the player on the leading half, the tab content on the
// trailing half beside the rail. The tab's stack must never remount when the
// split comes and goes, and each half must read the side insets that belong to it.

const cfg = vi.hoisted(() => ({
  phoneSplit: false,
  // A tab's safe area on the Duo's inner display in landscape: the rail and the
  // side status bar arrive as the right inset.
  insets: { top: 0, bottom: 21, left: 0, right: 84 },
  windowWidth: 951,
  isPad: false,
}));
const captured = vi.hoisted(() => ({
  contentInsets: [] as Array<{ left: number; right: number }>,
  paneInsets: null as { left: number; right: number } | null,
  paneProps: null as Record<string, unknown> | null,
  stackMounts: 0,
}));

vi.mock('react-native', () => ({
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('div', { 'data-style': JSON.stringify(style) }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: {
    OS: 'ios',
    get isPad() {
      return cfg.isPad;
    },
  },
  useWindowDimensions: () => ({ width: cfg.windowWidth, height: 669 }),
}));

vi.mock('react-native-safe-area-context', async () => {
  const { createContext, useContext } = await import('react');
  const SafeAreaInsetsContext = createContext<typeof cfg.insets | null>(null);
  return {
    SafeAreaInsetsContext,
    useSafeAreaInsets: () => useContext(SafeAreaInsetsContext) ?? cfg.insets,
  };
});

vi.mock('expo-router', () => ({ useIsFocused: () => true }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { separator: '#333' } }),
}));
vi.mock('../../../hooks/use-native-root-header', () => ({ useNativeRootHeader: () => true }));
vi.mock('../../../hooks/use-phone-split', () => ({ usePhoneSplit: () => cfg.phoneSplit }));
vi.mock('../../play-drawer/IpadPlayPane', async () => {
  const { useSafeAreaInsets } = await import('react-native-safe-area-context');
  return {
    IpadPlayPane: (props: Record<string, unknown>) => {
      const { left, right } = useSafeAreaInsets();
      captured.paneInsets = { left, right };
      captured.paneProps = props;
      return createElement('div', { 'data-pane': 'true' });
    },
  };
});

import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeTabletContent } from '../NativeTabletContent';
import { usePhoneSplitPaneContent } from '../phone-split-pane-slot';

/** Stands in for the tab's native stack: counts mounts, records the insets it reads. */
function TabStack() {
  const { left, right } = useSafeAreaInsets();
  captured.contentInsets.push({ left, right });
  useEffect(() => {
    captured.stackMounts += 1;
  }, []);
  return createElement('div', { 'data-stack': 'true' });
}

function renderTab() {
  return render(createElement(NativeTabletContent, null, createElement(TabStack)));
}

describe('NativeTabletContent on iPhone, across the phone split', () => {
  beforeEach(() => {
    cfg.phoneSplit = false;
    cfg.isPad = false;
    captured.contentInsets = [];
    captured.paneInsets = null;
    captured.paneProps = null;
    captured.stackMounts = 0;
  });

  it('keeps the same tab stack mounted as the split comes and goes', () => {
    const view = renderTab();
    expect(view.container.querySelector('[data-pane="true"]')).toBeNull();
    cfg.phoneSplit = true;
    view.rerender(createElement(NativeTabletContent, null, createElement(TabStack)));
    expect(view.container.querySelector('[data-pane="true"]')).not.toBeNull();
    cfg.phoneSplit = false;
    view.rerender(createElement(NativeTabletContent, null, createElement(TabStack)));
    expect(view.container.querySelector('[data-pane="true"]')).toBeNull();
    expect(captured.stackMounts).toBe(1);
  });

  it('puts the player before the tab content, the pane ending at the hinge', () => {
    cfg.phoneSplit = true;
    const view = renderTab();
    const host = view.container.firstElementChild;
    const paneColumn = view.container.querySelector('[data-pane="true"]')?.parentElement;
    const contentColumn = view.container.querySelector('[data-stack="true"]')?.parentElement;
    expect(host?.firstElementChild).toBe(paneColumn);
    expect(host?.lastElementChild).toBe(contentColumn);
    // 951pt window: the hinge is at 476, with no gutter while flat.
    expect(paneColumn?.getAttribute('data-style')).toContain('"width":476');
  });

  it('keeps the real rail inset for the trailing content column', () => {
    cfg.phoneSplit = true;
    renderTab();
    expect(captured.contentInsets.at(-1)).toEqual({ left: 0, right: 84 });
  });

  it('hands the leading pane zero side insets: the rail is on the far side', () => {
    cfg.phoneSplit = true;
    const view = renderTab();
    expect(captured.paneInsets).toEqual({ left: 0, right: 0 });
    expect(captured.paneProps).toMatchObject({ variant: 'phoneSplit', acceptsScrollHandoff: true });
    const paneColumn = view.container.querySelector('[data-pane="true"]')?.parentElement;
    expect(paneColumn?.getAttribute('data-style')).toContain('"paddingLeft":0');
    expect(paneColumn?.getAttribute('data-style')).not.toContain('"paddingRight"');
  });

  it("shows a screen's own content in the pane instead of the player, and the player again after", () => {
    cfg.phoneSplit = true;
    function PreviewScreen({ show }: { show: boolean }) {
      usePhoneSplitPaneContent(show ? createElement('div', { 'data-preview': 'true' }) : null);
      return createElement('div', { 'data-stack': 'true' });
    }
    const view = render(createElement(NativeTabletContent, null, createElement(PreviewScreen, { show: true })));
    expect(view.container.querySelector('[data-preview="true"]')).not.toBeNull();
    expect(view.container.querySelector('[data-pane="true"]')).toBeNull();

    view.rerender(createElement(NativeTabletContent, null, createElement(PreviewScreen, { show: false })));
    expect(view.container.querySelector('[data-preview="true"]')).toBeNull();
    expect(view.container.querySelector('[data-pane="true"]')).not.toBeNull();
  });

  it('passes the real insets through untouched off the split', () => {
    renderTab();
    expect(captured.contentInsets.at(-1)).toEqual({ left: 0, right: 84 });
  });

  it('renders the native iPad tab as it is: one column, no pane to host', () => {
    // Like Apple Music: the current climb rides the bottom accessory and the
    // player opens full screen, so the iPad never mounts a pane beside the tab.
    cfg.isPad = true;
    cfg.phoneSplit = true;
    const view = renderTab();
    expect(view.container.querySelector('[data-pane="true"]')).toBeNull();
    expect(view.container.firstElementChild?.getAttribute('data-stack')).toBe('true');
  });
});
