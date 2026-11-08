// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hapticSelectionMock = vi.hoisted(() => vi.fn());
const composeSwitchProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
const rowToggle = vi.hoisted(() => ({ last: null as null | (() => void) }));
const composeTextColors = vi.hoisted(() => ({ seen: [] as Array<unknown> }));
const switchColorArgs = vi.hoisted(() => ({ last: null as null | unknown[] }));
// What each node is named for TalkBack: the `semantics` contentDescriptions on its modifiers.
type ModifierStub = { kind: string; contentDescription?: string };
const named = vi.hoisted(() => ({
  row: [] as ModifierStub[],
  texts: [] as Array<ModifierStub[] | undefined>,
}));

vi.mock('../../lib/haptics', () => ({ hapticSelection: hapticSelectionMock }));
vi.mock('react-native', () => ({ StyleSheet: { create: <Styles,>(styles: Styles) => styles } }));
vi.mock('@expo/ui', () => ({
  Host: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('@expo/ui/jetpack-compose', () => ({
  Row: ({ children, modifiers }: { children?: ReactNode; modifiers?: ModifierStub[] }) => {
    named.row = modifiers ?? [];
    return createElement('div', null, children);
  },
  Column: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Text: ({ children, color, modifiers }: { children?: ReactNode; color?: unknown; modifiers?: ModifierStub[] }) => {
    composeTextColors.seen.push(color);
    named.texts.push(modifiers);
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
  semantics: ({ contentDescription }: { contentDescription?: string }) => ({ kind: 'semantics', contentDescription }),
}));
const useThemeMock = vi.hoisted(() =>
  vi.fn(
    (): {
      brandColors: { primary: string };
      m3: { outline: string };
      m3SurfaceContainers: Record<'lowest' | 'low' | 'base' | 'high' | 'highest', string>;
      colorScheme: 'light' | 'dark';
      systemColors: { label: string; secondaryLabel: string };
    } => ({
      brandColors: { primary: '#6D28D9' },
      m3: { outline: '#96949A' },
      m3SurfaceContainers: { lowest: '#EEEEEE', low: '#EAEAEA', base: '#E4E4E4', high: '#DFDFDF', highest: '#D9D9D9' },
      colorScheme: 'light',
      systemColors: { label: '#111111', secondaryLabel: '#222222' },
    }),
  ),
);
vi.mock('../../providers/theme-provider', () => ({ useTheme: useThemeMock }));
vi.mock('../../theme/expo-ui-modifiers', () => ({
  switchControlColors: (...args: unknown[]) => {
    switchColorArgs.last = args;
    return { checkedTrackColor: 'from-switchControlColors' };
  },
  composeSeedColor: () => '#7C3AED',
  composeSurfaceColorOverrides: () => ({}),
}));
vi.mock('../../theme/tokens', () => ({ spacing: { 2: 8, 4: 16 } }));

import { SwitchRow } from '../SwitchRow.android';

beforeEach(() => {
  hapticSelectionMock.mockReset();
  composeSwitchProps.last = null;
  rowToggle.last = null;
  composeTextColors.seen = [];
  switchColorArgs.last = null;
  named.row = [];
  named.texts = [];
  useThemeMock.mockReturnValue({
    brandColors: { primary: '#6D28D9' },
    m3: { outline: '#96949A' },
    m3SurfaceContainers: { lowest: '#EEEEEE', low: '#EAEAEA', base: '#E4E4E4', high: '#DFDFDF', highest: '#D9D9D9' },
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

  it('hands the Switch the full brand + Velvet colour set, not just the on-track', () => {
    // Every unset Compose colour used to come from the wallpaper (#6919), so the
    // m3 roles that name the off state must reach switchControlColors.
    render(<SwitchRow label="Public board" value={false} onValueChange={vi.fn()} />);

    expect(switchColorArgs.last).toEqual([{ primary: '#6D28D9' }, { outline: '#96949A' }, 'light']);
    expect(composeSwitchProps.last?.colors).toEqual({ checkedTrackColor: 'from-switchControlColors' });
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
      m3: { outline: '#8A8A8A' },
      m3SurfaceContainers: { lowest: '#121212', low: '#161616', base: '#1A1A1A', high: '#262626', highest: '#2E2E2E' },
      colorScheme: 'dark',
      systemColors: { label: '#EDEDED', secondaryLabel: '#B0B0B0' },
    });

    render(<SwitchRow label="Public board" description="Visible to everyone" value={false} onValueChange={vi.fn()} />);

    expect(composeTextColors.seen).toEqual(['#EDEDED', '#B0B0B0']);
  });
});

// A label that leans on the row above ("In a session too" under Keep lighting)
// still names the switch on its own (spec B4.1): TalkBack and Voice Access.
describe('Android SwitchRow accessibility name', () => {
  const descriptionOf = (modifiers: ModifierStub[] | undefined) =>
    modifiers?.find((modifier) => modifier.kind === 'semantics')?.contentDescription;

  it('names the greyed-out switch and its label, never a bare label', () => {
    render(
      <SwitchRow
        label="In a session too"
        accessibilityLabel="Keep lighting in a session too"
        value={false}
        onValueChange={vi.fn()}
        disabled
      />,
    );
    expect(descriptionOf(composeSwitchProps.last?.modifiers as ModifierStub[] | undefined)).toBe(
      'Keep lighting in a session too',
    );
    expect(descriptionOf(named.texts[0])).toBe('Keep lighting in a session too');
  });

  it('names the toggleable row, with its line under the label', () => {
    render(
      <SwitchRow
        label="In a session too"
        accessibilityLabel="Keep lighting in a session too"
        description="With a crew in your session"
        value
        onValueChange={vi.fn()}
      />,
    );
    expect(descriptionOf(named.row)).toBe('Keep lighting in a session too, With a crew in your session');
    expect(descriptionOf(composeSwitchProps.last?.modifiers as ModifierStub[] | undefined)).toBe(
      'Keep lighting in a session too',
    );
  });

  it('adds no name of its own without one', () => {
    render(<SwitchRow label="Public board" value={false} onValueChange={vi.fn()} disabled />);
    expect(descriptionOf(named.row)).toBeUndefined();
    expect(composeSwitchProps.last?.modifiers).toBeUndefined();
  });
});
