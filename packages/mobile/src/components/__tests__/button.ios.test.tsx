// @vitest-environment jsdom
// What the iOS Button hands its @expo/ui `Host`. The native SwiftUI tree can't
// mount under vitest, so the `Host` is captured, not rendered. The SwiftUI side
// of the prop (expo-modules-core `setSafeAreaRegions(ignoring:)` removing
// `.keyboard` from the hosting controller's `safeAreaRegions`) is upstream
// code this test takes on trust.
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewStyle } from 'react-native';

const hostCalls = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
const buttonCalls = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  PlatformColor: (name: string) => name,
}));
vi.mock('@expo/ui', () => ({
  Host: (props: Record<string, unknown> & { children?: ReactNode }) => {
    hostCalls.props.push(props);
    return createElement('div', null, props.children);
  },
}));
vi.mock('@expo/ui/swift-ui', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const SwiftUIButton = (props: Record<string, unknown> & { children?: ReactNode }) => {
    buttonCalls.props.push(props);
    return createElement('div', null, props.children);
  };
  return { Button: SwiftUIButton, HStack: passthrough, Image: () => null, ProgressView: () => null, Text: passthrough };
});
vi.mock('@expo/ui/swift-ui/modifiers', () => {
  const modifier =
    (kind: string) =>
    (...args: unknown[]) => ({ kind, args });
  return {
    accessibilityLabel: modifier('accessibilityLabel'),
    buttonBorderShape: modifier('buttonBorderShape'),
    buttonStyle: modifier('buttonStyle'),
    controlSize: modifier('controlSize'),
    disabled: modifier('disabled'),
    dynamicTypeSize: modifier('dynamicTypeSize'),
    font: modifier('font'),
    foregroundStyle: modifier('foregroundStyle'),
    frame: modifier('frame'),
    tint: modifier('tint'),
  };
});
vi.mock('../../hooks/use-glass-capability', () => ({ useGlassCapability: () => true }));
vi.mock('../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../theme/expo-ui-modifiers', () => ({ brandAccentColor: () => '#6D28D9' }));
vi.mock('../../providers/theme-provider', async () => {
  const { makeThemeMock } = await import('../../test/theme-mock');
  const theme = makeThemeMock();
  return { useTheme: () => theme };
});

import { Button } from '../Button.ios';
import type { ButtonVariant } from '../Button.types';

function lastHostProps(): Record<string, unknown> {
  const props = hostCalls.props.at(-1);
  if (!props) throw new Error('Host was never rendered');
  return props;
}

type Modifier = { kind: string; args: unknown[] };

function lastModifiers(): Modifier[] {
  const props = buttonCalls.props.at(-1);
  if (!props) throw new Error('SwiftUI Button was never rendered');
  return props.modifiers as Modifier[];
}

function modifierArg(kind: string): unknown {
  return lastModifiers().find((entry) => entry.kind === kind)?.args[0];
}

beforeEach(() => {
  hostCalls.props = [];
  buttonCalls.props = [];
});

// HIG Buttons: only the prominent (filled) call to action is semibold; bordered
// and borderless system buttons are regular weight.
describe('iOS Button label weight', () => {
  it.each<[ButtonVariant, string]>([
    ['filled', 'semibold'],
    ['outlined', 'regular'],
    ['tonal', 'regular'],
    ['text', 'regular'],
  ])('%s is %s', (variant, weight) => {
    render(<Button title="Save" onPress={vi.fn()} variant={variant} />);

    expect(modifierArg('font')).toEqual({ textStyle: 'callout', weight });
  });

  // Over board art the middle tier draws a solid borderedProminent scrim pill,
  // so its label takes the prominent weight too.
  it.each<ButtonVariant>(['outlined', 'tonal'])('%s over content is semibold', (variant) => {
    render(<Button title="Switch" onPress={vi.fn()} variant={variant} over="content" />);

    expect(modifierArg('buttonStyle')).toBe('borderedProminent');
    expect(modifierArg('font')).toEqual({ textStyle: 'callout', weight: 'semibold' });
  });
});

// Every native label is capped, so a button never outgrows the 1.5x-capped Text
// around it. A caller's own cap (the tick bar's 1.3) still wins.
describe('iOS Button Dynamic Type cap', () => {
  it('caps at xxxLarge (1.5x, like Text) when the caller sets nothing', () => {
    render(<Button title="Save" onPress={vi.fn()} />);

    expect(modifierArg('dynamicTypeSize')).toEqual({ max: 'xxxLarge' });
  });

  it("keeps the caller's tighter cap", () => {
    render(<Button title="Send" onPress={vi.fn()} maxFontSizeMultiplier={1.3} />);

    expect(modifierArg('dynamicTypeSize')).toEqual({ max: 'xxLarge' });
  });
});

describe('iOS Button host', () => {
  // The tick sheet's pair (#5663): tonal Attempt (glass) beside filled Flash
  // (borderedProminent), both with a pinned height in a flexed row. Neither may
  // let SwiftUI inset it for the keyboard; React Native already moved the row.
  it.each<[string, ButtonVariant, ViewStyle]>([
    ['tonal, flexed with a pinned height', 'tonal', { flex: 1, height: 56 }],
    ['filled, flexed with a pinned height', 'filled', { flex: 2, height: 56 }],
    ['outlined, full width', 'outlined', { width: '100%' }],
    ['text, inline', 'text', {}],
  ])('ignores the keyboard safe area: %s', (_label, variant, style) => {
    render(<Button title="Attempt" onPress={vi.fn()} variant={variant} size="large" style={style} />);

    expect(lastHostProps().ignoreSafeArea).toBe('keyboard');
  });
});
