// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { AppMenuAction } from '../../AppMenu';

// Capture the props FeedScopeTitle hands to AppMenu — the per-variant menu and the
// selected-row marker are AppMenu's job (covered by app-menu.test.tsx); here we
// only verify FeedScopeTitle forwards its actions + labels the menu.
const capture = vi.hoisted(() => ({
  actions: undefined as AppMenuAction[] | undefined,
  onSelectIndex: undefined as ((index: number) => void) | undefined,
  accessibilityLabel: undefined as string | undefined,
}));
const ctrl = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-view': 'true' }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));

vi.mock('../../AppMenu', () => ({
  AppMenu: ({
    actions,
    onSelectIndex,
    accessibilityLabel,
    children,
  }: {
    actions: AppMenuAction[];
    onSelectIndex: (index: number) => void;
    accessibilityLabel?: string;
    children?: ReactNode;
  }) => {
    capture.actions = actions;
    capture.onSelectIndex = onSelectIndex;
    capture.accessibilityLabel = accessibilityLabel;
    return createElement('div', { 'data-app-menu': 'true' }, children);
  },
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../GlassSurface', () => ({ GlassSurface: () => createElement('div', { 'data-glass': 'true' }) }));
vi.mock('../../../hooks/use-native-glass', () => ({ useNativeGlass: () => false }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: ctrl.variant,
    systemColors: { label: '#000', secondaryLabel: '#999', separator: '#ccc', elevatedSurface: '#fff' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 4: 16 }, shadows: { sm: {} } }));
vi.mock('../../../theme/layout', () => ({ glassSize: { capsule: 44 } }));

import { FeedScopeTitle } from '../FeedScopeTitle';

const ACTIONS: AppMenuAction[] = [
  { label: 'My crew', selected: true, systemIcon: 'person.2.fill' },
  { label: 'Everyone', selected: false },
];

beforeEach(() => {
  capture.actions = undefined;
  capture.onSelectIndex = undefined;
  capture.accessibilityLabel = undefined;
  ctrl.variant = 'liquidGlass';
});

describe('FeedScopeTitle', () => {
  it('forwards its actions to AppMenu unchanged (incl. the Glass-only systemIcon)', () => {
    render(createElement(FeedScopeTitle, { title: 'My crew', actions: ACTIONS, onSelectIndex: () => {} }));
    expect(capture.actions).toBe(ACTIONS);
    expect(capture.actions?.[0].systemIcon).toBe('person.2.fill');
  });

  it('labels the menu with the active scope and forwards onSelectIndex', () => {
    const onSelectIndex = vi.fn();
    render(createElement(FeedScopeTitle, { title: 'My crew', actions: ACTIONS, onSelectIndex }));
    expect(capture.accessibilityLabel).toBe('My crew');
    capture.onSelectIndex?.(1);
    expect(onSelectIndex).toHaveBeenCalledWith(1);
  });

  it('renders the floating glass pill on Liquid Glass', () => {
    const { container } = render(
      createElement(FeedScopeTitle, { title: 'My crew', actions: ACTIONS, onSelectIndex: () => {} }),
    );
    expect(container.querySelector('[data-glass]')).not.toBeNull();
  });

  it('renders the flat M3 title-menu (no glass pill) on Material, still forwarding its actions', () => {
    ctrl.variant = 'material';
    const { container } = render(
      createElement(FeedScopeTitle, { title: 'My crew', actions: ACTIONS, onSelectIndex: () => {} }),
    );
    // The Material app-bar title is flat — no floating GlassSurface pill.
    expect(container.querySelector('[data-glass]')).toBeNull();
    // Still a menu anchored to the title, still forwarding its actions + label.
    expect(container.querySelector('[data-app-menu]')).not.toBeNull();
    expect(capture.actions).toBe(ACTIONS);
    expect(capture.accessibilityLabel).toBe('My crew');
  });
});
