// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: () => undefined },
  StyleSheet: { create: <Styles,>(styles: Styles) => styles },
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  View: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) =>
    createElement('div', { role: accessibilityRole }, children),
  Pressable: ({
    children,
    accessibilityRole,
    'aria-checked': checked,
    onPress,
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
    'aria-checked'?: boolean;
    onPress?: () => void;
  }) =>
    createElement(
      'button',
      {
        role: accessibilityRole,
        'aria-checked': checked,
        onClick: onPress,
      },
      children,
    ),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { tertiaryBackground: 'white', separator: 'gray' },
    brandColors: { primary: 'purple' },
  }),
}));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../climb-list-settings-model', () => ({ climbRowPresetLabel: (preset: string) => preset }));

import { ClimbRowPresetChips } from '../ClimbRowPresetChips';

afterEach(cleanup);

it('announces exactly one checked preset and updates it after selection', () => {
  const onSelect = vi.fn();
  const { rerender } = render(<ClimbRowPresetChips activePreset="default" hasLastCustom={false} onSelect={onSelect} />);
  expect(screen.getAllByRole('radio').filter((radio) => radio.getAttribute('aria-checked') === 'true')).toHaveLength(1);
  expect(screen.getByRole('radio', { name: 'default' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('radio', { name: 'textOnly' }).getAttribute('aria-checked')).toBe('false');
  fireEvent.click(screen.getByRole('radio', { name: 'textOnly' }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('textOnly');
  rerender(<ClimbRowPresetChips activePreset="textOnly" hasLastCustom={false} onSelect={onSelect} />);
  expect(screen.getByRole('radio', { name: 'default' }).getAttribute('aria-checked')).toBe('false');
  expect(screen.getByRole('radio', { name: 'textOnly' }).getAttribute('aria-checked')).toBe('true');
});

it('announces Custom as checked while preserving the remembered mix option', () => {
  const onSelect = vi.fn();
  const { rerender } = render(<ClimbRowPresetChips activePreset="custom" hasLastCustom={false} onSelect={onSelect} />);
  expect(screen.getByRole('radio', { name: 'custom' }).getAttribute('aria-checked')).toBe('true');
  rerender(<ClimbRowPresetChips activePreset="default" hasLastCustom onSelect={onSelect} />);
  const custom = screen.getByRole('radio', { name: 'custom' });
  expect(custom.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(custom);
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('custom');
});
