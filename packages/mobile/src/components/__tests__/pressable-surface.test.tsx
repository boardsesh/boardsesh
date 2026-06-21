// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Controls the rendering branch under test.
const ctrl = vi.hoisted(() => ({ os: 'ios' as string }));

// Minimal RN surface: Pressable becomes a <button> that exposes whether it
// received an android_ripple config and forwards onPress as onClick.
vi.mock('react-native', () => ({
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
  }: {
    children?: ReactNode;
    onPress?: () => void;
    android_ripple?: { color: string } | null;
    accessibilityRole?: string;
  }) =>
    createElement(
      'button',
      {
        onClick: onPress,
        'data-has-ripple': android_ripple ? 'true' : 'false',
        'data-ripple-color': android_ripple?.color,
        'data-role': accessibilityRole,
      },
      children,
    ),
}));

vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: (component: unknown) => component },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: number) => ({ value }),
  withSpring: (value: number) => value,
}));

vi.mock('../../theme/tokens', () => ({
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
});

describe('PressableSurface', () => {
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
