// @vitest-environment jsdom
// Preserve native picker actions while isolating press animation internals.
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  return { PressableSurface: Pressable };
});
import { createElement, type ReactNode } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const device = vi.hoisted(() => ({ isPad: true, widthClass: 'regular' }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (colors: { light: string }) => colors.light,
  useWindowDimensions: () => ({ height: 900 }),
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress, disabled }: { children?: ReactNode; onPress?: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: onPress, disabled }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 2: 8, 3: 12, 4: 16 },
  borderRadius: { md: 8 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../hooks/use-device-layout', () => ({ useDeviceLayout: () => device }));
vi.mock('../../../hooks/use-board-angle-options', () => ({ useBoardAngleOptions: () => [30, 40] }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#000', fill: '#eee' } }),
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: { boardType: 'kilter', layoutId: 1, angle: 40, isAngleAdjustable: true } }),
}));
vi.mock('../../../lib/boards/use-set-board-angle', () => ({ useSetBoardAngle: () => vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn(), hapticSelection: vi.fn() }));
vi.mock('../../../lib/hold-color-overrides', () => ({
  useHoldColorOverrides: () => ({ shapes: {}, overrides: {}, brushThickness: 1, shapeSize: 1 }),
  getEffectiveHoldStateShape: () => 'circle',
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../board-renderer/HoldMarkerShape', () => ({ HoldMarkerShapeSvg: () => null }));
vi.mock('../../create-climb/brush-roles', () => ({
  getPaintRoles: () => ['STARTING', 'HAND'],
  useBrushRoleLabels: () => ({ STARTING: 'Start', HAND: 'Hand' }),
  brushRoleColor: () => '#000',
}));
vi.mock('../../chrome/GlassActionToolbar', () => ({
  GlassToolbarAction: ({ children, onPress }: { children?: ReactNode; onPress: () => void }) =>
    createElement('button', { onClick: onPress, 'data-testid': 'angle-trigger' }, children),
}));
vi.mock('../../play-drawer/AngleBoardDiagram', () => ({ AngleBoardDiagram: () => null }));
vi.mock('../../play-drawer/AngleSlider', () => ({ AngleSlider: () => null }));
vi.mock('../../SheetTopBar', () => ({ SheetTopBar: () => null }));
vi.mock('../../Sheet', () => ({
  Sheet: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-testid': 'hold-sheet' }, children),
}));
vi.mock('@expo/ui/community/bottom-sheet', () => ({ default: () => null }));
vi.mock('../../play-drawer/AngleSelectorSheet', () => ({
  AngleSelectorSheet: ({ visible }: { visible: boolean }) =>
    createElement('div', { 'data-testid': 'angle-sheet', 'data-visible': String(visible) }),
}));
vi.mock('../AnchoredPopover', () => ({
  AnchoredPopover: ({ trigger, visible, onClose }: { trigger: ReactNode; visible: boolean; onClose: () => void }) =>
    createElement(
      'section',
      { 'data-testid': 'angle-popover', 'data-visible': String(visible) },
      trigger,
      createElement('button', { onClick: onClose }, 'Close angle'),
    ),
}));
vi.mock('../PointAnchoredPopover', () => ({
  PointAnchoredPopover: ({ content, visible, point }: { content: ReactNode; visible: boolean; point: unknown }) =>
    createElement(
      'section',
      { 'data-testid': 'hold-popover', 'data-visible': String(visible), 'data-point': JSON.stringify(point) },
      content,
    ),
}));
import { AngleToolbarAction } from '../../chrome/AngleToolbarAction';
import { HoldRoleSheet } from '../../create-climb/HoldRoleSheet';
beforeEach(() => {
  device.widthClass = 'regular';
});
afterEach(cleanup);

it('keeps an open Angle popover through resize and close, using a sheet next open', () => {
  const result = render(<AngleToolbarAction />);
  fireEvent.click(result.getByTestId('angle-trigger'));
  const host = result.getByTestId('angle-popover');
  expect(host.getAttribute('data-visible')).toBe('true');
  device.widthClass = 'compact';
  result.rerender(<AngleToolbarAction />);
  expect(result.getByTestId('angle-popover')).toBe(host);
  expect(result.queryByTestId('angle-sheet')).toBeNull();
  fireEvent.click(result.getByText('Close angle'));
  expect(result.getByTestId('angle-popover')).toBe(host);
  expect(host.getAttribute('data-visible')).toBe('false');
  fireEvent.click(result.getByTestId('angle-trigger'));
  expect(result.queryByTestId('angle-popover')).toBeNull();
  expect(result.getByTestId('angle-sheet').getAttribute('data-visible')).toBe('true');
});

it('keeps the hold popover and source point through close, preserving role caps', () => {
  const onSelectRole = vi.fn();
  const props = {
    boardName: 'kilter' as const,
    litUpHoldsMap: {},
    startingCount: 2,
    finishCount: 0,
    onSelectRole,
    onClose: vi.fn(),
  };
  const result = render(<HoldRoleSheet {...props} holdId={7} anchorPoint={{ x: 180, y: 260 }} />);
  const host = result.getByTestId('hold-popover');
  fireEvent.click(result.getByText('Start'));
  expect(onSelectRole).not.toHaveBeenCalled();
  fireEvent.click(result.getByText('Hand'));
  expect(onSelectRole).toHaveBeenCalledExactlyOnceWith(7, 'HAND');
  device.widthClass = 'compact';
  result.rerender(<HoldRoleSheet {...props} holdId={null} anchorPoint={null} />);
  expect(result.getByTestId('hold-popover')).toBe(host);
  expect(host.getAttribute('data-visible')).toBe('false');
  expect(host.getAttribute('data-point')).toBe('{"x":180,"y":260}');
  expect(result.queryByTestId('hold-sheet')).toBeNull();
  result.rerender(<HoldRoleSheet {...props} holdId={9} anchorPoint={{ x: 40, y: 80 }} />);
  expect(result.queryByTestId('hold-popover')).toBeNull();
  expect(result.getByTestId('hold-sheet')).toBeTruthy();
});
