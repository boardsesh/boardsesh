// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

// The bottom padding a style asks for, from a single object or an array of layers.
function readPaddingBottom(style: unknown): number | undefined {
  const layers = Array.isArray(style) ? style : [style];
  let paddingBottom: number | undefined;
  for (const layer of layers) {
    if (layer && typeof layer === 'object' && 'paddingBottom' in layer) {
      paddingBottom = (layer as { paddingBottom?: number }).paddingBottom;
    }
  }
  return paddingBottom;
}

// react-native isn't satisfiable under jsdom; stub the host surface the sheet
// touches onto DOM elements so the interaction assertions can drive it.
vi.mock('react-native', () => ({
  Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) =>
    visible ? createElement('div', { 'data-testid': 'modal' }, children) : null,
  View: ({
    children,
    style,
    accessibilityViewIsModal,
  }: {
    children?: ReactNode;
    style?: unknown;
    accessibilityViewIsModal?: boolean;
  }) =>
    createElement(
      'div',
      { 'data-pb': String(readPaddingBottom(style) ?? ''), 'data-modal': String(!!accessibilityViewIsModal) },
      children,
    ),
  Pressable: ({
    children,
    onPress,
    accessible,
    importantForAccessibility,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessible?: boolean;
    importantForAccessibility?: string;
  }) =>
    createElement(
      'div',
      {
        onClick: onPress,
        'data-backdrop': accessible === false && importantForAccessibility === 'no' ? 'true' : undefined,
      },
      children,
    ),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} },
  Platform: { OS: 'ios' },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryBackground: '#111', secondaryLabel: '#888', tertiaryLabel: '#666', separator: '#333' },
  }),
}));

// A gesture-nav phone: the card must clear the home indicator.
vi.mock('../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 34 }));

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

  it('clears the window bottom inset under its buttons', () => {
    const { container } = render(
      <SerialReuseConfirmSheet
        visible
        board={existingBoard}
        serialNumber="SN-1"
        onUseExisting={vi.fn()}
        onCreateAnyway={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // 34 for the home indicator plus spacing[4].
    expect(container.querySelector('[data-pb="50"]')).not.toBeNull();
  });

  it('keeps the backdrop a hidden sibling of a modal card so VoiceOver reaches the buttons', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <SerialReuseConfirmSheet
        visible
        board={existingBoard}
        serialNumber="ABC123"
        onUseExisting={() => {}}
        onCreateAnyway={() => {}}
        onCancel={onCancel}
      />,
    );
    const backdrop = container.querySelector('[data-backdrop="true"]') as HTMLElement;
    const card = container.querySelector('[data-modal="true"]') as HTMLElement;
    expect(backdrop).not.toBeNull();
    expect(card).not.toBeNull();
    // The card is not inside the tappable backdrop, so its buttons stay reachable.
    expect(backdrop.contains(card)).toBe(false);
    fireEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
