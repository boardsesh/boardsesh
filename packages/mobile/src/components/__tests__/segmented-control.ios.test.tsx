// @vitest-environment jsdom
// What the iOS SegmentedControl hands its @expo/ui `Host`. The native SwiftUI
// tree can't mount under vitest, so the `Host` is captured, not rendered. The
// SwiftUI side of `ignoreSafeArea` is upstream code this test takes on trust.
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostCalls = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  StyleSheet: { create: <T,>(styles: T) => styles },
  useWindowDimensions: () => ({ fontScale: 1, width: 390, height: 844 }),
}));
vi.mock('@expo/ui', () => ({
  Host: (props: Record<string, unknown> & { children?: ReactNode }) => {
    hostCalls.props.push(props);
    return createElement('div', null, props.children);
  },
}));
vi.mock('@expo/ui/swift-ui', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return { Picker: passthrough, Text: passthrough };
});
vi.mock('@expo/ui/swift-ui/modifiers', () => {
  const modifier =
    (kind: string) =>
    (...args: unknown[]) => ({ kind, args });
  return {
    pickerStyle: modifier('pickerStyle'),
    tint: modifier('tint'),
    tag: modifier('tag'),
    font: modifier('font'),
    accessibilityLabel: modifier('accessibilityLabel'),
  };
});
vi.mock('../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../navigation/ScrollableTabs', () => ({ ScrollableTabs: () => null }));
vi.mock('../../theme/expo-ui-modifiers', () => ({ brandAccentColor: () => '#6D28D9' }));
vi.mock('../../providers/theme-provider', async () => {
  const { makeThemeMock } = await import('../../test/theme-mock');
  const theme = makeThemeMock();
  return { useTheme: () => theme };
});

import { SegmentedControl } from '../SegmentedControl.ios';

describe('SegmentedControl.ios Host', () => {
  beforeEach(() => {
    hostCalls.props.length = 0;
  });

  it('ignores all safe areas so a keyboard cannot squeeze the picker', () => {
    render(
      createElement(SegmentedControl, {
        options: [
          { key: 'a', label: 'A' },
          { key: 'b', label: 'B' },
        ],
        selectedKey: 'a',
        onSelect: vi.fn(),
      }),
    );
    const props = hostCalls.props.at(-1);
    expect(props?.ignoreSafeArea).toBe('all');
    expect(props?.style).toMatchObject({ height: 40 });
  });
});
