// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type NativeProps = Record<string, unknown> & { children?: ReactNode };
type Modifier = { kind: string; args: unknown[] };

const nativeCalls = vi.hoisted(() => ({
  host: [] as NativeProps[],
  toggle: [] as NativeProps[],
  stack: [] as NativeProps[],
  text: [] as NativeProps[],
}));
const hapticSelectionMock = vi.hoisted(() => vi.fn());
const useThemeMock = vi.hoisted(() =>
  vi.fn((): { colorScheme: 'light' | 'dark'; brandColors: { primary: string } } => ({
    colorScheme: 'light',
    brandColors: { primary: '#6D28D9' },
  })),
);

vi.mock('react-native', () => ({ StyleSheet: { create: <Styles,>(styles: Styles) => styles } }));
vi.mock('@expo/ui', () => ({
  Host: (props: NativeProps) => {
    nativeCalls.host.push(props);
    return createElement('div', null, props.children);
  },
}));
vi.mock('@expo/ui/swift-ui', () => ({
  Toggle: (props: NativeProps) => {
    nativeCalls.toggle.push(props);
    const onIsOnChange = props.onIsOnChange as ((isOn: boolean) => void) | undefined;
    return createElement(
      'button',
      {
        onClick: () => onIsOnChange?.(!props.isOn),
        type: 'button',
        'aria-label': findModifier(props, 'accessibilityLabel')?.args[0] as string | undefined,
      },
      props.children,
    );
  },
  VStack: (props: NativeProps) => {
    nativeCalls.stack.push(props);
    return createElement('div', null, props.children);
  },
  Text: (props: NativeProps) => {
    nativeCalls.text.push(props);
    return createElement('span', null, props.children);
  },
}));
vi.mock('@expo/ui/swift-ui/modifiers', () => {
  const modifier =
    (kind: string) =>
    (...args: unknown[]) => ({ kind, args });
  return {
    accessibilityLabel: modifier('accessibilityLabel'),
    disabled: modifier('disabled'),
    fixedSize: modifier('fixedSize'),
    font: modifier('font'),
    foregroundStyle: modifier('foregroundStyle'),
    frame: modifier('frame'),
    lineLimit: modifier('lineLimit'),
    padding: modifier('padding'),
    tint: modifier('tint'),
  };
});
vi.mock('../../providers/theme-provider', () => ({ useTheme: useThemeMock }));
vi.mock('../../theme/expo-ui-modifiers', () => ({ brandAccentColor: () => '#6D28D9' }));
vi.mock('../../lib/haptics', () => ({ hapticSelection: hapticSelectionMock }));
vi.mock('../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 4: 16 } }));

import { SwitchRow } from '../SwitchRow.ios';

function lastProps(component: keyof typeof nativeCalls): NativeProps {
  const props = nativeCalls[component].at(-1);
  if (!props) throw new Error(`SwiftUI ${component} was never rendered`);
  return props;
}

function findModifier(props: NativeProps, kind: string): Modifier | undefined {
  return (props.modifiers as Modifier[] | undefined)?.find((entry) => entry.kind === kind);
}

beforeEach(() => {
  for (const calls of Object.values(nativeCalls)) calls.length = 0;
  hapticSelectionMock.mockReset();
  useThemeMock.mockReturnValue({ colorScheme: 'light', brandColors: { primary: '#6D28D9' } });
});

// Capture the JS-to-SwiftUI contract. Native rendering and VoiceOver synthesis
// still require an iOS device; these mocks do not measure SwiftUI geometry.
describe('iOS SwitchRow', () => {
  it.each([false, true])('changes from %s exactly once per native activation', (value) => {
    const onValueChange = vi.fn();
    const { getByRole } = render(<SwitchRow label="Auto-advance" value={value} onValueChange={onValueChange} />);

    fireEvent.click(getByRole('button', { name: 'Auto-advance' }));

    expect(lastProps('toggle').isOn).toBe(value);
    expect(hapticSelectionMock).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith(!value);
  });

  it('blocks callback and haptic even when a disabled native control emits a change', () => {
    const onValueChange = vi.fn();
    const { getByRole } = render(
      <SwitchRow label="Auto-advance" value={false} onValueChange={onValueChange} disabled />,
    );

    fireEvent.click(getByRole('button', { name: 'Auto-advance' }));

    expect(findModifier(lastProps('toggle'), 'disabled')?.args).toEqual([true]);
    expect(hapticSelectionMock).not.toHaveBeenCalled();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('keeps title and description together in the native toggle label', () => {
    const { getByRole } = render(
      <SwitchRow
        label="Auto-advance"
        description="Light the next climb after your rest"
        value={false}
        onValueChange={vi.fn()}
      />,
    );

    expect(getByRole('button', { name: 'Auto-advance, Light the next climb after your rest' })).toBeTruthy();
    expect(nativeCalls.text.map((props) => props.children)).toEqual([
      'Auto-advance',
      'Light the next climb after your rest',
    ]);
  });

  it.each(['light', 'dark'] as const)('passes the %s app appearance to its height-measuring host', (colorScheme) => {
    useThemeMock.mockReturnValue({ colorScheme, brandColors: { primary: '#6D28D9' } });

    render(<SwitchRow label="Auto-advance" value={false} onValueChange={vi.fn()} />);

    expect(lastProps('host')).toMatchObject({
      colorScheme,
      matchContents: { vertical: true },
      ignoreSafeArea: 'all',
    });
  });

  it.each([
    [undefined, 48],
    ['Light the next climb after your rest', 64],
  ] as const)('reserves a native minimum height with description %s', (description, minHeight) => {
    render(<SwitchRow label="Auto-advance" description={description} value={false} onValueChange={vi.fn()} />);

    expect(findModifier(lastProps('toggle'), 'frame')?.args).toEqual([{ minHeight }]);
    const hostStyles = [lastProps('host').style].flat() as Record<string, unknown>[];
    expect(hostStyles.every((style) => style.minHeight === undefined)).toBe(true);
  });

  it('lets long native text wrap and grow vertically in a leading label stack', () => {
    render(
      <SwitchRow
        label="Auto-advance to the next climb"
        description="Light the next climb after your rest, including when your crew is climbing together"
        value={false}
        onValueChange={vi.fn()}
      />,
    );

    expect(lastProps('stack').alignment).toBe('leading');
    expect(findModifier(lastProps('stack'), 'lineLimit')?.args).toEqual([]);
    expect(findModifier(lastProps('stack'), 'fixedSize')?.args).toEqual([{ horizontal: false, vertical: true }]);
    for (const props of [lastProps('stack'), ...nativeCalls.text]) {
      expect(findModifier(props, 'dynamicTypeSize')).toBeUndefined();
    }
  });
});
