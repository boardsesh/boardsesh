// @vitest-environment jsdom
//
// The browser SwitchRow. react-native-web 0.21 ignores `accessibilityState`, so
// these pin the aria props that actually reach the DOM (a switch with no
// aria-checked is read as a switch with no state), and the opt-in wrap for a
// description too long for one line.
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listRow = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
const haptics = vi.hoisted(() => ({ hapticSelection: vi.fn() }));

vi.mock('react-native', () => ({
  // Mirrors react-native-web: `role` and `aria-*` props become DOM attributes.
  Pressable: ({
    children,
    onPress,
    disabled,
    role,
    'aria-label': ariaLabel,
    'aria-checked': ariaChecked,
    'aria-disabled': ariaDisabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    role?: string;
    'aria-label'?: string;
    'aria-checked'?: boolean;
    'aria-disabled'?: boolean;
  }) =>
    createElement(
      'div',
      {
        role,
        'aria-label': ariaLabel,
        'aria-checked': ariaChecked,
        'aria-disabled': ariaDisabled,
        onClick: disabled ? undefined : onPress,
      },
      children,
    ),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-native-paper', () => ({ Switch: () => null }));
vi.mock('../../lib/haptics', () => haptics);
vi.mock('../ListRow', () => ({
  ListRow: (props: Record<string, unknown>) => {
    listRow.props = props;
    return null;
  },
}));

import { SwitchRow } from '../SwitchRow.web';

beforeEach(() => {
  listRow.props = null;
  haptics.hapticSelection.mockClear();
});

describe('SwitchRow (web)', () => {
  it('exposes the switch role, label and on/off state to screen readers', () => {
    const { rerender } = render(
      createElement(SwitchRow, { label: 'Show this session live', value: true, onValueChange: vi.fn() }),
    );

    const row = screen.getByRole('switch', { name: 'Show this session live' });
    expect(row.getAttribute('aria-checked')).toBe('true');
    expect(row.getAttribute('aria-disabled')).toBe('false');

    rerender(createElement(SwitchRow, { label: 'Show this session live', value: false, onValueChange: vi.fn() }));
    expect(row.getAttribute('aria-checked')).toBe('false');
  });

  it('flips on a row tap and reports disabled without flipping', () => {
    const onValueChange = vi.fn();
    const { rerender } = render(createElement(SwitchRow, { label: 'Rest timer', value: false, onValueChange }));

    fireEvent.click(screen.getByRole('switch'));
    expect(onValueChange).toHaveBeenCalledWith(true);

    onValueChange.mockClear();
    rerender(createElement(SwitchRow, { label: 'Rest timer', value: false, onValueChange, disabled: true }));
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch').getAttribute('aria-disabled')).toBe('true');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('keeps the description on one line unless the caller opts into wrapping', () => {
    const { rerender } = render(
      createElement(SwitchRow, {
        label: 'Rest timer',
        description: 'Time your rest',
        value: false,
        onValueChange: vi.fn(),
      }),
    );
    expect(listRow.props?.wrapSubtitle).toBe(false);

    rerender(
      createElement(SwitchRow, {
        label: 'Show this session live',
        description: 'Your crew and climbers on this board can see it and join.',
        wrapDescription: true,
        value: true,
        onValueChange: vi.fn(),
      }),
    );
    expect(listRow.props?.subtitle).toBe('Your crew and climbers on this board can see it and join.');
    expect(listRow.props?.wrapSubtitle).toBe(true);
  });
});
