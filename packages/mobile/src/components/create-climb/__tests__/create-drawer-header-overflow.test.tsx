// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// The header owns the ⋯ menu, and the menu reports a POSITION. The row set
// changes with editor state — Woods drops the route rows, a one-frame route has
// no frame to delete — so a stale index-to-action assumption would quietly fire
// the wrong command. These pin that the header resolves a tap through the rows
// it actually rendered.

type ViewMockProps = { children?: ReactNode; testID?: string };
vi.mock('react-native', () => ({
  View: ({ children, testID }: ViewMockProps) => createElement('div', { 'data-testid': testID }, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('@expo/ui/community/bottom-sheet', () => ({ BottomSheetTextInput: () => createElement('input') }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, number | string>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name?: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../ble/BleLightbulbButton', () => ({
  BleLightbulbButton: () => createElement('span', { 'data-ble': 'true' }),
}));
// One button per row, in the order the header handed them over — enough to fire
// a specific POSITION, which is the thing under test.
vi.mock('../../AppMenu', () => ({
  AppMenu: ({
    actions,
    onSelectIndex,
    accessibilityLabel,
  }: {
    actions: { label: string; disabled?: boolean }[];
    onSelectIndex: (index: number) => void;
    accessibilityLabel?: string;
  }) =>
    createElement(
      'div',
      { 'data-node': 'overflow', 'data-label': accessibilityLabel },
      actions.map((action, index) =>
        createElement('button', {
          key: action.label,
          'data-row': action.label,
          'data-disabled': action.disabled ? 'true' : 'false',
          onClick: () => onSelectIndex(index),
        }),
      ),
    ),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#000', secondaryLabel: '#666', fill: '#EEE' } }),
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemGray: '#8E8E93' } }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));

import { CreateDrawerHeader } from '../CreateDrawerHeader';

function renderHeader(overflow: Partial<Parameters<typeof CreateDrawerHeader>[0]['overflow']> = {}) {
  const onSelectOverflowAction = vi.fn();
  const { container } = render(
    createElement(CreateDrawerHeader, {
      name: 'Test climb',
      onChangeName: vi.fn(),
      startingCount: 0,
      finishCount: 0,
      focusSignal: 0,
      onClose: vi.fn(),
      bleConnected: false,
      bleConnecting: false,
      onToggleBle: vi.fn(),
      overflow: { supportsMultiFrame: true, routeMode: false, frameCount: 1, ...overflow },
      onSelectOverflowAction,
    }),
  );
  // Looked up by scanning rather than a CSS selector: a label may carry
  // interpolated JSON, whose quotes and braces are not selector-safe.
  const row = (label: string) =>
    (Array.from(container.querySelectorAll('[data-row]')).find((node) => node.getAttribute('data-row') === label) ??
      null) as HTMLButtonElement | null;
  return { container, onSelectOverflowAction, row };
}

describe('CreateDrawerHeader overflow menu', () => {
  it('labels the anchor, which is the only text a glyph trigger has', () => {
    const { container } = renderHeader();
    expect(container.querySelector('[data-node="overflow"]')?.getAttribute('data-label')).toBe(
      'mobile.create.routeMenu.open',
    );
  });

  it('fires Make it a route from a boulder', () => {
    const { onSelectOverflowAction, row } = renderHeader();
    row('mobile.create.routeMenu.makeRoute')?.click();
    expect(onSelectOverflowAction).toHaveBeenCalledWith('makeRoute');
  });

  it('resolves a tap through the rows the CURRENT state rendered', () => {
    // A boulder's first row is Make it a route; a route's is Make it a boulder.
    // Resolving by position against a stale row set would fire the wrong one.
    const { onSelectOverflowAction, row } = renderHeader({ routeMode: true, frameCount: 4 });

    expect(row('mobile.create.routeMenu.makeRoute')).toBeNull();

    row('mobile.create.actions.newClimb')?.click();
    expect(onSelectOverflowAction).toHaveBeenLastCalledWith('newClimb');
  });

  it('marks the blocked route-to-boulder row disabled rather than dropping it', () => {
    const { row } = renderHeader({ routeMode: true, frameCount: 4 });
    expect(row('mobile.create.routeMenu.makeBoulderBlocked')?.getAttribute('data-disabled')).toBe('true');
  });

  it('offers no route rows on a board that can only hold one frame', () => {
    const { row } = renderHeader({ supportsMultiFrame: false });
    expect(row('mobile.create.routeMenu.makeRoute')).toBeNull();
    expect(row('mobile.create.actions.newClimb')).not.toBeNull();
  });
});
