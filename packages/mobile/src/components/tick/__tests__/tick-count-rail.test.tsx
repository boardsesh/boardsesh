// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type LayoutEvent = { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } };

const haptics = vi.hoisted(() => ({ selection: vi.fn() }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  PlatformColor: (name: string) => name,
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  ScrollView: ({
    children,
    accessibilityLabel,
    scrollEnabled,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    scrollEnabled?: boolean;
  }) =>
    createElement(
      'div',
      {
        'data-scroll': 'true',
        'data-label': accessibilityLabel,
        'data-scroll-enabled': scrollEnabled === false ? 'false' : 'true',
      },
      children,
    ),
}));

// The chip's own painting is GradeChip's business (covered by its colourway
// test); here it only has to report what the rail handed it.
vi.mock('../TickChip', () => ({
  TickChip: ({
    label,
    tone,
    onPress,
    accessibilityLabel,
    accessibilityState,
    onLayout,
  }: {
    label: string;
    tone?: string;
    onPress: () => void;
    accessibilityLabel: string;
    accessibilityState?: { selected?: boolean };
    onLayout?: (event: LayoutEvent) => void;
  }) =>
    createElement(
      'button',
      {
        'data-label': label,
        'data-tone': tone ?? 'neutral',
        'data-a11y-label': accessibilityLabel,
        'data-selected': accessibilityState?.selected ? 'true' : 'false',
        'data-has-layout': onLayout ? 'true' : 'false',
        onClick: onPress,
      },
      label,
    ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count == null ? key : `${key}:${options.count}`),
  }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticSelection: haptics.selection }));

vi.mock('../../../providers/theme-provider', async () => {
  const { makeThemeMock } = await import('../../../test/theme-mock');
  const theme = makeThemeMock();
  return { useTheme: () => theme };
});

import { TickCountRail } from '../TickCountRail';
import { TICK_COUNT_RAIL_MIN_CHIPS } from '../tick-sheet-metrics';

function renderRail(overrides: Partial<Parameters<typeof TickCountRail>[0]> = {}) {
  const onSelect = vi.fn();
  const utils = render(
    createElement(TickCountRail, {
      value: 1,
      onSelect,
      accessibilityLabel: 'Tries',
      ...overrides,
    }),
  );
  const chips = () => [...utils.container.querySelectorAll('button')];
  return { ...utils, onSelect, chips };
}

describe('TickCountRail', () => {
  beforeEach(() => {
    haptics.selection.mockClear();
  });

  it('offers the common range plus a chip to go beyond it', () => {
    const { chips } = renderRail();

    const labels = chips().map((chip) => chip.getAttribute('data-label'));
    expect(labels).toEqual([...Array.from({ length: TICK_COUNT_RAIL_MIN_CHIPS }, (_, i) => String(i + 1)), '+']);
  });

  it('grows the range to reach a count above the common range', () => {
    const { chips } = renderRail({ value: 22 });

    const labels = chips().map((chip) => chip.getAttribute('data-label'));
    expect(labels).toHaveLength(23);
    expect(labels.at(-2)).toBe('22');
    expect(labels.at(-1)).toBe('+');
  });

  it('sets any visible count in one tap', () => {
    const { chips, onSelect } = renderRail({ value: 2 });

    fireEvent.click(chips()[6]);

    expect(onSelect).toHaveBeenCalledWith(7);
    expect(haptics.selection).toHaveBeenCalledTimes(1);
  });

  it('walks one past the rendered range from the trailing chip', () => {
    const { chips, onSelect } = renderRail({ value: 4 });

    fireEvent.click(chips().at(-1) as HTMLElement);

    expect(onSelect).toHaveBeenCalledWith(5);
  });

  it('marks the selected count for assistive tech', () => {
    const { chips } = renderRail({ value: 3 });

    const selected = chips().filter((chip) => chip.getAttribute('data-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute('data-label')).toBe('3');
    expect(selected[0].getAttribute('data-tone')).toBe('selected');
    expect(selected[0].getAttribute('data-a11y-label')).toBe('mobile.tick.setTriesAria:3');
  });

  it('blocks every press while disabled', () => {
    const { chips, onSelect, container } = renderRail({ value: 2, disabled: true });

    for (const chip of chips()) fireEvent.click(chip);

    expect(onSelect).not.toHaveBeenCalled();
    expect(haptics.selection).not.toHaveBeenCalled();
    expect(container.querySelector('[data-scroll]')?.getAttribute('data-scroll-enabled')).toBe('false');
  });

  it('names the rail for assistive tech', () => {
    const { container } = renderRail();

    expect(container.querySelector('[data-scroll]')?.getAttribute('data-label')).toBe('Tries');
  });
});
