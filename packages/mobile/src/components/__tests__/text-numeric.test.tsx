// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// HIG Typography: a number that changes in place uses tabular figures, so every
// digit has the same advance and the value doesn't jitter sideways (the angle
// readout while the slider drags, a stepper, a leaderboard column).

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
}

vi.mock('react-native', () => ({
  Text: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('span', { 'data-font-variant': JSON.stringify(flatten(style).fontVariant ?? null) }, children),
  StyleSheet: { create: <T,>(styles: T): T => styles },
}));
vi.mock('../../providers/theme-provider', () => ({ useOptionalTheme: () => null }));

import { Text } from '../Text';

describe('Text numeric', () => {
  it('sets tabular figures when numeric', () => {
    const { getByText } = render(<Text numeric>45°</Text>);
    expect(getByText('45°').getAttribute('data-font-variant')).toBe('["tabular-nums"]');
  });

  it('leaves proportional figures on ordinary text', () => {
    const { getByText } = render(<Text>Sends</Text>);
    expect(getByText('Sends').getAttribute('data-font-variant')).toBe('null');
  });

  it("lets a caller's own style still override it", () => {
    const { getByText } = render(
      <Text numeric style={{ fontVariant: ['lining-nums'] }}>
        12
      </Text>,
    );
    expect(getByText('12').getAttribute('data-font-variant')).toBe('["lining-nums"]');
  });
});
