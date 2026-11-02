// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode, type Ref } from 'react';

// Capture each ListRow's title + onPress so we can fire the matching row.
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  // A raw RN Switch renders system green on iOS; the sheet must not use one.
  Switch: () => {
    throw new Error('BleControlSheet must use SwitchRow, not a raw RN Switch');
  },
  StyleSheet: { create: (styles: unknown) => styles },
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({ default: function BottomSheet() {} }));

vi.mock('../ModalSheet', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    ModalSheet: React.forwardRef(({ children }: { children?: ReactNode }, ref: Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({ present: vi.fn(), dismiss: vi.fn() }));
      return React.createElement('div', { 'data-sheet': 'true' }, children);
    }),
  };
});

vi.mock('../ListRow', () => ({
  ListRow: ({ title, onPress, leading }: { title: string; onPress: () => void; leading?: ReactNode }) =>
    createElement('button', { 'data-title': title, onClick: onPress }, leading, title),
}));

// The app's native SwitchRow (brand-tinted SwiftUI Toggle / Compose Switch).
vi.mock('../SwitchRow', () => ({
  SwitchRow: ({
    label,
    value,
    onValueChange,
  }: {
    label: string;
    value: boolean;
    onValueChange: (next: boolean) => void;
  }) =>
    createElement(
      'button',
      { 'data-switch-row': label, 'aria-checked': value, onClick: () => onValueChange(!value) },
      label,
    ),
}));
vi.mock('../Separator', () => ({ Separator: () => null }));

vi.mock('../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { warning: '#f80' },
    systemColors: { secondaryLabel: '#888', error: 'theme-error' },
  }),
}));
vi.mock('../../theme/tokens', () => ({ spacing: { 2: 8 } }));

import { BleControlSheet } from '../ble/BleControlSheet';

const baseProps = {
  visible: true,
  onReassert: vi.fn(),
  onClearLights: vi.fn(),
  onDisconnect: vi.fn(),
  disconnectWhenDrivingEnds: false,
  onToggleDisconnectWhenDrivingEnds: vi.fn(),
  showLightAdjacentHolds: false,
  lightAdjacentHoldsEnabled: false,
  onToggleLightAdjacentHolds: vi.fn(),
  alwaysDrive: true,
  onToggleAlwaysDrive: vi.fn(),
  onClose: vi.fn(),
};

beforeEach(() => {
  baseProps.onReassert.mockClear();
  baseProps.onClearLights.mockClear();
  baseProps.onDisconnect.mockClear();
  baseProps.onToggleDisconnectWhenDrivingEnds.mockClear();
  baseProps.onToggleLightAdjacentHolds.mockClear();
  baseProps.onToggleAlwaysDrive.mockClear();
  baseProps.onClose.mockClear();
});

