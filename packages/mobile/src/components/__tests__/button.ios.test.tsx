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

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@expo/ui', () => ({
  Host: (props: Record<string, unknown> & { children?: ReactNode }) => {
    hostCalls.props.push(props);
    return createElement('div', null, props.children);
  },
}));
vi.mock('@expo/ui/swift-ui', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return { Button: passthrough, HStack: passthrough, Image: () => null, ProgressView: () => null, Text: passthrough };
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
import type { ButtonVariant } from '../Button.types';

function lastHostProps(): Record<string, unknown> {
  const props = hostCalls.props.at(-1);
  if (!props) throw new Error('Host was never rendered');
  return props;
}

beforeEach(() => {
  hostCalls.props = [];
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
