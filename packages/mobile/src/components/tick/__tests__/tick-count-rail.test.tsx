// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { createElement, forwardRef, useImperativeHandle, type ReactNode } from 'react';

type Layout = { x: number; y: number; width: number; height: number };
type LayoutEvent = { nativeEvent: { layout: Layout } };

const haptics = vi.hoisted(() => ({ selection: vi.fn() }));

/**
 * The rail's rest position is the thing under test in the re-centring specs, and
 * it is only observable through the imperative `scrollTo` on the ScrollView ref.
 * So the mock is a real forwardRef that hands back a spy, and it parks its own
 * props so a test can drive the measurement pass (`onLayout`,
 * `onContentSizeChange`) that native would otherwise run.
 */
const rail = vi.hoisted(() => ({
  scrollTo: vi.fn(),
  scrollProps: null as Record<string, unknown> | null,
  chipLayout: new Map<number, (event: LayoutEvent) => void>(),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  PlatformColor: (name: string) => name,
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  ScrollView: forwardRef(function MockScrollView(
    props: {
      children?: ReactNode;
      accessibilityLabel?: string;
      scrollEnabled?: boolean;
      onScrollBeginDrag?: () => void;
    },
    ref: unknown,
  ) {
    rail.scrollProps = props as unknown as Record<string, unknown>;
    useImperativeHandle(ref as Parameters<typeof useImperativeHandle>[0], () => ({ scrollTo: rail.scrollTo }), []);
    return createElement(
      'div',
      {
        'data-scroll': 'true',
        'data-label': props.accessibilityLabel,
        'data-scroll-enabled': props.scrollEnabled === false ? 'false' : 'true',
      },
      props.children,
    );
  }),
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
    accessibilityState?: { selected?: boolean; disabled?: boolean };
    onLayout?: (event: LayoutEvent) => void;
  }) => {
    const count = Number(label);
    if (onLayout && Number.isFinite(count)) rail.chipLayout.set(count, onLayout);
    return createElement(
      'button',
      {
        'data-label': label,
        'data-tone': tone ?? 'neutral',
        'data-a11y-label': accessibilityLabel,
        'data-selected': accessibilityState?.selected ? 'true' : 'false',
        'data-disabled': accessibilityState?.disabled ? 'true' : 'false',
        'data-has-layout': onLayout ? 'true' : 'false',
        onClick: onPress,
      },
      label,
    );
  },
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

/** Chip geometry the fake measurement pass reports. Pitch > width so a snap
 *  offset is distinguishable from a chip's own x. */
const CHIP_WIDTH = 52;
const CHIP_PITCH = 60;
const RAIL_WIDTH = 300;
const CONTENT_WIDTH = TICK_COUNT_RAIL_MIN_CHIPS * CHIP_PITCH + 24;

function renderRail(overrides: Partial<Parameters<typeof TickCountRail>[0]> = {}) {
  const onSelect = vi.fn();
  const props = { value: 1, onSelect, accessibilityLabel: 'Tries', ...overrides };
  const utils = render(createElement(TickCountRail, props));
  const chips = () => [...utils.container.querySelectorAll('button')];
  /** A new count arriving from the parent — a new climb loaded into a sheet the
   *  player keeps mounted, not a tap on this rail. */
  const setValue = (next: number) => utils.rerender(createElement(TickCountRail, { ...props, value: next }));
  return { ...utils, onSelect, chips, setValue };
}

/** Run the measurement pass native would run: every chip reports its box, then
 *  the rail its viewport, then the content its width. */
function measure({ contentWidth = CONTENT_WIDTH }: { contentWidth?: number } = {}) {
  const onRailLayout = rail.scrollProps?.onLayout as (event: LayoutEvent) => void;
  const onContentSizeChange = rail.scrollProps?.onContentSizeChange as (width: number, height: number) => void;
  act(() => {
    for (const [count, onChipLayout] of rail.chipLayout) {
      onChipLayout({ nativeEvent: { layout: { x: (count - 1) * CHIP_PITCH, y: 0, width: CHIP_WIDTH, height: 44 } } });
    }
    onRailLayout({ nativeEvent: { layout: { x: 0, y: 0, width: RAIL_WIDTH, height: 60 } } });
    onContentSizeChange(contentWidth, 60);
  });
}

describe('TickCountRail', () => {
  beforeEach(() => {
    haptics.selection.mockClear();
    rail.scrollTo.mockClear();
    rail.scrollProps = null;
    rail.chipLayout.clear();
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

  it('marks every chip disabled for assistive tech while the row is inert', () => {
    const inert = renderRail({ value: 2, disabled: true });
    expect(inert.chips().map((chip) => chip.getAttribute('data-disabled'))).not.toContain('false');

    const live = renderRail({ value: 2 });
    expect(live.chips().map((chip) => chip.getAttribute('data-disabled'))).not.toContain('true');
  });

  it('rests on the selected count once the rail has been measured', () => {
    renderRail({ value: 12 });

    measure();

    // Chip 12 starts at 660; centring it in a 300pt viewport wants 536, which
    // snaps DOWN to the nearest chip start (480) so the rail never rests mid-chip.
    expect(rail.scrollTo.mock.calls.at(-1)?.[0]).toEqual({ x: 480, animated: false });
  });

  it('holds its position after the climber has scrolled it, while the count is theirs', () => {
    const { chips, setValue } = renderRail({ value: 1 });
    measure();

    fireEvent.click(chips()[6]);
    rail.scrollTo.mockClear();
    setValue(7);
    // A re-measure must not yank the rail out from under the thumb either.
    measure({ contentWidth: CONTENT_WIDTH + 40 });

    expect(rail.scrollTo).not.toHaveBeenCalled();
  });

  it('re-centres when a count arrives from outside, even after the climber has touched it', () => {
    // PlayDrawer keeps LogAscentSheet mounted for the life of the player, so
    // this rail is NOT remounted between climbs: without clearing the latch the
    // next climb opens parked on the previous climb's scroll position.
    const { chips, setValue } = renderRail({ value: 1 });
    measure();

    fireEvent.click(chips()[6]);
    setValue(7);
    rail.scrollTo.mockClear();

    setValue(12);

    expect(rail.scrollTo.mock.calls.at(-1)?.[0]).toEqual({ x: 480, animated: false });
  });
});
