// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode, type Ref } from 'react';

// Capture each ListRow's title + onPress so we can fire the matching row.
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));

vi.mock('@gorhom/bottom-sheet', () => ({ default: function BottomSheet() {} }));

vi.mock('../Sheet', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    Sheet: React.forwardRef(({ children }: { children?: ReactNode }, ref: Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({ snapToIndex: vi.fn(), close: vi.fn() }));
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
  supportsClearLights: true,
  onDisconnect: vi.fn(),
  onClose: vi.fn(),
};

beforeEach(() => {
  baseProps.onReassert.mockClear();
  baseProps.onClearLights.mockClear();
  baseProps.onDisconnect.mockClear();
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

  it('hides the turn-off row when the board cannot encode a clear frame (MoonBoard)', () => {
    const { queryByText, getByText } = render(<BleControlSheet {...baseProps} supportsClearLights={false} />);
    expect(queryByText('lightControl.turnOffAll')).toBeNull();
    // The other controls stay available.
    expect(getByText('ble.relightBoard')).toBeDefined();
    expect(getByText('lightControl.disconnect')).toBeDefined();
  });
});
