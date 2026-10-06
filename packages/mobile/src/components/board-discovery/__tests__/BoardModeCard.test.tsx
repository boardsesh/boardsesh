// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// #5960: five tiles share the picker row, so the label may wrap to two lines,
// and the tile announces its label rather than the glyph's symbol name.

type TextMockProps = { children?: ReactNode; numberOfLines?: number; minimumFontScale?: number };
vi.mock('react-native', () => ({
  Pressable: ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) =>
    createElement('button', { 'aria-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: (component: unknown) => component },
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: () => ({}),
  withSpring: (value: number) => value,
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../theme/animations', () => ({ springs: { snappy: {} } }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8 }, borderRadius: { lg: 12 } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryBackground: '#111', separator: '#222', secondaryLabel: '#888' },
    brandColors: { primary: '#6D28D9', success: '#047857' },
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, numberOfLines, minimumFontScale }: TextMockProps) =>
    createElement(
      'span',
      { 'data-lines': String(numberOfLines), 'data-min-scale': String(minimumFontScale ?? '') },
      children,
    ),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', null, name) }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));

import { BoardModeCard, modeCardAccessibilityLabel } from '../BoardModeCard';

describe('BoardModeCard', () => {
  it('announces the label, not the glyph name', () => {
    const { getByRole } = render(<BoardModeCard icon="camera" label="Spray wall" onPress={() => {}} />);
    expect(getByRole('button').getAttribute('aria-label')).toBe('Spray wall');
  });

  it('adds the status line to the announcement when there is one', () => {
    expect(modeCardAccessibilityLabel('Find nearby', 'Allow location')).toBe('Find nearby, Allow location');
  });

  it('lets the label wrap to two lines, shrinking no further than caption size', () => {
    const { getByText } = render(<BoardModeCard icon="bluetooth" label="Bluetooth" onPress={() => {}} />);
    const label = getByText('Bluetooth');
    expect(label.getAttribute('data-lines')).toBe('2');
    expect(Number(label.getAttribute('data-min-scale'))).toBeGreaterThanOrEqual(11 / 12);
  });
});
