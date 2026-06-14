// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type ViewMockProps = {
  children?: ReactNode;
  onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
  pointerEvents?: string;
};
vi.mock('react-native', () => ({
  View: ({ children, onLayout, pointerEvents }: ViewMockProps) =>
    createElement(
      'div',
      {
        'data-has-layout': onLayout ? 'true' : 'false',
        'data-pointer': pointerEvents ?? '',
        onClick: onLayout ? () => onLayout({ nativeEvent: { layout: { height: 72 } } }) : undefined,
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-gradient': 'true' }, children),
}));
// useAnimatedReaction is a no-op so `collapsed` stays false; the collapsed title
// capsule never mounts but the centre-content fade wrapper always does.
vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children, pointerEvents }: { children?: ReactNode; pointerEvents?: string }) =>
      createElement('div', { 'data-animated-view': 'true', 'data-pointer': pointerEvents ?? '' }, children),
  },
  Extrapolation: { CLAMP: 'clamp' },
  interpolate: () => 0,
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  useAnimatedReaction: () => {},
  useAnimatedStyle: () => ({}),
  useDerivedValue: () => ({ value: 0 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      label: '#000',
      separator: '#ccc',
      elevatedSurface: '#fff',
      background: '#fff',
    },
  }),
}));
vi.mock('../../../hooks/use-native-glass', () => ({ useNativeGlass: () => false }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 4: 16 }, shadows: { sm: {} } }));
vi.mock('../GlassActionToolbar', () => ({ TOP_ACTION_SIZE: 48 }));
vi.mock('../../GlassSurface', () => ({ GlassSurface: () => createElement('div', { 'data-glass': 'true' }) }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'data-pressable': accessibilityLabel ?? '' }, children),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

import { CollapsingLargeTitleHeader } from '../CollapsingLargeTitleHeader';

const scrollY = { value: 0 } as unknown as Parameters<typeof CollapsingLargeTitleHeader>[0]['scrollY'];

function makeProps(over: Partial<Parameters<typeof CollapsingLargeTitleHeader>[0]> = {}) {
  return {
    title: 'You',
    scrollY,
    onPressTitle: vi.fn(),
    onHeightChange: vi.fn(),
    ...over,
  };
}

describe('CollapsingLargeTitleHeader', () => {
  it('renders the leftActions / rightActions / centerContent / children slots when provided', () => {
    const { container } = render(
      <CollapsingLargeTitleHeader
        {...makeProps({
          leftActions: createElement('div', { 'data-testid': 'left' }),
          rightActions: createElement('div', { 'data-testid': 'right' }),
          centerContent: createElement('div', { 'data-testid': 'center' }),
        })}
      >
        {createElement('div', { 'data-testid': 'children' })}
      </CollapsingLargeTitleHeader>,
    );

    expect(container.querySelector('[data-testid="left"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="right"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="center"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="children"]')).not.toBeNull();
  });

  it('omits the leftActions / rightActions / centerContent / children slots when not provided', () => {
    const { container } = render(<CollapsingLargeTitleHeader {...makeProps()} />);

    expect(container.querySelector('[data-testid="left"]')).toBeNull();
    expect(container.querySelector('[data-testid="right"]')).toBeNull();
    expect(container.querySelector('[data-testid="center"]')).toBeNull();
    expect(container.querySelector('[data-testid="children"]')).toBeNull();
  });

  it('wraps centerContent in an animated fade wrapper (so it fades out as the title takes over)', () => {
    const { container } = render(
      <CollapsingLargeTitleHeader
        {...makeProps({ centerContent: createElement('div', { 'data-testid': 'center' }) })}
      />,
    );

    const fadeWrapper = container.querySelector('[data-animated-view="true"]');
    expect(fadeWrapper).not.toBeNull();
    expect(fadeWrapper?.querySelector('[data-testid="center"]')).not.toBeNull();
  });

  it('renders persistent center content instead of the fading center content', () => {
    const { container } = render(
      <CollapsingLargeTitleHeader
        {...makeProps({
          centerContent: createElement('div', { 'data-testid': 'center' }),
          persistentCenterContent: createElement('div', { 'data-testid': 'timer' }),
        })}
      />,
    );

    expect(container.querySelector('[data-testid="timer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="center"]')).toBeNull();
    expect(container.querySelector('[data-animated-view="true"]')).toBeNull();
  });

  it('renders the title capsule before collapse when persistentTitle is set', () => {
    const { container } = render(<CollapsingLargeTitleHeader {...makeProps({ persistentTitle: true })} />);

    expect(container.querySelector('[data-pressable="You"]')).not.toBeNull();
  });

  it('does not render the collapsed title capsule while collapsed is false', () => {
    const { container } = render(<CollapsingLargeTitleHeader {...makeProps({ title: 'You' })} />);

    // The capsule mounts a PressableSurface labelled by the title; with the
    // reaction mocked no-op, `collapsed` stays false so it never renders.
    expect(container.querySelector('[data-pressable="You"]')).toBeNull();
  });

  it('reports its measured height through onHeightChange (container onLayout)', () => {
    const onHeightChange = vi.fn();
    const { container } = render(<CollapsingLargeTitleHeader {...makeProps({ onHeightChange })} />);

    fireEvent.click(container.querySelector('[data-has-layout="true"]') as HTMLElement);
    expect(onHeightChange).toHaveBeenCalledWith(72);
  });
});
