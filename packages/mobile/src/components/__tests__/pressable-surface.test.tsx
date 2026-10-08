// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Controls the rendering branch under test.
const animatedStyles = vi.hoisted(() => new WeakSet<object>());
const ctrl = vi.hoisted(() => ({ os: 'ios' as string, reduceMotion: false, pressed: { value: 0 }, spring: vi.fn() }));

// Minimal RN surface: Pressable becomes a <button> that exposes whether it
// received an android_ripple config and forwards onPress as onClick.
vi.mock('../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => ctrl.reduceMotion }));
vi.mock('react-native', () => ({
  StyleSheet: { flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)) },
  Platform: {
    get OS() {
      return ctrl.os;
    },
  },
  Pressable: ({
    children,
    onPress,
    android_ripple,
    accessibilityRole,
    onPressIn,
    onPressOut,
    disabled,
    style,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    android_ripple?: { color: string } | null;
    accessibilityRole?: string;
    onPressIn?: () => void;
    onPressOut?: () => void;
    disabled?: boolean;
    style?: unknown;
  }) =>
    createElement(
      'button',
      {
        onClick: disabled ? undefined : onPress,
        onMouseDown: onPressIn,
        onMouseUp: onPressOut,
        disabled,
        'data-style': JSON.stringify(
          Object.assign(
            {},
            ...[style].flat(10).filter(Boolean),
            ...[style].flat(10).filter((entry) => entry && typeof entry === 'object' && animatedStyles.has(entry)),
          ),
        ),
        'data-has-ripple': android_ripple ? 'true' : 'false',
        'data-ripple-color': android_ripple?.color,
        'data-role': accessibilityRole,
      },
      children,
    ),
}));

vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: (component: unknown) => component },
  useAnimatedStyle: (callback: () => object) => {
    const result = callback();
    animatedStyles.add(result);
    return result;
  },
  useSharedValue: () => ctrl.pressed,
  withSpring: (value: number) => {
    ctrl.spring(value);
    return value;
  },
}));

vi.mock('../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  material: { disabledContentOpacity: 0.38 },
  androidRipple: (color: string, borderless = false) => ({ color, borderless }),
}));

vi.mock('../../theme/colors', () => ({
  brandColors: { tint: '#6D28D9' },
}));

vi.mock('../../theme/animations', () => ({
  springs: { snappy: {} },
}));

import { PressableSurface } from '../PressableSurface';

beforeEach(() => {
  ctrl.os = 'ios';
  ctrl.reduceMotion = false;
  ctrl.pressed.value = 0;
  ctrl.spring.mockClear();
});

describe('PressableSurface', () => {
  it('keeps caller rotation while applying feedback scale', () => {
    ctrl.pressed.value = 1;
    const { getByRole } = render(<PressableSurface style={{ transform: [{ rotate: '90deg' }] }}>x</PressableSurface>);
    expect(JSON.parse(getByRole('button').getAttribute('data-style') ?? '{}').transform).toEqual([
      { rotate: '90deg' },
      { scale: 0.96 },
    ]);
  });
  it('uses immediate opacity feedback instead of motion under Reduce Motion', () => {
    ctrl.reduceMotion = true;
    ctrl.pressed.value = 1;
    const { getByRole } = render(<PressableSurface style={{ opacity: 0.8 }}>x</PressableSurface>);
    const style = JSON.parse(getByRole('button').getAttribute('data-style') ?? '{}') as {
      opacity: number;
      transform?: unknown;
    };
    expect(style.opacity).toBeCloseTo(0.56);
    expect(style.transform).toEqual([{ scale: 1 }]);
    fireEvent.mouseDown(getByRole('button'));
    fireEvent.mouseUp(getByRole('button'));
    expect(ctrl.spring).not.toHaveBeenCalled();
  });
  it('suppresses activation while disabled', () => {
    const press = vi.fn();
    const { getByRole } = render(
      <PressableSurface disabled onPress={press}>
        x
      </PressableSurface>,
    );
    fireEvent.click(getByRole('button'));
    expect(press).not.toHaveBeenCalled();
  });
  it('uses a Material ripple on Android', () => {
    ctrl.os = 'android';
    const { container } = render(<PressableSurface>x</PressableSurface>);
    expect(container.querySelector('[data-has-ripple="true"]')).not.toBeNull();
  });

  it('defaults the Android ripple to the brand tint', () => {
    ctrl.os = 'android';
    const { container } = render(<PressableSurface>x</PressableSurface>);
    expect(container.querySelector('[data-ripple-color="#6D28D9"]')).not.toBeNull();
  });

  it('honours an explicit rippleColor on Android', () => {
    ctrl.os = 'android';
    const { container } = render(<PressableSurface rippleColor="#FF3B30">x</PressableSurface>);
    expect(container.querySelector('[data-ripple-color="#FF3B30"]')).not.toBeNull();
  });

  it('still ripples on Android when feedback is none (ripple is platform feedback)', () => {
    ctrl.os = 'android';
    const { container } = render(<PressableSurface feedback="none">x</PressableSurface>);
    expect(container.querySelector('[data-has-ripple="true"]')).not.toBeNull();
  });

  it('uses the reanimated path (no ripple) on iOS', () => {
    ctrl.os = 'ios';
    const { container } = render(<PressableSurface>x</PressableSurface>);
    expect(container.querySelector('[data-has-ripple="false"]')).not.toBeNull();
  });

  it('fires onPress on both platforms', () => {
    const onPress = vi.fn();
    ctrl.os = 'android';
    const { getByRole } = render(<PressableSurface onPress={onPress}>x</PressableSurface>);
    fireEvent.click(getByRole('button'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

it('retains disabled dimming with Reanimated precedence, and resets feedback properties', () => {
  ctrl.os = 'ios';
  ctrl.reduceMotion = true;
  ctrl.pressed.value = 1;
  const screen = render(
    <PressableSurface disabled style={{ opacity: 0.8, transform: [{ rotate: '10deg' }] }}>
      x
    </PressableSurface>,
  );
  const read = () =>
    JSON.parse(screen.getByRole('button').getAttribute('data-style') ?? '{}') as {
      opacity: number;
      transform: unknown;
    };
  expect(read().opacity).toBeCloseTo(0.4);
  expect(read().transform).toEqual([{ rotate: '10deg' }, { scale: 1 }]);
  ctrl.reduceMotion = false;
  screen.rerender(
    <PressableSurface feedback="none" style={{ opacity: 0.8, transform: [{ rotate: '10deg' }] }}>
      x
    </PressableSurface>,
  );
  expect(read().opacity).toBe(0.8);
  expect(read().transform).toEqual([{ rotate: '10deg' }, { scale: 1 }]);
  screen.rerender(
    <PressableSurface feedback="scale" style={{ opacity: 0.8 }}>
      x
    </PressableSurface>,
  );
  expect(read().opacity).toBe(0.8);
  expect(read().transform).toEqual([{ scale: 0.96 }]);
  screen.rerender(
    <PressableSurface feedback="opacity" style={{ opacity: 0.8 }}>
      x
    </PressableSurface>,
  );
  expect(read().opacity).toBeCloseTo(0.56);
  expect(read().transform).toEqual([{ scale: 1 }]);
});
