// @vitest-environment jsdom
//
// The MoreForm test stub (test/more-form-stub.tsx) stands in for the native form
// in every screen test, so its contract is pinned here: a screen test must be
// able to find the new row options by role and label, and a disabled or busy
// row must refuse a press there just as it does on a phone.
import { createElement, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MoreRow } from '../MoreForm.types';

type PressableProps = {
  children?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: { busy?: boolean; disabled?: boolean };
};

// Deliberately ignores `disabled` when wiring the click: the stub must refuse a
// press through its own guard, not lean on the primitive.
vi.mock('react-native', () => ({
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityRole,
    accessibilityLabel,
    accessibilityHint,
    accessibilityState,
  }: PressableProps) =>
    createElement(
      'button',
      {
        type: 'button',
        role: accessibilityRole,
        'aria-label': accessibilityLabel,
        'aria-description': accessibilityHint,
        'aria-busy': accessibilityState?.busy,
        'data-disabled': disabled === true,
        onClick: onPress,
      },
      children,
    ),
  Switch: () => null,
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  View: ({ children, accessibilityState }: { children?: ReactNode; accessibilityState?: { busy?: boolean } }) =>
    createElement('div', { 'aria-busy': accessibilityState?.busy }, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const { MoreForm } = await import('../../../test/more-form-stub');

afterEach(cleanup);

function renderRows(...rows: MoreRow[]) {
  return render(createElement(MoreForm, { model: { sections: [{ key: 'section', rows }] } }));
}

it('renders a nav row value and gives an external row its hint', () => {
  renderRows(
    { kind: 'nav', key: 'grades', label: 'Grades', value: 'V-scale', onPress: vi.fn() },
    { kind: 'nav', key: 'policy', label: 'Privacy policy', external: true, onPress: vi.fn() },
  );
  expect(screen.getByRole('button', { name: 'Grades' }).textContent).toContain('V-scale');
  expect(screen.getByRole('button', { name: 'Grades' }).getAttribute('aria-description')).toBeNull();
  expect(screen.getByRole('button', { name: 'Privacy policy' }).getAttribute('aria-description')).toBe(
    'mobile.a11y.opensOutsideApp',
  );
});

it('renders a value row as a button only when it has an action', () => {
  const onPress = vi.fn();
  renderRows(
    { kind: 'value', key: 'email', label: 'Email', value: 'climber@example.com', onPress },
    { kind: 'value', key: 'used', label: 'Space used', value: '1.2 GB', busy: true },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Email' }));
  expect(onPress).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Space used' })).toBeNull();
  expect(screen.getByText('1.2 GB').closest('[aria-busy="true"]')).toBeTruthy();
});

it.each([{ disabled: true }, { loading: true }])('refuses a button press when %o', (flags) => {
  const onPress = vi.fn();
  renderRows({ kind: 'button', key: 'sign-out', label: 'Sign out', onPress, ...flags });
  const button = screen.getByRole('button', { name: 'Sign out' });
  expect(button.getAttribute('data-disabled')).toBe('true');
  fireEvent.click(button);
  expect(onPress).not.toHaveBeenCalled();
});

it.each(['select', 'segmented'] as const)('refuses every option of a disabled %s row', (kind) => {
  const onSelect = vi.fn();
  renderRows({
    kind,
    key: 'grades',
    label: 'Grades',
    options: [
      { key: 'v', label: 'V-scale' },
      { key: 'font', label: 'Font' },
    ],
    selectedKey: 'v',
    disabled: true,
    onSelect,
  });
  fireEvent.click(screen.getByRole('radio', { name: 'Font' }));
  expect(screen.getByRole('radio', { name: 'Font' }).getAttribute('data-disabled')).toBe('true');
  expect(onSelect).not.toHaveBeenCalled();
});