describe('BleControlSheet', () => {
  it('renders every toggle through the native SwitchRow', () => {
    const { container } = render(<BleControlSheet {...baseProps} showLightAdjacentHolds />);
    const rows = Array.from(container.querySelectorAll('[data-switch-row]')).map((row) =>
      row.getAttribute('data-switch-row'),
    );
    expect(rows).toEqual([
      'ble.lighting.drivingEnds.label',
      'lightControl.lightAdjacentHolds',
      // One switch, as on Settings › Board.
      'ble.lighting.alwaysDriveLabel',
    ]);
  });

  it('paints the disconnect glyph with the theme error colour, not a static red', () => {
    const { container } = render(<BleControlSheet {...baseProps} />);
    expect(container.querySelector('[data-icon="bluetooth.off"]')?.getAttribute('data-color')).toBe('theme-error');
  });

  it('renders re-light, turn-off-all-lights, and disconnect rows', () => {
    const { getByText } = render(<BleControlSheet {...baseProps} />);
    expect(getByText('ble.relightBoard')).toBeDefined();
    expect(getByText('lightControl.turnOffAll')).toBeDefined();
    expect(getByText('lightControl.disconnect')).toBeDefined();
  });

  it('re-light row reasserts the wall and closes', () => {
    const { getByText } = render(<BleControlSheet {...baseProps} />);
    fireEvent.click(getByText('ble.relightBoard'));
    expect(baseProps.onReassert).toHaveBeenCalledTimes(1);
    expect(baseProps.onClearLights).not.toHaveBeenCalled();
    expect(baseProps.onDisconnect).not.toHaveBeenCalled();
    expect(baseProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('turn-off row clears the lights and closes (without disconnecting)', () => {
    const { getByText } = render(<BleControlSheet {...baseProps} />);
    fireEvent.click(getByText('lightControl.turnOffAll'));
    expect(baseProps.onClearLights).toHaveBeenCalledTimes(1);
    expect(baseProps.onDisconnect).not.toHaveBeenCalled();
    expect(baseProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('disconnect row drops the connection and closes', () => {
    const { getByText } = render(<BleControlSheet {...baseProps} />);
    fireEvent.click(getByText('lightControl.disconnect'));
    expect(baseProps.onDisconnect).toHaveBeenCalledTimes(1);
    expect(baseProps.onClearLights).not.toHaveBeenCalled();
    expect(baseProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('toggles Disconnect Bluetooth when driving ends once from the long-press row', () => {
    const { getByText } = render(<BleControlSheet {...baseProps} />);
    fireEvent.click(getByText('ble.lighting.drivingEnds.label'));
    expect(baseProps.onToggleDisconnectWhenDrivingEnds).toHaveBeenCalledTimes(1);
    expect(baseProps.onToggleDisconnectWhenDrivingEnds).toHaveBeenCalledWith(true);
  });

  it('leaves Disconnect Bluetooth when driving ends and Always drive the wall to Settings on the player sheet', () => {
    const { queryByText } = render(<BleControlSheet {...baseProps} showLightingSwitches={false} />);
    expect(queryByText('ble.lighting.drivingEnds.label')).toBeNull();
    expect(queryByText('ble.lighting.alwaysDriveLabel')).toBeNull();
  });

  it('renders Always drive the wall, and the two retired switches are gone', () => {
    const { getByText, queryByText } = render(<BleControlSheet {...baseProps} />);
    expect(getByText('ble.lighting.alwaysDriveLabel')).toBeDefined();
    expect(queryByText('ble.lighting.onSwipeLabel')).toBeNull();
    expect(queryByText('ble.lighting.onTapLabel')).toBeNull();

    fireEvent.click(getByText('ble.lighting.alwaysDriveLabel'));
    expect(baseProps.onToggleAlwaysDrive).toHaveBeenCalledTimes(1);
    expect(baseProps.onToggleAlwaysDrive).toHaveBeenCalledWith(false);
  });

  it('always renders the turn-off row (every board now has a clear-all, incl. MoonBoard)', () => {
    // MoonBoard clears via its `l##` empty frame (#3420), so the row is no longer
    // board-gated — it shows on every connected board.
    const { getByText } = render(<BleControlSheet {...baseProps} />);
    expect(getByText('lightControl.turnOffAll')).toBeDefined();
  });

  it('hides the light-adjacent-holds row for a non-MoonBoard', () => {
    const { queryByText } = render(<BleControlSheet {...baseProps} showLightAdjacentHolds={false} />);
    expect(queryByText('lightControl.lightAdjacentHolds')).toBeNull();
  });

  it('toggles light-adjacent-holds once from the row on a MoonBoard', () => {
    const { getByText } = render(
      <BleControlSheet {...baseProps} showLightAdjacentHolds lightAdjacentHoldsEnabled={false} />,
    );
    fireEvent.click(getByText('lightControl.lightAdjacentHolds'));
    expect(baseProps.onToggleLightAdjacentHolds).toHaveBeenCalledTimes(1);
    expect(baseProps.onToggleLightAdjacentHolds).toHaveBeenCalledWith(true);
  });
});
