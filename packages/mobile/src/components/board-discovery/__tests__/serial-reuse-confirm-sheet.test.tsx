// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

// react-native isn't satisfiable under jsdom; stub the host surface the sheet
// touches onto DOM elements so the interaction assertions can drive it.
vi.mock('react-native', () => ({
  Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) =>
    visible ? createElement('div', { 'data-testid': 'modal' }, children) : null,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('div', { onClick: onPress }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryBackground: '#111', secondaryLabel: '#888', tertiaryLabel: '#666', separator: '#333' },
  }),
}));

vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemOrange: '#FF9500' } }));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) => {
      if (key === 'boardForm.serialReuse.dialogBody') {
        return `Serial ${vars?.serial} is registered to ${vars?.name}`;
      }
      if (key === 'boardForm.serialReuse.dialogTitle') return 'This wall is already on Boardsesh';
      if (key === 'boardForm.serialReuse.useExisting') return 'Use the existing board';
      if (key === 'boardForm.serialReuse.createAnyway') return 'Create a duplicate anyway';
      return key;
    },
  }),
}));

import { SerialReuseConfirmSheet } from '../SerialReuseConfirmSheet';

const existingBoard = {
  uuid: 'canonical-1',
  name: 'The Crag Wall',
  gymName: 'Boulder Gym',
  locationName: null,
  ownerDisplayName: 'Alex',
} as unknown as UserBoard;

describe('SerialReuseConfirmSheet', () => {
  it('renders the existing board with the interpolated serial + name', () => {
    const { getByText, queryByTestId } = render(
      <SerialReuseConfirmSheet
        visible
        board={existingBoard}
        serialNumber="ABC-123"
        onUseExisting={vi.fn()}
        onCreateAnyway={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(queryByTestId('modal')).not.toBeNull();
    expect(getByText('Serial ABC-123 is registered to The Crag Wall')).toBeTruthy();
    expect(getByText('The Crag Wall')).toBeTruthy();
    expect(getByText('Boulder Gym')).toBeTruthy();
    expect(getByText('Alex')).toBeTruthy();
  });

  it('renders nothing when not visible', () => {
    const { queryByTestId } = render(
      <SerialReuseConfirmSheet
        visible={false}
        board={existingBoard}
        serialNumber="ABC-123"
        onUseExisting={vi.fn()}
        onCreateAnyway={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(queryByTestId('modal')).toBeNull();
  });

  it('fires onUseExisting from the primary action', () => {
    const onUseExisting = vi.fn();
    const { getByText } = render(
      <SerialReuseConfirmSheet
        visible
        board={existingBoard}
        serialNumber="ABC-123"
        onUseExisting={onUseExisting}
        onCreateAnyway={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(getByText('Use the existing board'));
    expect(onUseExisting).toHaveBeenCalledTimes(1);
  });

  it('fires onCreateAnyway from the secondary action', () => {
    const onCreateAnyway = vi.fn();
    const { getByText } = render(
      <SerialReuseConfirmSheet
        visible
        board={existingBoard}
        serialNumber="ABC-123"
        onUseExisting={vi.fn()}
        onCreateAnyway={onCreateAnyway}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(getByText('Create a duplicate anyway'));
    expect(onCreateAnyway).toHaveBeenCalledTimes(1);
  });
});
