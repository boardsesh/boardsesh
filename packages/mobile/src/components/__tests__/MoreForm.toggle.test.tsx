// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MoreFormModel } from '../MoreForm.types';

const rowEvent = vi.hoisted(() => ({ onPress: null as (() => void) | null }));

vi.mock('react-native', () => ({
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-native-paper', () => ({
  Divider: () => null,
  List: {
    Item: ({
      title,
      onPress,
      disabled,
      right,
      'aria-checked': checked,
      'aria-disabled': ariaDisabled,
    }: {
      title: string;
      onPress: () => void;
      disabled?: boolean;
      right: () => ReactNode;
      'aria-checked': boolean;
      'aria-disabled': boolean;
    }) => {
      rowEvent.onPress = onPress;
      return createElement(
        'button',
        { role: 'switch', disabled, onClick: onPress, 'aria-checked': checked, 'aria-disabled': ariaDisabled },
        title,
        right(),
      );
    },
  },
  Surface: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Switch: ({ disabled }: { disabled?: boolean }) =>
    createElement('span', { 'data-testid': 'visual-switch', 'data-disabled': disabled === true }),
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  Menu: () => null,
}));
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 10: 40 } }));
vi.mock('../Button', () => ({ Button: () => null }));
vi.mock('../SegmentedControl', () => ({ SegmentedControl: () => null }));
vi.mock('../settings/MarkerMultiplierSlider', () => ({ MarkerMultiplierSlider: () => null }));

import { MoreForm } from '../MoreForm.web';

afterEach(cleanup);

it('disables row and thumb events, then allows recording when the row is enabled again', () => {
  const onValueChange = vi.fn();
  const makeModel = (disabled?: boolean): MoreFormModel => ({
    sections: [
      {
        key: 'privacy',
        rows: [{ kind: 'toggle', key: 'recording', label: 'Recording', value: false, disabled, onValueChange }],
      },
    ],
  });
  const view = render(createElement(MoreForm, { model: makeModel(true) }));
  const disabledSwitch = screen.getByRole('switch');
  expect((disabledSwitch as HTMLButtonElement).disabled).toBe(true);
  expect(disabledSwitch.getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByTestId('visual-switch').getAttribute('data-disabled')).toBe('true');
  fireEvent.click(disabledSwitch);
  // A delayed UI callback is also rejected after React disables the row.
  act(() => rowEvent.onPress?.());
  expect(onValueChange).not.toHaveBeenCalled();

  view.rerender(createElement(MoreForm, { model: makeModel(false) }));
  expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole('switch').getAttribute('aria-disabled')).toBe('false');
  expect(screen.getByTestId('visual-switch').getAttribute('data-disabled')).toBe('false');
  fireEvent.click(screen.getByRole('switch'));
  expect(onValueChange).toHaveBeenCalledExactlyOnceWith(true);

  // Existing toggles that omit the optional field retain their behavior.
  view.rerender(createElement(MoreForm, { model: makeModel() }));
  fireEvent.click(screen.getByRole('switch'));
  expect(onValueChange).toHaveBeenCalledTimes(2);
});
