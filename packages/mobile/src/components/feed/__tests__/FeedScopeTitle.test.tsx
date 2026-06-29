// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import type { AppMenuAction, AppMenuProps } from '../../AppMenu';

// Capture the props FeedScopeTitle hands to AppMenu — the native menu popup and the
// selected-row marker are AppMenu's job (its resolver is covered by app-menu.test.tsx);
// here we only verify FeedScopeTitle forwards actions + label and picks the per-variant
// width cap.
const capture = vi.hoisted(() => ({
  label: undefined as string | undefined,
  actions: undefined as AppMenuAction[] | undefined,
  onSelectIndex: undefined as ((index: number) => void) | undefined,
  accessibilityLabel: undefined as string | undefined,
  maxWidth: undefined as number | undefined,
}));
const ctrl = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));

vi.mock('../../AppMenu', () => ({
  AppMenu: ({ label, actions, onSelectIndex, accessibilityLabel, maxWidth }: AppMenuProps) => {
    capture.label = label;
    capture.actions = actions;
    capture.onSelectIndex = onSelectIndex;
    capture.accessibilityLabel = accessibilityLabel;
    capture.maxWidth = maxWidth;
    return createElement('div', { 'data-app-menu': 'true' }, label);
  },
}));

// FeedScopeTitle's only branch is the width cap, chosen by `useVariantValue`; mock it
// to honour the test's variant instead of standing up the whole theme provider.
vi.mock('../../../theme/variants', () => ({
  useVariantValue: (byVariant: Record<'liquidGlass' | 'material', unknown>) => byVariant[ctrl.variant],
}));

import { FeedScopeTitle } from '../FeedScopeTitle';

const ACTIONS: AppMenuAction[] = [
  { label: 'My crew', selected: true, systemIcon: 'person.2.fill' },
  { label: 'Everyone', selected: false },
];

beforeEach(() => {
  capture.label = undefined;
  capture.actions = undefined;
  capture.onSelectIndex = undefined;
  capture.accessibilityLabel = undefined;
  capture.maxWidth = undefined;
  ctrl.variant = 'liquidGlass';
});

describe('FeedScopeTitle', () => {
  it('forwards its actions to AppMenu unchanged (incl. the iOS-only systemIcon)', () => {
    render(createElement(FeedScopeTitle, { title: 'My crew', actions: ACTIONS, onSelectIndex: () => {} }));
    expect(capture.actions).toBe(ACTIONS);
    expect(capture.actions?.[0].systemIcon).toBe('person.2.fill');
  });

  it('labels the native menu with the active scope and forwards onSelectIndex', () => {
    const onSelectIndex = vi.fn();
    render(createElement(FeedScopeTitle, { title: 'My crew', actions: ACTIONS, onSelectIndex }));
    expect(capture.label).toBe('My crew');
    expect(capture.accessibilityLabel).toBe('My crew');
    capture.onSelectIndex?.(1);
    expect(onSelectIndex).toHaveBeenCalledWith(1);
  });

  it('caps the anchor wider on Liquid Glass (the floating pill has room to grow)', () => {
    render(createElement(FeedScopeTitle, { title: 'My crew', actions: ACTIONS, onSelectIndex: () => {} }));
    expect(capture.maxWidth).toBe(240);
  });

  it('caps the anchor tighter on Material (it shares the app-bar row with the avatar + action)', () => {
    ctrl.variant = 'material';
    render(createElement(FeedScopeTitle, { title: 'My crew', actions: ACTIONS, onSelectIndex: () => {} }));
    expect(capture.maxWidth).toBe(220);
  });
});
