// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Minimal RN surface. View forwards accessibilityViewIsModal onto a data
// attribute so the scrim's modal-focus trap (keeps the blocked queue/tick/BLE
// controls out of the a11y tree) is inspectable.
type ViewMockProps = { children?: ReactNode; accessibilityViewIsModal?: boolean; testID?: string; style?: unknown };
vi.mock('react-native', () => ({
  View: ({ children, accessibilityViewIsModal, testID, style }: ViewMockProps) =>
    createElement(
      'div',
      {
        'data-modal': accessibilityViewIsModal == null ? undefined : String(accessibilityViewIsModal),
        'data-testid': testID,
        'data-bg': (Array.isArray(style) ? Object.assign({}, ...style) : (style ?? {})).backgroundColor,
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

// t echoes the key, appending the interpolated board so the title/subtitle copy
// is asserted to actually thread boardLabel through.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { board?: string }) => (options?.board ? `${key}:${options.board}` : key),
  }),
}));

// Icon → expose name so the lock glyph is present. Paths are relative to THIS
// test file (one level under the source in __tests__), so they carry an extra
// `../`.
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name?: string }) => createElement('span', { 'data-icon': name }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
// Real <button> so onPress is exercisable; the real Button drags in
// react-native-paper + haptics, which jsdom can't host.
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title?: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../drawer-action-bar/DrawerActionBar', () => ({
  ActionButton: ({
    iconName,
    onPress,
    accessibilityLabel,
  }: {
    iconName?: string;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'data-icon': iconName, 'aria-label': accessibilityLabel }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { elevatedSurface: '#221A32', label: '#F5F2FB', secondaryLabel: '#A9A2B6' } }),
}));
vi.mock('../../../theme/tokens', () => ({
  overlays: { scrim: '#0008', onScrim: '#FFFFFF' },
  borderRadius: { lg: 16 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20 },
}));

import { SwitchBoardOverlay } from '../SwitchBoardOverlay';

describe('SwitchBoardOverlay', () => {
  // HIG Materials: the message card is content, so it is opaque. It used to be a
  // glass card inside the glass player, which stacked glass on glass.
  it('draws the message on an opaque card, not glass', () => {
    const { getByTestId } = render(createElement(SwitchBoardOverlay, { boardLabel: 'Kilter', onSwitchBoard: vi.fn() }));

    expect(getByTestId('switch-board-card').getAttribute('data-bg')).toBe('#221A32');
  });

  it('interpolates boardLabel into the mismatch title and subtitle copy', () => {
    const { container } = render(createElement(SwitchBoardOverlay, { boardLabel: 'Kilter', onSwitchBoard: vi.fn() }));

    expect(container.textContent).toContain('boardMismatch.title:Kilter');
    expect(container.textContent).toContain('boardMismatch.subtitle:Kilter');
  });

  it('traps a11y focus on the scrim via accessibilityViewIsModal', () => {
    const { container } = render(createElement(SwitchBoardOverlay, { boardLabel: 'Tension', onSwitchBoard: vi.fn() }));

    expect(container.querySelector('[data-modal="true"]')).toBeTruthy();
  });

  it('switches boards once when the CTA is pressed', () => {
    const onSwitchBoard = vi.fn();
    const { container } = render(createElement(SwitchBoardOverlay, { boardLabel: 'Kilter', onSwitchBoard }));
    const cta = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'boardMismatch.cta',
    ) as HTMLButtonElement;

    expect(cta).toBeTruthy();
    cta.click();

    expect(onSwitchBoard).toHaveBeenCalledTimes(1);
  });
});

// The same fact — this climb is on another board — told as an invitation when
// that board is across the room rather than across the country.

// A climb on a board at THIS gym gets no overlay at all — it renders on its own
// board with every control live. Only a board somewhere else raises the scrim.
describe('SwitchBoardOverlay presentation', () => {
  it('puts the message on a card rather than straight on the scrim', () => {
    const { container, getByTestId } = render(
      createElement(SwitchBoardOverlay, { boardLabel: 'Woods', onSwitchBoard: vi.fn() }),
    );

    // The scrim alone is a 60% fill, so the controls it covers read right
    // through words laid directly on it. The card is what makes them recede.
    expect(getByTestId('switch-board-card').textContent).toContain('boardMismatch.title:Woods');
    expect(container.querySelector('[data-modal="true"]')).toBeTruthy();
  });
});
