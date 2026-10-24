// @vitest-environment jsdom
// The filter chip's disabled state: a choice that does not apply (a climb bias
// signed out) is dimmed, says so to VoiceOver and does nothing when tapped, on
// both the Liquid Glass pill and the Material Paper chip.
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type StyleEntry = Record<string, unknown> | null | undefined;
const theme = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));

vi.mock('react-native', () => ({
  DynamicColorIOS: (colors: unknown) => colors,
  Platform: { OS: 'ios', select: (choices: { ios?: unknown }) => choices.ios },
  PlatformColor: (name: string) => name,
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
    accessibilityState,
    style,
  }: {
    children?: ReactNode;
    onPress: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    accessibilityState?: { selected?: boolean; disabled?: boolean };
    style?: StyleEntry[];
  }) => {
    const flatStyle = Object.assign({}, ...(style ?? []));
    return createElement(
      'button',
      {
        onClick: onPress,
        disabled,
        'aria-label': accessibilityLabel,
        'aria-disabled': accessibilityState?.disabled,
        'data-opacity': String(flatStyle.opacity),
      },
      children,
    );
  },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: <T,>(component: T) => component },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: number) => ({ value }),
  withSpring: (value: number) => value,
}));
vi.mock('react-native-paper', () => ({
  Chip: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children),
}));
vi.mock('../../../Stepper', () => ({ Stepper: () => null }));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../queue-control/RestLengthPicker', () => ({ RestLengthPicker: () => null }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, variant: theme.variant, m3: {} }),
}));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));

import { opacity } from '../../../../theme/tokens';
import { Chip } from '../generator-controls';

const onPress = vi.fn();

function renderChip(disabled?: boolean) {
  render(
    createElement(Chip, { label: 'Sent', selected: false, onPress, accessibilityLabel: 'Climb bias, Sent', disabled }),
  );
  return screen.getByRole('button', { name: 'Climb bias, Sent' }) as HTMLButtonElement;
}

beforeEach(() => {
  onPress.mockClear();
});

describe('Chip on Liquid Glass', () => {
  beforeEach(() => {
    theme.variant = 'liquidGlass';
  });

  it('is dimmed, reads as disabled and ignores a tap when disabled', () => {
    const chip = renderChip(true);

    expect(chip.disabled).toBe(true);
    expect(chip.getAttribute('aria-disabled')).toBe('true');
    expect(chip.dataset.opacity).toBe(String(opacity.disabled));
    fireEvent.click(chip);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('is full strength and pressable by default', () => {
    const chip = renderChip();

    expect(chip.disabled).toBe(false);
    expect(chip.dataset.opacity).toBe('1');
    fireEvent.click(chip);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('Chip on Material', () => {
  beforeEach(() => {
    theme.variant = 'material';
  });

  it('hands disabled to the Paper chip', () => {
    const chip = renderChip(true);

    expect(chip.disabled).toBe(true);
    fireEvent.click(chip);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('stays pressable by default', () => {
    fireEvent.click(renderChip());

    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
