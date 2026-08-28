// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode, type Ref } from 'react';

// Capture each ListRow's title + onPress so we can fire the matching row.
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Switch: () => null,
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
  ListRow: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { 'data-title': title, onClick: onPress }, title),
}));

vi.mock('../Icon', () => ({ Icon: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { warning: '#f80' }, systemColors: { secondaryLabel: '#888' } }),
}));
vi.mock('../../theme/ios-colors', () => ({ iosSystemColors: { systemRed: '#f00' } }));
vi.mock('../../theme/tokens', () => ({ spacing: { 2: 8 } }));

import { BleControlSheet } from '../ble/BleControlSheet';

const baseProps = {
  visible: true,
  onReassert: vi.fn(),
  onClearLights: vi.fn(),
  onDisconnect: vi.fn(),
  autoDisconnectEnabled: false,
  autoDisconnectTimeoutLabel: '30 seconds',
  onToggleAutoDisconnect: vi.fn(),
  showLightAdjacentHolds: false,
  lightAdjacentHoldsEnabled: false,
  onToggleLightAdjacentHolds: vi.fn(),
  lightOnSwipe: true,
  onToggleLightOnSwipe: vi.fn(),
  lightOnClimbTap: true,
  onToggleLightOnClimbTap: vi.fn(),
  onClose: vi.fn(),
};

beforeEach(() => {
  baseProps.onReassert.mockClear();
  baseProps.onClearLights.mockClear();
  baseProps.onDisconnect.mockClear();
  baseProps.onToggleAutoDisconnect.mockClear();
  baseProps.onToggleLightAdjacentHolds.mockClear();
  baseProps.onToggleLightOnSwipe.mockClear();
  baseProps.onToggleLightOnClimbTap.mockClear();
  baseProps.onClose.mockClear();
});

describe('BleControlSheet', () => {
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

  it('toggles auto-disconnect once from the long-press row', () => {
    const { getByText } = render(<BleControlSheet {...baseProps} />);
    fireEvent.click(getByText('ble.autoDisconnect.toggleTitle'));
    expect(baseProps.onToggleAutoDisconnect).toHaveBeenCalledTimes(1);
    expect(baseProps.onToggleAutoDisconnect).toHaveBeenCalledWith(true);
  });

  it('renders the board-lighting rows and toggles each independently', () => {
    const { getByText } = render(<BleControlSheet {...baseProps} />);
    expect(getByText('ble.lighting.onSwipeLabel')).toBeDefined();
    expect(getByText('ble.lighting.onTapLabel')).toBeDefined();

    fireEvent.click(getByText('ble.lighting.onSwipeLabel'));
    expect(baseProps.onToggleLightOnSwipe).toHaveBeenCalledTimes(1);
    expect(baseProps.onToggleLightOnSwipe).toHaveBeenCalledWith(false);
    expect(baseProps.onToggleLightOnClimbTap).not.toHaveBeenCalled();

    fireEvent.click(getByText('ble.lighting.onTapLabel'));
    expect(baseProps.onToggleLightOnClimbTap).toHaveBeenCalledTimes(1);
    expect(baseProps.onToggleLightOnClimbTap).toHaveBeenCalledWith(false);
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
