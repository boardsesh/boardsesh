// @vitest-environment jsdom
vi.mock('../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
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
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
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
import { ButtonSurfaceProvider } from '../Button.surface';
import type { ButtonVariant } from '../Button.types';
import { brandColors } from '../../theme/colors';
import { overlays } from '../../theme/tokens';

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

// The tick bar pins both buttons to 48pt. At `.large` glass and borderedProminent
// have natural heights above that (48.7 / 55.3pt), so they overflowed by
// different amounts (#5663). Pinned, they render at `.regular` and fill the pin.
describe('iOS Button pinned height', () => {
  it.each<[ButtonVariant]>([['tonal'], ['filled']])('%s pinned large renders at regular control size', (variant) => {
    render(<Button title="Attempt" onPress={vi.fn()} variant={variant} size="large" style={{ flex: 1, height: 48 }} />);

    expect(modifierArg('controlSize')).toBe('regular');
    expect(modifierArg('font')).toMatchObject({ textStyle: 'body' });
  });

  it('keeps large control size when the height is not pinned', () => {
    render(<Button title="Attempt" onPress={vi.fn()} variant="tonal" size="large" />);

    expect(modifierArg('controlSize')).toBe('large');
  });
});

// Every native label is capped, so a button never outgrows the 1.5x-capped Text
// around it. A caller's own cap (the tick bar's 1.3) still wins.
describe('iOS Button Dynamic Type cap', () => {
  it('caps at xxxLarge (1.5x, like Text) when the caller sets nothing', () => {
    render(<Button title="Save" onPress={vi.fn()} />);

    expect(modifierArg('dynamicTypeSize')).toEqual({ max: 'accessibility5' });
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

  // A button in a list header that mounts while the list is scrolled, so it
  // starts out of view, must not keep the container's inset.
  it('ignores every safe-area edge when asked to', () => {
    render(<Button title="Light climbs" onPress={vi.fn()} size="small" ignoreContainerSafeArea />);

    expect(lastHostProps().ignoreSafeArea).toBe('all');
  });
});

// HIG Materials: glass never sits on glass. Inside a region that is already
// Liquid Glass the middle tier draws a bordered capsule instead of its own glass.
describe('iOS Button surface', () => {
  it.each<ButtonVariant>(['tonal', 'outlined'])('%s is glass on an ordinary surface', (variant) => {
    render(<Button title="Refine" onPress={vi.fn()} variant={variant} />);
    expect(modifierArg('buttonStyle')).toBe('glass');
  });

  it.each<ButtonVariant>(['tonal', 'outlined'])('%s is bordered inside a glass region', (variant) => {
    render(
      <ButtonSurfaceProvider surface="glass">
        <Button title="Refine" onPress={vi.fn()} variant={variant} />
      </ButtonSurfaceProvider>,
    );
    expect(modifierArg('buttonStyle')).toBe('bordered');
  });

  it('honours a per-button over="glass"', () => {
    render(<Button title="Clear" onPress={vi.fn()} variant="outlined" over="glass" />);
    expect(modifierArg('buttonStyle')).toBe('bordered');
  });

  it('keeps the filled CTA solid inside a glass region', () => {
    render(
      <ButtonSurfaceProvider surface="glass">
        <Button title="Save" onPress={vi.fn()} variant="filled" />
      </ButtonSurfaceProvider>,
    );
    expect(modifierArg('buttonStyle')).toBe('borderedProminent');
  });
});

// A fixed foreground defeats SwiftUI's disabled appearance on borderless
// buttons. The native style needs the accent as its tint instead (#6570).
describe('iOS Button text colour', () => {
  it.each([
    { state: 'enabled', disabled: false, loading: false },
    { state: 'disabled', disabled: true, loading: false },
    { state: 'loading', disabled: false, loading: true },
  ])('leaves the $state text label colour to its native style', ({ disabled, loading }) => {
    render(<Button title="Show all" onPress={vi.fn()} variant="text" disabled={disabled} loading={loading} />);

    expect(modifierArg('tint')).toBe(brandColors.primary);
    expect(modifierArg('foregroundStyle')).toBeUndefined();
    expect(modifierArg('disabled')).toBe(disabled || loading);
  });

  it('keeps a custom text accent without forcing the disabled foreground', () => {
    render(<Button title="Restore defaults" onPress={vi.fn()} variant="text" tintColor="#123456" disabled />);

    expect(modifierArg('tint')).toBe('#123456');
    expect(modifierArg('foregroundStyle')).toBeUndefined();
  });

  it('keeps text over board art legible through its tint', () => {
    render(<Button title="Switch" onPress={vi.fn()} variant="text" over="content" />);

    expect(modifierArg('tint')).toBe(overlays.onScrim);
    expect(modifierArg('foregroundStyle')).toBeUndefined();
  });

  it.each<ButtonVariant>(['filled', 'outlined', 'tonal'])('preserves the %s foreground', (variant) => {
    render(<Button title="Save" onPress={vi.fn()} variant={variant} />);

    expect(modifierArg('foregroundStyle')).toBe(variant === 'filled' ? brandColors.onPrimary : brandColors.primary);
  });

  it('leaves a destructive text button colour to its native role', () => {
    render(<Button title="Delete" onPress={vi.fn()} variant="text" role="destructive" disabled />);

    expect(buttonCalls.props.at(-1)?.role).toBe('destructive');
    expect(modifierArg('disabled')).toBe(true);
    expect(modifierArg('tint')).toBeUndefined();
    expect(modifierArg('foregroundStyle')).toBeUndefined();
  });
});
