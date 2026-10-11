// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MoreFormModel } from '../MoreForm.types';

const rowEvent = vi.hoisted(() => ({ onPress: null as (() => void) | null }));

vi.mock('react-native', async () => {
  const { flattenStyle } = await import('../../../test/flatten-style');
  return {
    ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
      createElement('div', { 'data-style': JSON.stringify(flattenStyle(style)) }, children),
    StyleSheet: { create: (styles: unknown) => styles },
  };
});
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
  Surface: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-surface': 'true' }, children),
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

it('gives a full-bleed preview the screen width while keeping normal settings cards inset', () => {
  const model: MoreFormModel = {
    sections: [
      {
        key: 'preview',
        rows: [
          {
            kind: 'custom',
            key: 'row-preview',
            fullBleed: true,
            height: 177,
            content: createElement('div', { 'data-testid': 'row-preview' }),
          },
        ],
      },
      {
        key: 'settings',
        rows: [{ kind: 'toggle', key: 'picture', label: 'Picture', value: true, onValueChange: vi.fn() }],
      },
    ],
  };
  const { container } = render(createElement(MoreForm, { model }));
  const preview = screen.getByTestId('row-preview');
  expect(preview.closest('[data-surface]')).toBeNull();
  expect(JSON.parse(preview.parentElement?.getAttribute('data-style') ?? '{}')).toEqual({ height: 177 });
  expect(JSON.parse(preview.parentElement?.parentElement?.getAttribute('data-style') ?? '{}')).toEqual({
    marginHorizontal: -16,
  });
  expect(container.querySelectorAll('[data-surface]')).toHaveLength(1);
  expect(screen.getByRole('switch').closest('[data-surface]')).toBeTruthy();
});
