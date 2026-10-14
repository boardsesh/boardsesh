// @vitest-environment jsdom
//
// The web MoreForm renderer, mounted over a DOM stand-in for react-native-paper.
// Covers the toggle row's disabled contract, the full-bleed preview, and the
// row options the Settings pages lean on: nav value + external, value rows,
// disabled / loading buttons, and disabled select / segmented rows.
import { createElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MoreFormModel, MoreRow } from '../MoreForm.types';

const rowEvent = vi.hoisted(() => ({ onPress: null as (() => void) | null }));
const buttonEvent = vi.hoisted(() => ({ onPress: null as (() => void) | null }));
const segmentedCalls = vi.hoisted(() => [] as { disabledKeys?: ReadonlySet<string> }[]);

vi.mock('react-native', async () => {
  const { flattenStyle } = await import('../../../test/flatten-style');
  return {
    ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
      createElement('div', { 'data-style': JSON.stringify(flattenStyle(style)) }, children),
    StyleSheet: { create: (styles: unknown) => styles },
  };
});
vi.mock('react-native-paper', () => {
  const Menu = ({ visible, anchor, children }: { visible: boolean; anchor: ReactNode; children?: ReactNode }) =>
    createElement('div', null, anchor, visible ? createElement('div', { role: 'menu' }, children) : null);
  Menu.Item = ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { type: 'button', role: 'menuitem', onClick: onPress }, title);
  return {
    ActivityIndicator: () => createElement('span', { 'data-testid': 'spinner' }),
    Divider: () => null,
    List: {
      Item: ({
        title,
        description,
        onPress,
        disabled,
        left,
        right,
        accessibilityRole,
        accessibilityHint,
        'aria-checked': checked,
        'aria-disabled': ariaDisabled,
        'aria-busy': busy,
      }: {
        title: string;
        description?: string;
        onPress?: () => void;
        disabled?: boolean;
        left?: (props: object) => ReactNode;
        right?: (props: object) => ReactNode;
        accessibilityRole?: string;
        accessibilityHint?: string;
        'aria-checked'?: boolean;
        'aria-disabled'?: boolean;
        'aria-busy'?: boolean;
      }) => {
        if (onPress) rowEvent.onPress = onPress;
        return createElement(
          'button',
          {
            role: accessibilityRole ?? 'button',
            disabled,
            onClick: onPress,
            'aria-checked': checked,
            'aria-disabled': ariaDisabled,
            'aria-busy': busy,
            'aria-description': accessibilityHint,
            'data-pressable': onPress ? 'true' : 'false',
          },
          left?.({}),
          title,
          description,
          right?.({}),
        );
      },
      Icon: ({ icon }: { icon: string }) => createElement('span', { 'data-icon': icon }),
    },
    Surface: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-surface': 'true' }, children),
    Switch: ({ disabled }: { disabled?: boolean }) =>
      createElement('span', { 'data-testid': 'visual-switch', 'data-disabled': disabled === true }),
    Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
    Menu,
  };
});
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 10: 40 } }));
// Mirrors Button.web's contract: `loading` also disables, and the label stays.
vi.mock('../Button', () => ({
  Button: ({
    title,
    onPress,
    disabled,
    loading,
    variant,
    role,
  }: {
    title: string;
    onPress: () => void;
    disabled?: boolean;
    loading?: boolean;
    variant?: string;
    role?: string;
  }) => {
    buttonEvent.onPress = onPress;
    return createElement(
      'button',
      {
        type: 'button',
        disabled: disabled || loading,
        'aria-busy': loading,
        'data-variant': variant,
        'data-role': role,
        onClick: onPress,
      },
      title,
    );
  },
}));
vi.mock('../SegmentedControl', () => ({
  SegmentedControl: (props: { disabledKeys?: ReadonlySet<string> }) => {
    segmentedCalls.push(props);
    return null;
  },
}));
vi.mock('../settings/MarkerMultiplierSlider', () => ({ MarkerMultiplierSlider: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { MoreForm } from '../MoreForm.web';

afterEach(() => {
  cleanup();
  rowEvent.onPress = null;
  buttonEvent.onPress = null;
  segmentedCalls.length = 0;
});

function renderRows(...rows: MoreRow[]) {
  return render(createElement(MoreForm, { model: { sections: [{ key: 'section', rows }] } }));
}

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

describe('nav rows', () => {
  it('shows the current value before the chevron', () => {
    const onPress = vi.fn();
    renderRows({ kind: 'nav', key: 'grades', label: 'Grades', value: 'V-scale', onPress });
    const row = screen.getByRole('button', { name: /Grades/ });
    expect(row.textContent).toContain('V-scale');
    expect(row.querySelector('[data-icon="chevron-right"]')).toBeTruthy();
    expect(row.querySelector('[data-icon="open-in-new"]')).toBeNull();
    expect(row.getAttribute('aria-description')).toBeNull();
    fireEvent.click(row);
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('swaps the chevron for an outward arrow and says so when the row leaves the app', () => {
    const onPress = vi.fn();
    renderRows({ kind: 'nav', key: 'policy', label: 'Privacy policy', external: true, onPress });
    const row = screen.getByRole('button', { name: /Privacy policy/ });
    expect(row.querySelector('[data-icon="open-in-new"]')).toBeTruthy();
    expect(row.querySelector('[data-icon="chevron-right"]')).toBeNull();
    expect(row.getAttribute('aria-description')).toBe('mobile.a11y.opensOutsideApp');
    fireEvent.click(row);
    expect(onPress).toHaveBeenCalledOnce();
  });
});

describe('value rows', () => {
  it('shows the label, subtitle and value, and fires its action when tapped', () => {
    const onPress = vi.fn();
    renderRows({
      kind: 'value',
      key: 'email',
      label: 'Email',
      subtitle: 'Tap to copy',
      value: 'climber@example.com',
      onPress,
    });
    const row = screen.getByRole('button', { name: /Email/ });
    expect(row.textContent).toContain('Tap to copy');
    expect(row.textContent).toContain('climber@example.com');
    // A value row never draws a disclosure chevron.
    expect(row.querySelector('[data-icon="chevron-right"]')).toBeNull();
    expect(screen.queryByTestId('spinner')).toBeNull();
    fireEvent.click(row);
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('is read-only without an action', () => {
    renderRows({ kind: 'value', key: 'used', label: 'Space used', value: '1.2 GB' });
    expect(screen.getByRole('button', { name: /Space used/ }).getAttribute('data-pressable')).toBe('false');
  });

  it('shows a spinner while the value is being worked out', () => {
    renderRows({ kind: 'value', key: 'used', label: 'Space used', busy: true });
    expect(screen.getByTestId('spinner')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Space used/ }).getAttribute('aria-busy')).toBe('true');
  });
});

describe('button rows', () => {
  it('fires an idle button', () => {
    const onPress = vi.fn();
    renderRows({ kind: 'button', key: 'sign-out', label: 'Sign out', onPress });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onPress).toHaveBeenCalledOnce();
  });

  it.each([
    ['disabled', { disabled: true }],
    ['loading', { loading: true }],
  ])('refuses the press while %s, even one the native side already queued', (_state, flags) => {
    const onPress = vi.fn();
    renderRows({ kind: 'button', key: 'sign-out', label: 'Sign out', onPress, ...flags });
    const button = screen.getByRole('button', { name: 'Sign out' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    act(() => buttonEvent.onPress?.());
    expect(onPress).not.toHaveBeenCalled();
  });

  it('marks a loading button busy', () => {
    renderRows({ kind: 'button', key: 'sign-out', label: 'Sign out', loading: true, onPress: vi.fn() });
    expect(screen.getByRole('button', { name: 'Sign out' }).getAttribute('aria-busy')).toBe('true');
  });

  it.each([
    ['a destructive', 'destructive' as const, 'destructive'],
    ['a plain', undefined, 'default'],
  ])('draws %s subtle button as a text button', (_name, role, expectedRole) => {
    renderRows({ kind: 'button', key: 'reset', label: 'Reset', role, emphasis: 'subtle', onPress: vi.fn() });
    const button = screen.getByRole('button', { name: 'Reset' });
    expect(button.getAttribute('data-variant')).toBe('text');
    expect(button.getAttribute('data-role')).toBe(expectedRole);
  });

  it('keeps a primary button filled', () => {
    renderRows({ kind: 'button', key: 'sign-out', label: 'Sign out', role: 'destructive', onPress: vi.fn() });
    expect(screen.getByRole('button', { name: 'Sign out' }).getAttribute('data-variant')).toBe('filled');
  });
});

describe('select and segmented rows', () => {
  const options = [
    { key: 'system', label: 'System' },
    { key: 'es', label: 'Español' },
  ];

  it('opens the menu and picks an option when enabled', () => {
    const onSelect = vi.fn();
    renderRows({ kind: 'select', key: 'language', label: 'Language', options, selectedKey: 'system', onSelect });
    fireEvent.click(screen.getByRole('button', { name: /Language/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Español' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('es');
  });

  it('does not open the menu when disabled', () => {
    const onSelect = vi.fn();
    renderRows({
      kind: 'select',
      key: 'language',
      label: 'Language',
      options,
      selectedKey: 'system',
      disabled: true,
      onSelect,
    });
    const row = screen.getByRole('button', { name: /Language/ }) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.getAttribute('aria-disabled')).toBe('true');
    act(() => rowEvent.onPress?.());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('refuses every segment of a disabled segmented row', () => {
    renderRows({
      kind: 'segmented',
      key: 'appearance',
      label: 'Appearance',
      options,
      selectedKey: 'system',
      disabled: true,
      onSelect: vi.fn(),
    });
    expect(segmentedCalls.at(-1)?.disabledKeys).toEqual(new Set(['system', 'es']));
  });

  it("keeps an enabled segmented row's own disabled keys", () => {
    const disabledKeys = new Set(['es']);
    renderRows({
      kind: 'segmented',
      key: 'appearance',
      label: 'Appearance',
      options,
      selectedKey: 'system',
      disabledKeys,
      onSelect: vi.fn(),
    });
    expect(segmentedCalls.at(-1)?.disabledKeys).toBe(disabledKeys);
  });
});
