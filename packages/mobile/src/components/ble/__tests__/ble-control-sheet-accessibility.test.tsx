// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key.repeat(3) }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { warning: 'warning' }, systemColors: { secondaryLabel: 'label', error: 'error' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8 } }));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({
    children,
    scrollable,
    snapPoints,
    enableDynamicSizing,
  }: {
    children?: ReactNode;
    scrollable?: boolean;
    snapPoints?: string[];
    enableDynamicSizing?: boolean;
  }) =>
    createElement(
      'section',
      {
        'data-scrollable': String(scrollable),
        'data-detents': JSON.stringify(snapPoints),
        'data-dynamic': String(Boolean(enableDynamicSizing)),
      },
      children,
    ),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Separator', () => ({ Separator: () => null }));
vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({
    label,
    value,
    onValueChange,
  }: {
    label: string;
    value: boolean;
    onValueChange: (enabled: boolean) => void;
  }) => createElement('button', { onClick: () => onValueChange(!value) }, label),
}));
vi.mock('../../ListRow', () => ({
  ListRow: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));

vi.mock('../BleKeepLightingRow', () => ({
  BleKeepLightingRow: ({ model }: { model: { label: string } }) => createElement('button', null, model.label),
}));

import { BleControlSheet } from '../BleControlSheet';

it('keeps expanded accessibility labels in a bounded scrollable sheet, with working controls', () => {
  const onDisconnect = vi.fn();
  const onClose = vi.fn();
  const onToggleAlwaysDrive = vi.fn();
  const { container, getByText } = render(
    <BleControlSheet
      visible
      onReassert={vi.fn()}
      onClearLights={vi.fn()}
      onDisconnect={onDisconnect}
      disconnectWhenDrivingEnds={false}
      onToggleDisconnectWhenDrivingEnds={vi.fn()}
      showLightAdjacentHolds
      lightAdjacentHoldsEnabled={false}
      onToggleLightAdjacentHolds={vi.fn()}
      alwaysDrive={false}
      onToggleAlwaysDrive={onToggleAlwaysDrive}
      onClose={onClose}
    />,
  );
  expect(container.querySelector('section')?.dataset).toMatchObject({
    scrollable: 'true',
    detents: '["90%"]',
    dynamic: 'false',
  });
  fireEvent.click(getByText('ble.lighting.alwaysDriveLabel'.repeat(3)));
  expect(onToggleAlwaysDrive).toHaveBeenCalledWith(true);
  fireEvent.click(getByText('lightControl.disconnect'.repeat(3)));
  expect(onDisconnect).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

// #7000: the player's sheet is just the board's actions (and the
// MoonBoard-only switch, which lives nowhere else).
it('drops auto-disconnect and Always drive the wall when asked, keeping the actions', () => {
  const { queryByText, getByText } = render(
    <BleControlSheet
      visible
      onReassert={vi.fn()}
      onClearLights={vi.fn()}
      onDisconnect={vi.fn()}
      disconnectWhenDrivingEnds={false}
      onToggleDisconnectWhenDrivingEnds={vi.fn()}
      showLightAdjacentHolds
      lightAdjacentHoldsEnabled={false}
      onToggleLightAdjacentHolds={vi.fn()}
      alwaysDrive={false}
      onToggleAlwaysDrive={vi.fn()}
      showLightingSwitches={false}
      onClose={vi.fn()}
    />,
  );
  expect(queryByText('ble.lighting.drivingEnds.label'.repeat(3))).toBeNull();
  expect(queryByText('ble.lighting.alwaysDriveLabel'.repeat(3))).toBeNull();
  getByText('lightControl.lightAdjacentHolds'.repeat(3));
  getByText('ble.relightBoard'.repeat(3));
  getByText('lightControl.turnOffAll'.repeat(3));
  getByText('lightControl.disconnect'.repeat(3));
});

// #7113: Light every climb, the wall button's swipe as a row. With no link the
// board's own actions would no-op, so it stands alone.
it.each([
  ['linked', true, ['playView.wallControl.lightEveryClimb', 'ble.relightBoard', 'lightControl.disconnect']],
  ['with no link', false, ['playView.wallControl.lightEveryClimb']],
] as const)('offers Light every climb %s', (_case, linked, rows) => {
  const onDrive = vi.fn();
  const onClose = vi.fn();
  const { getByText, queryByText } = render(
    <BleControlSheet
      visible
      onReassert={vi.fn()}
      onClearLights={vi.fn()}
      onDisconnect={vi.fn()}
      disconnectWhenDrivingEnds={false}
      onToggleDisconnectWhenDrivingEnds={vi.fn()}
      showLightAdjacentHolds={false}
      lightAdjacentHoldsEnabled={false}
      onToggleLightAdjacentHolds={vi.fn()}
      alwaysDrive={false}
      onToggleAlwaysDrive={vi.fn()}
      showLightingSwitches={false}
      linked={linked}
      onDrive={onDrive}
      onClose={onClose}
    />,
  );
  for (const row of rows) getByText(row.repeat(3));
  if (!linked) expect(queryByText('ble.relightBoard'.repeat(3))).toBeNull();
  fireEvent.click(getByText('playView.wallControl.lightEveryClimb'.repeat(3)));
  expect(onDrive).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

// 2.7: the player's status line, then Keep lighting after Put on board, lead
// the sheet, above the board's actions.
it('leads with the status line and the keep-lighting row', () => {
  const { container } = render(
    <BleControlSheet
      visible
      onReassert={vi.fn()}
      onClearLights={vi.fn()}
      onDisconnect={vi.fn()}
      disconnectWhenDrivingEnds={false}
      onToggleDisconnectWhenDrivingEnds={vi.fn()}
      showLightAdjacentHolds={false}
      lightAdjacentHoldsEnabled={false}
      onToggleLightAdjacentHolds={vi.fn()}
      alwaysDrive={false}
      onToggleAlwaysDrive={vi.fn()}
      showLightingSwitches={false}
      status={<span>On the wall</span>}
      keepLighting={{ label: 'Keep lighting after Put on board', choice: '45', options: [], onChange: vi.fn() }}
      onClose={vi.fn()}
    />,
  );
  const texts = Array.from(container.querySelectorAll('span, button')).map((node) => node.textContent);
  expect(texts.slice(0, 3)).toEqual(['On the wall', 'Keep lighting after Put on board', 'ble.relightBoard'.repeat(3)]);
});
