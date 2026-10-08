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
const swiftButtonCalls = vi.hoisted(() => ({ modifiers: [] as { kind: string; args: unknown[] }[][] }));

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
  const Button = ({
    children,
    modifiers,
  }: {
    children?: ReactNode;
    modifiers?: { kind: string; args: unknown[] }[];
  }) => {
    swiftButtonCalls.modifiers.push(modifiers ?? []);
    return createElement('div', null, children);
  };
  return { Button, HStack: passthrough, Image: () => null, ProgressView: () => null, Text: passthrough };
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

function lastHostProps(): Record<string, unknown> {
  const props = hostCalls.props.at(-1);
  if (!props) throw new Error('Host was never rendered');
  return props;
}

beforeEach(() => {
  hostCalls.props = [];
  swiftButtonCalls.modifiers = [];
});

function lastButtonStyle(): unknown {
  const modifiers = swiftButtonCalls.modifiers.at(-1);
  if (!modifiers) throw new Error('SwiftUI Button was never rendered');
  return modifiers.find((modifier) => modifier.kind === 'buttonStyle')?.args[0];
}

// HIG Materials: glass never sits on glass. Inside a region that is already
// Liquid Glass the middle tier draws a bordered capsule instead of its own glass.
describe('iOS Button surface', () => {
  it.each<ButtonVariant>(['tonal', 'outlined'])('%s is glass on an ordinary surface', (variant) => {
    render(<Button title="Refine" onPress={vi.fn()} variant={variant} />);
    expect(lastButtonStyle()).toBe('glass');
  });

  it.each<ButtonVariant>(['tonal', 'outlined'])('%s is bordered inside a glass region', (variant) => {
    render(
      <ButtonSurfaceProvider surface="glass">
        <Button title="Refine" onPress={vi.fn()} variant={variant} />
      </ButtonSurfaceProvider>,
    );
    expect(lastButtonStyle()).toBe('bordered');
  });

  it('honours a per-button over="glass"', () => {
    render(<Button title="Clear" onPress={vi.fn()} variant="outlined" over="glass" />);
    expect(lastButtonStyle()).toBe('bordered');
  });

  it('keeps the filled CTA solid inside a glass region', () => {
    render(
      <ButtonSurfaceProvider surface="glass">
        <Button title="Save" onPress={vi.fn()} variant="filled" />
      </ButtonSurfaceProvider>,
    );
    expect(lastButtonStyle()).toBe('borderedProminent');
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
