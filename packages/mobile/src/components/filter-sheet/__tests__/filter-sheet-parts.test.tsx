// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const haptics = vi.hoisted(() => ({ selection: vi.fn() }));

type PressableProps = {
  children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityState?: { selected?: boolean; disabled?: boolean };
  accessibilityValue?: { text?: string };
  disabled?: boolean;
  style?: unknown;
};

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityState,
    accessibilityValue,
    disabled,
  }: PressableProps) =>
    createElement(
      'button',
      {
        onClick: disabled ? undefined : onPress,
        disabled,
        'aria-label': accessibilityLabel,
        'data-selected': String(!!accessibilityState?.selected),
        'data-value': accessibilityValue?.text,
      },
      typeof children === 'function' ? children({ pressed: false }) : children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  return { PressableSurface: Pressable };
});
vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: (component: unknown) => component },
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: (styleFactory: () => Record<string, unknown>) => styleFactory(),
  withSpring: (value: number) => value,
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#eee', tertiaryBackground: '#fff', tertiaryLabel: '#999' },
    brandColors: { primary: '#6D28D9', primaryFill: '#7C3AED', onPrimary: '#FFFFFF' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20 },
}));
vi.mock('../../../theme/animations', () => ({ springs: { snappy: {} } }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: haptics.selection }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) => (options?.name ? `${key}:${options.name}` : key),
  }),
}));

import { FilterChip } from '../FilterChip';
import { FilterLabelRow } from '../FilterLabelRow';
import { FilterSheetSection } from '../FilterSheetSection';
import { FilterTappableRow } from '../FilterTappableRow';
import { PinToggle } from '../../search/PinToggle';

beforeEach(() => {
  haptics.selection.mockClear();
});

describe('FilterChip', () => {
  it('hands its value back with a selection haptic', () => {
    const onPress = vi.fn();
    const { getByLabelText } = render(<FilterChip label="Sent" value="sent" selected={false} onPress={onPress} />);
    fireEvent.click(getByLabelText('Sent'));
    expect(onPress).toHaveBeenCalledWith('sent');
    expect(haptics.selection).toHaveBeenCalledTimes(1);
  });

  it('tells a screen reader which chip is selected', () => {
    const { getByLabelText } = render(
      <>
        <FilterChip label="Any" value={undefined} selected onPress={vi.fn()} />
        <FilterChip label="10+" value={10} selected={false} onPress={vi.fn()} />
      </>,
    );
    expect(getByLabelText('Any').getAttribute('data-selected')).toBe('true');
    expect(getByLabelText('10+').getAttribute('data-selected')).toBe('false');
  });
});

describe('PinToggle', () => {
  it('names the control it pins, and says unpin once pinned', () => {
    const onToggle = vi.fn();
    const { getByLabelText, rerender } = render(<PinToggle pinned={false} onToggle={onToggle} label="Grade range" />);
    fireEvent.click(getByLabelText('mobile.filter.pinChip:Grade range'));
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<PinToggle pinned onToggle={onToggle} label="Grade range" />);
    const pin = getByLabelText('mobile.filter.unpinChip:Grade range');
    expect(pin.getAttribute('data-selected')).toBe('true');
    expect(pin.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('pin.fill');
  });
});

describe('FilterLabelRow', () => {
  it('draws a pin only when the control is pinnable, named by its pin label', () => {
    const { container, getByLabelText, rerender } = render(<FilterLabelRow label="My rating" description="Stars" />);
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('My ratingStars');

    rerender(<FilterLabelRow label="Grade range" pinLabel="Grade" pinned onTogglePin={vi.fn()} />);
    expect(getByLabelText('mobile.filter.unpinChip:Grade')).toBeTruthy();
  });
});

describe('FilterSheetSection', () => {
  it('puts the pin beside the headline when the group is one control', () => {
    const onTogglePin = vi.fn();
    const { getByLabelText, getByText } = render(
      <FilterSheetSection title="Your progress" pinned={false} onTogglePin={onTogglePin}>
        <span>body</span>
      </FilterSheetSection>,
    );
    expect(getByText('body')).toBeTruthy();
    fireEvent.click(getByLabelText('mobile.filter.pinChip:Your progress'));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });
});

describe('FilterTappableRow', () => {
  it('reads its current choice as the value, and ignores taps while disabled', () => {
    const onPress = vi.fn();
    const { getByLabelText, rerender } = render(<FilterTappableRow label="Setters" value="None" onPress={onPress} />);
    const row = getByLabelText('Setters');
    expect(row.getAttribute('data-value')).toBe('None');
    fireEvent.click(row);
    expect(onPress).toHaveBeenCalledTimes(1);

    rerender(<FilterTappableRow label="Setters" value="None" onPress={onPress} disabled />);
    fireEvent.click(getByLabelText('Setters'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
