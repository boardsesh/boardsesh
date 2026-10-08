// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, useImperativeHandle, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardHoldTarget } from '../../../lib/create-board-holds';
const measurements = vi.hoisted(() => ({
  pending: [] as Array<(x: number, y: number, width: number, height: number) => void>,
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 4: 16 } }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: { separator: '#ccc' } }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: { id: number; role: string }) => (args ? `${args.id} ${args.role}` : key),
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    ref,
    onPress,
    onLongPress,
    onAccessibilityAction,
    accessibilityLabel,
  }: {
    children: ReactNode;
    ref: React.Ref<unknown>;
    onPress: () => void;
    onLongPress: () => void;
    onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => void;
    accessibilityLabel: string;
  }) => {
    useImperativeHandle(ref, () => ({
      measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
        measurements.pending.push(callback),
    }));
    return createElement(
      'button',
      {
        'aria-label': accessibilityLabel,
        onClick: onPress,
        onContextMenu: onLongPress,
        onDoubleClick: () => onAccessibilityAction({ nativeEvent: { actionName: 'chooseRole' } }),
      },
      children,
    );
  },
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    keyExtractor,
  }: {
    data: BoardHoldTarget[];
    renderItem: (args: { item: BoardHoldTarget }) => ReactNode;
    keyExtractor: (item: BoardHoldTarget) => string;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'virtual-list' },
      data.map((item) => createElement('div', { key: keyExtractor(item) }, renderItem({ item }))),
    ),
}));
import { AccessibleHoldList } from '../AccessibleHoldList';
afterEach(() => {
  cleanup();
  measurements.pending = [];
});
const holds = [
  { id: 8, cx: 20, cy: 10, r: 4 },
  { id: 2, cx: 10, cy: 10, r: 4 },
];
describe('AccessibleHoldList', () => {
  it('orders geometry, announces roles, and paints the chosen hold', () => {
    const onPaint = vi.fn();
    const { getAllByRole } = render(
      <AccessibleHoldList
        holds={holds}
        roles={{ 2: { state: 'STARTING', color: '#0f0', displayColor: '#0f0' } }}
        onPaint={onPaint}
        onChooseRole={vi.fn()}
      />,
    );
    const rows = getAllByRole('button');
    expect(rows[0].getAttribute('aria-label')).toContain('2 mobile.create.brush.start');
    expect(rows[1].getAttribute('aria-label')).toContain('8 mobile.boardAccessibility.unlit');
    fireEvent.click(rows[1]);
    expect(onPaint).toHaveBeenCalledWith(8);
  });
  it('anchors role actions to the row center and ignores stale measurements', () => {
    const onChooseRole = vi.fn();
    const screen = render(
      <AccessibleHoldList holds={holds} roles={{}} onPaint={vi.fn()} onChooseRole={onChooseRole} />,
    );
    const row = screen.getAllByRole('button')[0];
    fireEvent.contextMenu(row);
    fireEvent.doubleClick(row);
    act(() => measurements.pending[0](10, 20, 100, 48));
    expect(onChooseRole).not.toHaveBeenCalled();
    act(() => measurements.pending[1](10, 20, 100, 48));
    expect(onChooseRole).toHaveBeenCalledWith(2, { x: 60, y: 44 });
    fireEvent.doubleClick(row);
    screen.unmount();
    act(() => measurements.pending[2](10, 20, 100, 48));
    expect(onChooseRole).toHaveBeenCalledTimes(1);
  });
});
