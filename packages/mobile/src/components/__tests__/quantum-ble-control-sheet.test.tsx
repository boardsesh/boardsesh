// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
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
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: { error: '#f00' } }) }));
vi.mock('../../theme/tokens', () => ({ spacing: { 2: 8 } }));

import { QuantumBleControlSheet, type QuantumLayerControlRow } from '../ble/QuantumBleControlSheet';

const rows: QuantumLayerControlRow[] = [
  { slot: 0, colorKey: 'green', colorHex: '#00FF00', action: { kind: 'light' } },
  {
    slot: 1,
    colorKey: 'cyan',
    colorHex: '#00FFFF',
    action: { kind: 'active' },
  },
  {
    slot: 2,
    colorKey: 'magenta',
    colorHex: '#FF00FF',
    action: { kind: 'unavailable', reason: 'color-in-use' },
  },
];

const ownedRemoval = {
  controllerUserUuid: '10000000-0000-4000-8000-000000000001',
  controllerRouteUuid: '20000000-0000-4000-8000-000000000001',
  colorKey: 'cyan' as const,
  colorHex: '#00FFFF',
};

const props = {
  visible: true,
  rows,
  targetError: null,
  busyAction: null,
  removals: [ownedRemoval],
  actionFailed: false,
  onLayerPress: vi.fn(),
  onRemove: vi.fn(),
  onDisconnect: vi.fn(),
  onClose: vi.fn(),
};

beforeEach(() => {
  props.onLayerPress.mockClear();
  props.onRemove.mockClear();
  props.onDisconnect.mockClear();
  props.onClose.mockClear();
});

afterEach(cleanup);

describe('QuantumBleControlSheet', () => {
  it('offers explicit light/remove rows but disables a foreign color', () => {
    const { getByText } = render(<QuantumBleControlSheet {...props} />);

    fireEvent.click(getByText('lightControl.quantum.layerTitle:lightControl.quantum.light'));
    expect(props.onLayerPress).toHaveBeenLastCalledWith(rows[0]);
    fireEvent.click(getByText('lightControl.quantum.removeColor'));
    expect(props.onRemove).toHaveBeenLastCalledWith(ownedRemoval);
    fireEvent.click(getByText('lightControl.quantum.layerTitle:lightControl.quantum.foreign'));
    expect(props.onLayerPress).toHaveBeenCalledOnce();
  });

  it.each([{ removals: [] }, { removals: [ownedRemoval] }])('offers no wall-wide action with %j', ({ removals }) => {
    const { queryByText } = render(<QuantumBleControlSheet {...props} removals={removals} />);
    expect(queryByText(/clear|turnOffAll/i)).toBeNull();
    expect(Boolean(queryByText('lightControl.quantum.removeColor'))).toBe(removals.length > 0);
  });

  it('disconnects only from the labelled row and closes the sheet', () => {
    const { getByText } = render(<QuantumBleControlSheet {...props} />);
    fireEvent.click(getByText('lightControl.disconnect'));
    expect(props.onDisconnect).toHaveBeenCalledOnce();
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});
