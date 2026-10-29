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

import { BleControlSheet } from '../BleControlSheet';

it('keeps expanded accessibility labels in a bounded scrollable sheet, with working controls', () => {
  const onDisconnect = vi.fn();
  const onClose = vi.fn();
  const onToggleLightOnSwipe = vi.fn();
  const { container, getByText } = render(
    <BleControlSheet
      visible
      onReassert={vi.fn()}
      onClearLights={vi.fn()}
      onDisconnect={onDisconnect}
      autoDisconnectEnabled={false}
      autoDisconnectTimeoutLabel="30 seconds"
      onToggleAutoDisconnect={vi.fn()}
      showLightAdjacentHolds
      lightAdjacentHoldsEnabled={false}
      onToggleLightAdjacentHolds={vi.fn()}
      lightOnSwipe={false}
      onToggleLightOnSwipe={onToggleLightOnSwipe}
      lightOnClimbTap={false}
      onToggleLightOnClimbTap={vi.fn()}
      onClose={onClose}
    />,
  );
  expect(container.querySelector('section')?.dataset).toMatchObject({
    scrollable: 'true',
    detents: '["90%"]',
    dynamic: 'false',
  });
  fireEvent.click(getByText('ble.lighting.onSwipeLabel'.repeat(3)));
  expect(onToggleLightOnSwipe).toHaveBeenCalledWith(true);
  fireEvent.click(getByText('lightControl.disconnect'.repeat(3)));
  expect(onDisconnect).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

// #7000: the player's sheet is just the board's actions (and the
// MoonBoard-only switch, which lives nowhere else).
it('drops auto-disconnect and the two lighting switches when asked, keeping the actions', () => {
  const { queryByText, getByText } = render(
    <BleControlSheet
      visible
      onReassert={vi.fn()}
      onClearLights={vi.fn()}
      onDisconnect={vi.fn()}
      autoDisconnectEnabled={false}
      autoDisconnectTimeoutLabel="30 seconds"
      onToggleAutoDisconnect={vi.fn()}
      showLightAdjacentHolds
      lightAdjacentHoldsEnabled={false}
      onToggleLightAdjacentHolds={vi.fn()}
      lightOnSwipe={false}
      onToggleLightOnSwipe={vi.fn()}
      lightOnClimbTap={false}
      onToggleLightOnClimbTap={vi.fn()}
      showLightingSwitches={false}
      onClose={vi.fn()}
    />,
  );
  expect(queryByText('ble.autoDisconnect.toggleTitle'.repeat(3))).toBeNull();
  expect(queryByText('ble.lighting.onTapLabel'.repeat(3))).toBeNull();
  expect(queryByText('ble.lighting.onSwipeLabel'.repeat(3))).toBeNull();
  getByText('lightControl.lightAdjacentHolds'.repeat(3));
  getByText('ble.relightBoard'.repeat(3));
  getByText('lightControl.turnOffAll'.repeat(3));
  getByText('lightControl.disconnect'.repeat(3));
});
