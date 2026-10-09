// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, useState, type ReactNode, type Ref } from 'react';

// Controls the rendering branch under test.
const animatedStyles = vi.hoisted(() => new WeakSet<object>());
const ctrl = vi.hoisted(() => ({
  os: 'ios' as string,
  reduceMotion: false,
  pressed: { value: 0 },
  spring: vi.fn(),
  sharedValue: vi.fn(),
  animatedStyle: vi.fn(),
  motionSubscription: vi.fn(),
}));

// Minimal RN surface: Pressable becomes a <button> that exposes whether it
// received an android_ripple config and forwards onPress as onClick.
vi.mock('../../hooks/use-reduce-motion', () => ({
  useReduceMotion: () => {
    ctrl.motionSubscription();
    return ctrl.reduceMotion;
  },
}));
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
    ref,
    accessibilityState,
    accessibilityLabel,
    hitSlop,
  }: {
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    onPress?: () => void;
    android_ripple?: { color: string } | null;
    accessibilityRole?: string;
    onPressIn?: () => void;
    onPressOut?: () => void;
    disabled?: boolean;
    style?: unknown;
    ref?: Ref<HTMLButtonElement>;
    accessibilityState?: object;
    accessibilityLabel?: string;
    hitSlop?: unknown;
  }) => {
    const [pressed, setPressed] = useState(false);
    const resolvedStyle = typeof style === 'function' ? style({ pressed }) : style;
    return createElement(
      'button',
      {
        ref,
        onClick: disabled ? undefined : onPress,
        onMouseDown: disabled
          ? undefined
          : () => {
              setPressed(true);
              onPressIn?.();
            },
        onMouseUp: () => {
          setPressed(false);
          onPressOut?.();
        },
        disabled,
        'data-state': JSON.stringify(accessibilityState),
        'data-label': accessibilityLabel,
        'data-hit-slop': JSON.stringify(hitSlop),
        'data-style': JSON.stringify(
          Object.assign(
            {},
            ...[resolvedStyle].flat(10).filter(Boolean),
            ...[resolvedStyle]
              .flat(10)
              .filter((entry) => entry && typeof entry === 'object' && animatedStyles.has(entry)),
          ),
        ),
        'data-has-ripple': android_ripple ? 'true' : 'false',
        'data-ripple-color': android_ripple?.color,
        'data-role': accessibilityRole,
      },
      typeof children === 'function' ? children({ pressed }) : children,
    );
  },
}));

vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: (component: unknown) => component },
  useAnimatedStyle: (callback: () => object) => {
    ctrl.animatedStyle();
    const result = callback();
    animatedStyles.add(result);
    return result;
  },
  useSharedValue: () => {
    ctrl.sharedValue();
    return ctrl.pressed;
  },
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

import { PressableSurface, StaticPressableSurface } from '../PressableSurface';

beforeEach(() => {
  ctrl.os = 'ios';
  ctrl.reduceMotion = false;
  ctrl.pressed.value = 0;
  vi.clearAllMocks();
});

describe('PressableSurface', () => {
  it('keeps the iOS press target and ref through live feedback-mode changes', () => {
    const ref = { current: null };
    const onPress = vi.fn();
    const onPressIn = vi.fn();
    const onPressOut = vi.fn();
    const screen = render(
      <PressableSurface ref={ref} onPress={onPress} onPressIn={onPressIn} onPressOut={onPressOut}>
        Touch
      </PressableSurface>,
    );
    const target = screen.getByRole('button');
    fireEvent.mouseDown(target);
    for (const feedback of ['none', 'opacity', 'scale'] as const) {
      screen.rerender(
        <PressableSurface ref={ref} feedback={feedback} onPress={onPress} onPressIn={onPressIn} onPressOut={onPressOut}>
          Touch
        </PressableSurface>,
      );
      expect(screen.getByRole('button')).toBe(target);
      expect(ref.current).toBe(target);
    }
    fireEvent.mouseUp(target);
    fireEvent.click(target);
    expect(onPressIn).toHaveBeenCalledTimes(1);
    expect(onPressOut).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('allocates no animation or motion subscription for the Android native path', () => {
    ctrl.os = 'android';
    const screen = render(<PressableSurface>Native</PressableSurface>);
    fireEvent.mouseDown(screen.getByRole('button'));
    fireEvent.mouseUp(screen.getByRole('button'));
    screen.rerender(<PressableSurface feedback="none">Native</PressableSurface>);
    expect(ctrl.sharedValue).not.toHaveBeenCalled();
    expect(ctrl.animatedStyle).not.toHaveBeenCalled();
    expect(ctrl.motionSubscription).not.toHaveBeenCalled();
    expect(ctrl.spring).not.toHaveBeenCalled();
  });
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

describe('StaticPressableSurface', () => {
  it('keeps native callback styles, child callbacks, refs and press events without animations', () => {
    const ref = { current: null };
    const onPress = vi.fn();
    const onPressIn = vi.fn();
    const onPressOut = vi.fn();
    const screen = render(
      <StaticPressableSurface
        ref={ref}
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        hitSlop={8}
        accessibilityLabel="Add to queue"
        accessibilityState={{ selected: true }}
        style={({ pressed }) => ({ opacity: pressed ? 0.4 : 0.8, transform: [{ rotate: '10deg' }] })}
      >
        {({ pressed }) => (pressed ? 'Pressed' : 'Resting')}
      </StaticPressableSurface>,
    );
    const target = screen.getByRole('button');
    expect(ref.current).toBe(target);
    expect(target.getAttribute('data-label')).toBe('Add to queue');
    expect(target.getAttribute('data-hit-slop')).toBe('8');
    expect(JSON.parse(target.getAttribute('data-state') ?? '{}')).toEqual({ selected: true });
    fireEvent.mouseDown(target);
    expect(target.textContent).toBe('Pressed');
    expect(JSON.parse(target.getAttribute('data-style') ?? '{}')).toEqual({
      opacity: 0.4,
      transform: [{ rotate: '10deg' }],
    });
    fireEvent.mouseUp(target);
    fireEvent.click(target);
    expect(target.textContent).toBe('Resting');
    expect(onPressIn).toHaveBeenCalledTimes(1);
    expect(onPressOut).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(ctrl.sharedValue).not.toHaveBeenCalled();
    expect(ctrl.animatedStyle).not.toHaveBeenCalled();
    expect(ctrl.motionSubscription).not.toHaveBeenCalled();
  });

  it.each([
    ['ios', 0.4],
    ['android', 0.38],
  ])('preserves %s disabled dimming with callback styles', (platform, expectedOpacity) => {
    ctrl.os = platform;
    const onPress = vi.fn();
    const screen = render(
      <StaticPressableSurface disabled onPress={onPress} style={() => ({ opacity: 0.8 })}>
        Disabled
      </StaticPressableSurface>,
    );
    const target = screen.getByRole('button');
    expect(JSON.parse(target.getAttribute('data-style') ?? '{}').opacity).toBe(expectedOpacity);
    fireEvent.click(target);
    expect(onPress).not.toHaveBeenCalled();
    expect(JSON.parse(target.getAttribute('data-state') ?? '{}').disabled).toBe(true);
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
