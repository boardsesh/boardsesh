// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  ActivityIndicator: () => createElement('span', { 'data-busy': 'true' }),
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('../ModalSheet', () => ({
  ModalSheet: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-sheet': 'true' }, children),
}));
vi.mock('../ListRow', () => ({
  ListRow: ({ title, subtitle, onPress }: { title: string; subtitle?: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, subtitle ? `${title}:${subtitle}` : title),
}));
vi.mock('../Icon', () => ({ Icon: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../theme/ios-colors', () => ({ iosSystemColors: { systemRed: '#f00' } }));
vi.mock('../../theme/tokens', () => ({ spacing: { 2: 8 } }));

import { QuantumBleControlSheet, type QuantumLayerControlRow } from '../ble/QuantumBleControlSheet';

const rows: QuantumLayerControlRow[] = [
  { slot: 0, colorKey: 'green', colorHex: '#00FF00', action: { kind: 'light' } },
  {
    slot: 1,
    colorKey: 'cyan',
    colorHex: '#00FFFF',
    action: { kind: 'remove', activeRouteUuid: '20000000-0000-4000-8000-000000000001' },
  },
  {
    slot: 2,
    colorKey: 'magenta',
    colorHex: '#FF00FF',
    action: { kind: 'unavailable', reason: 'color-in-use' },
  },
];

const props = {
  visible: true,
  rows,
  targetError: null,
  busySlot: null,
  clearing: false,
  actionFailed: false,
  hasActivePlayers: true,
  onLayerPress: vi.fn(),
  onClearAll: vi.fn(),
  onDisconnect: vi.fn(),
  onClose: vi.fn(),
};

beforeEach(() => {
  props.onLayerPress.mockClear();
  props.onClearAll.mockClear();
  props.onDisconnect.mockClear();
  props.onClose.mockClear();
});

describe('QuantumBleControlSheet', () => {
  it('offers explicit light/remove rows but disables a foreign color', () => {
    const { getByText } = render(<QuantumBleControlSheet {...props} />);

    fireEvent.click(getByText('lightControl.quantum.layerTitle:lightControl.quantum.light'));
    expect(props.onLayerPress).toHaveBeenLastCalledWith(rows[0]);
    fireEvent.click(getByText('lightControl.quantum.layerTitle:lightControl.quantum.remove'));
    expect(props.onLayerPress).toHaveBeenLastCalledWith(rows[1]);
    fireEvent.click(getByText('lightControl.quantum.layerTitle:lightControl.quantum.foreign'));
    expect(props.onLayerPress).toHaveBeenCalledTimes(2);
  });

  it('requires an inline second tap before clearing every controller player', () => {
    const { getByText, queryByText } = render(<QuantumBleControlSheet {...props} />);
    expect(queryByText('lightControl.quantum.clearConfirm')).toBeNull();

    fireEvent.click(getByText('lightControl.quantum.clearStart:lightControl.quantum.clearStartSubtitle'));
    expect(props.onClearAll).not.toHaveBeenCalled();
    expect(getByText('lightControl.quantum.clearQuestion')).toBeDefined();

    fireEvent.click(getByText('lightControl.quantum.clearConfirm'));
    expect(props.onClearAll).toHaveBeenCalledOnce();
  });

  it('disconnects only from the labelled row and closes the sheet', () => {
    const { getByText } = render(<QuantumBleControlSheet {...props} />);
    fireEvent.click(getByText('lightControl.disconnect'));
    expect(props.onDisconnect).toHaveBeenCalledOnce();
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});
