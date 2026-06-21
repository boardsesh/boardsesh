// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Minimal RN surface. View forwards accessibilityViewIsModal onto a data
// attribute so the scrim's modal-focus trap (keeps the blocked queue/tick/BLE
// controls out of the a11y tree) is inspectable.
type ViewMockProps = { children?: ReactNode; accessibilityViewIsModal?: boolean };
vi.mock('react-native', () => ({
  View: ({ children, accessibilityViewIsModal }: ViewMockProps) =>
    createElement(
      'div',
      {
        'data-modal': accessibilityViewIsModal == null ? undefined : String(accessibilityViewIsModal),
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
vi.mock('../../../theme/colors', () => ({ withAlpha: (color: string) => color }));
vi.mock('../../../theme/tokens', () => ({
  overlays: { scrim: '#0008', onScrim: '#FFFFFF' },
  borderRadius: { lg: 16 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20 },
}));

import { SwitchBoardOverlay } from '../SwitchBoardOverlay';

describe('SwitchBoardOverlay', () => {
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
