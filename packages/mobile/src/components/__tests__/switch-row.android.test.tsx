// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hapticSelectionMock = vi.hoisted(() => vi.fn());
const composeSwitchProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
const rowToggle = vi.hoisted(() => ({ last: null as null | (() => void) }));
const composeTextColors = vi.hoisted(() => ({ seen: [] as Array<unknown> }));

vi.mock('../../lib/haptics', () => ({ hapticSelection: hapticSelectionMock }));
vi.mock('react-native', () => ({ StyleSheet: { create: <Styles,>(styles: Styles) => styles } }));
vi.mock('@expo/ui', () => ({
  Host: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('@expo/ui/jetpack-compose', () => ({
  Row: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Column: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Text: ({ children, color }: { children?: ReactNode; color?: unknown }) => {
    composeTextColors.seen.push(color);
    return createElement('span', null, children);
  },
  Switch: (props: Record<string, unknown>) => {
    composeSwitchProps.last = props;
    const onCheckedChange = props.onCheckedChange as ((next: boolean) => void) | undefined;
    const value = props.value as boolean;
    return createElement('button', { onClick: () => onCheckedChange?.(!value), type: 'button' }, 'switch');
  },
}));
vi.mock('@expo/ui/jetpack-compose/modifiers', () => ({
  fillMaxWidth: () => ({ kind: 'fillMaxWidth' }),
  weight: () => ({ kind: 'weight' }),
  toggleable: (_value: boolean, handler: () => void) => {
    rowToggle.last = handler;
    return { kind: 'toggleable' };
  },
  padding: () => ({ kind: 'padding' }),
  defaultMinSize: () => ({ kind: 'defaultMinSize' }),
  alpha: () => ({ kind: 'alpha' }),
}));
const useThemeMock = vi.hoisted(() =>
  vi.fn(
    (): {
      brandColors: { primary: string };
      colorScheme: 'light' | 'dark';
      systemColors: { label: string; secondaryLabel: string };
    } => ({
      brandColors: { primary: '#6D28D9' },
      colorScheme: 'light',
      systemColors: { label: '#111111', secondaryLabel: '#222222' },
    }),
  ),
);
vi.mock('../../providers/theme-provider', () => ({ useTheme: useThemeMock }));
vi.mock('../../theme/expo-ui-modifiers', () => ({ switchBrandColors: () => ({}) }));
vi.mock('../../theme/tokens', () => ({ spacing: { 2: 8, 4: 16 } }));

import { SwitchRow } from '../SwitchRow.android';

beforeEach(() => {
  hapticSelectionMock.mockReset();
  composeSwitchProps.last = null;
  rowToggle.last = null;
  composeTextColors.seen = [];
  useThemeMock.mockReturnValue({
    brandColors: { primary: '#6D28D9' },
    colorScheme: 'light',
    systemColors: { label: '#111111', secondaryLabel: '#222222' },
  });
});

describe('Android SwitchRow', () => {
  it('toggles when the nested Compose switch is tapped directly', () => {
    const onValueChange = vi.fn();
    const { getByRole } = render(<SwitchRow label="Public board" value={false} onValueChange={onValueChange} />);

    fireEvent.click(getByRole('button', { name: 'switch' }));

    expect(composeSwitchProps.last?.onCheckedChange).toBeTypeOf('function');
    expect(hapticSelectionMock).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledOnce();
    expect(onValueChange).toHaveBeenCalledWith(true);
  });

  it('keeps the label row tappable', () => {
    const onValueChange = vi.fn();
    render(<SwitchRow label="Public board" value={true} onValueChange={onValueChange} />);

    rowToggle.last?.();

    expect(onValueChange).toHaveBeenCalledOnce();
    expect(onValueChange).toHaveBeenCalledWith(false);
  });

  it('keeps disabled controls inert', () => {
    const onValueChange = vi.fn();
    const { getByRole } = render(
      <SwitchRow label="Public board" value={false} onValueChange={onValueChange} disabled />,
    );

    fireEvent.click(getByRole('button', { name: 'switch' }));
    (composeSwitchProps.last?.onCheckedChange as ((next: boolean) => void) | undefined)?.(true);

    expect(rowToggle.last).toBeNull();
    expect(composeSwitchProps.last?.enabled).toBe(false);
    expect(hapticSelectionMock).not.toHaveBeenCalled();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('gives the label and description an explicit colour instead of relying on M3 defaults', () => {
    // This Row sits directly in the Host, not inside a Card, so Compose gives
    // its Text nodes no on-surface content colour and renders them black
    // regardless of colorScheme unless one is set explicitly (issue #5332).
    render(<SwitchRow label="Public board" description="Visible to everyone" value={false} onValueChange={vi.fn()} />);

    expect(composeTextColors.seen).toEqual(['#111111', '#222222']);
  });

  it('forwards the dark-mode system colours too, not just light', () => {
    // The bug (#5332) only shows up in dark mode: Compose's black default sits
    // on a dark background. Confirm the fix isn't accidentally light-only.
    useThemeMock.mockReturnValue({
      brandColors: { primary: '#6D28D9' },
      colorScheme: 'dark',
      systemColors: { label: '#F5F2FB', secondaryLabel: '#A9A2B6' },
    });

    render(<SwitchRow label="Public board" description="Visible to everyone" value={false} onValueChange={vi.fn()} />);

    expect(composeTextColors.seen).toEqual(['#F5F2FB', '#A9A2B6']);
  });
});
