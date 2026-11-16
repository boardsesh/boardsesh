// @vitest-environment jsdom
vi.mock('../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
const bold = vi.hoisted(() => ({ enabled: false }));
vi.mock('../../hooks/use-bold-text', () => ({ useBoldText: () => bold.enabled }));
vi.mock('../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// HIG Typography: a number that changes in place uses tabular figures, so every
// digit has the same advance and the value doesn't jitter sideways (the angle
// readout while the slider drags, a stepper, a leaderboard column).

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
}
const resolveWeight = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Text: ({
    children,
    style,
    maxFontSizeMultiplier,
  }: {
    children?: ReactNode;
    style?: unknown;
    maxFontSizeMultiplier?: number;
  }) =>
    createElement(
      'span',
      {
        'data-font-variant': JSON.stringify(flatten(style).fontVariant ?? null),
        'data-weight': flatten(style).fontWeight,
        'data-scale-cap': maxFontSizeMultiplier,
      },
      children,
    ),
  StyleSheet: {
    create: <T,>(styles: T): T => styles,
    flatten: (style: unknown) => {
      resolveWeight();
      return flatten(style);
    },
  },
}));
vi.mock('../../providers/theme-provider', () => ({ useOptionalTheme: () => null }));

import { Text } from '../Text';

beforeEach(() => {
  bold.enabled = false;
  resolveWeight.mockClear();
});

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

it('uses full Dynamic Type by default and honors an explicit chrome cap', () => {
  const { getByText } = render(
    <>
      <Text>Full</Text>
      <Text maxFontSizeMultiplier={1}>Chrome</Text>
    </>,
  );
  expect(getByText('Full').getAttribute('data-scale-cap')).toBe('0');
  expect(getByText('Chrome').getAttribute('data-scale-cap')).toBe('1');
});
it('strengthens the final caller weight when Bold Text is enabled', () => {
  bold.enabled = true;
  const { getByText } = render(<Text style={{ fontWeight: '600' }}>Bold</Text>);
  expect(getByText('Bold').getAttribute('data-weight')).toBe('700');
  bold.enabled = false;
});

it('avoids resolving ordinary weights and responds immediately to Bold Text changes', () => {
  const style = [{ fontWeight: '400' as const }, [{ fontWeight: '600' as const }]];
  const screen = render(
    <Text numeric style={style}>
      Toggle
    </Text>,
  );
  expect(screen.getByText('Toggle').getAttribute('data-weight')).toBe('600');
  expect(resolveWeight).not.toHaveBeenCalled();
  bold.enabled = true;
  screen.rerender(
    <Text numeric style={style}>
      Toggle
    </Text>,
  );
  expect(screen.getByText('Toggle').getAttribute('data-weight')).toBe('700');
  expect(resolveWeight).toHaveBeenCalledTimes(1);
  bold.enabled = false;
  screen.rerender(
    <Text numeric style={style}>
      Toggle
    </Text>,
  );
  expect(screen.getByText('Toggle').getAttribute('data-weight')).toBe('600');
  expect(screen.getByText('Toggle').getAttribute('data-font-variant')).toBe('["tabular-nums"]');
  expect(resolveWeight).toHaveBeenCalledTimes(1);
});
