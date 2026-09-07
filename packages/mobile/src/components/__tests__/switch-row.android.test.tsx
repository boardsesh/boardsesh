// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hapticSelectionMock = vi.hoisted(() => vi.fn());
const composeSwitchProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
const rowToggle = vi.hoisted(() => ({ last: null as null | (() => void) }));

vi.mock('../../lib/haptics', () => ({ hapticSelection: hapticSelectionMock }));
vi.mock('react-native', () => ({ StyleSheet: { create: <Styles,>(styles: Styles) => styles } }));
vi.mock('@expo/ui', () => ({
  Host: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('@expo/ui/jetpack-compose', () => ({
  Row: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Column: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
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
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { primary: '#6D28D9' }, colorScheme: 'light' }),
}));
vi.mock('../../theme/expo-ui-modifiers', () => ({ switchBrandColors: () => ({}) }));
vi.mock('../../theme/tokens', () => ({ spacing: { 2: 8, 4: 16 } }));

import { SwitchRow } from '../SwitchRow.android';

beforeEach(() => {
  hapticSelectionMock.mockReset();
  composeSwitchProps.last = null;
  rowToggle.last = null;
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
});
