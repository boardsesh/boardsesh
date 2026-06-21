// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { ContextMenuAction, ContextMenuOnPressNativeEvent } from 'react-native-context-menu-view';

const ctrl = vi.hoisted(() => ({
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  os: 'ios' as 'ios' | 'android',
}));
const cm = vi.hoisted(() => ({
  actions: undefined as ContextMenuAction[] | undefined,
  onPress: undefined as ((event: { nativeEvent: ContextMenuOnPressNativeEvent }) => void) | undefined,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return ctrl.os;
    },
  },
  PlatformColor: (name: string) => name,
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress, 'data-anchor': 'true' }, children),
}));
vi.mock('react-native-context-menu-view', () => ({
  default: ({
    actions,
    onPress,
    children,
  }: {
    actions?: ContextMenuAction[];
    onPress?: (event: { nativeEvent: ContextMenuOnPressNativeEvent }) => void;
    children?: ReactNode;
  }) => {
    cm.actions = actions;
    cm.onPress = onPress;
    return createElement('div', { 'data-cm': 'true' }, children);
  },
}));
vi.mock('react-native-paper', () => {
  const Menu = ({ anchor, children }: { anchor?: ReactNode; children?: ReactNode }) =>
    createElement('div', { 'data-menu': 'true' }, anchor, children);
  Menu.Item = ({ title, onPress, leadingIcon }: { title?: string; onPress?: () => void; leadingIcon?: string }) =>
    createElement('button', { onClick: onPress, 'data-leading': leadingIcon ?? '' }, title);
  return { Menu };
});
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ variant: ctrl.variant, m3: { error: '#B00020' } }),
}));

import { AppMenu, type AppMenuAction } from '../AppMenu';

const ACTIONS: AppMenuAction[] = [
  { label: 'My crew', selected: true, systemIcon: 'person.2.fill' },
  { label: 'Everyone' },
];

function renderMenu(onSelectIndex = vi.fn()) {
  const utils = render(
    createElement(AppMenu, { actions: ACTIONS, onSelectIndex, accessibilityLabel: 'Scope', children: 'anchor' }),
  );
  return { ...utils, onSelectIndex };
}

beforeEach(() => {
  ctrl.variant = 'liquidGlass';
  ctrl.os = 'ios';
  cm.actions = undefined;
  cm.onPress = undefined;
});

describe('AppMenu — Material (Paper Menu)', () => {
  beforeEach(() => {
    ctrl.variant = 'material';
  });

  it('renders an M3 menu item per action with a checkmark on the selected row', () => {
    const { container } = renderMenu();
    const items = [...container.querySelectorAll('button[data-leading]')];
    expect(items.map((b) => b.textContent)).toEqual(['My crew', 'Everyone']);
    expect(items[0].getAttribute('data-leading')).toBe('check'); // selected
    expect(items[1].getAttribute('data-leading')).toBe(''); // not selected
  });

  it('forwards the tapped item index to onSelectIndex', () => {
    const { container, onSelectIndex } = renderMenu();
    const everyone = [...container.querySelectorAll('button[data-leading]')].find((b) => b.textContent === 'Everyone');
    (everyone as HTMLButtonElement).click();
    expect(onSelectIndex).toHaveBeenCalledWith(1);
  });
});

describe('AppMenu — Liquid Glass (native dropdown)', () => {
  it('passes actions through unchanged on iOS (native checkmark renders the marker)', () => {
    renderMenu();
    expect(cm.actions?.map((a) => a.title)).toEqual(['My crew', 'Everyone']);
    expect(cm.actions?.[0].selected).toBe(true);
    // SF Symbol forwarded to the native dropdown (regression guard).
    expect(cm.actions?.[0].systemIcon).toBe('person.2.fill');
  });

  it('prefixes the selected row with a checkmark on Android (no native marker there)', () => {
    ctrl.os = 'android';
    renderMenu();
    expect(cm.actions?.[0].title.startsWith('✓')).toBe(true);
    expect(cm.actions?.[0].title.endsWith('My crew')).toBe(true);
    expect(cm.actions?.[1].title).toBe('Everyone');
  });

  it('forwards the pressed native index to onSelectIndex', () => {
    const { onSelectIndex } = renderMenu();
    cm.onPress?.({ nativeEvent: { index: 1, indexPath: [1], name: 'Everyone' } });
    expect(onSelectIndex).toHaveBeenCalledWith(1);
  });
});
