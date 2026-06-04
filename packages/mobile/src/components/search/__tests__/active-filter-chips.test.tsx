// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { ClimbBoardFilterState } from '@boardsesh/climb-filters';
import type { ClimbFilters } from '../../../lib/climb-filter-types';

// buildActiveFilterPills (the sibling pure module) is intentionally NOT mocked:
// these tests exercise the real pill labels + the real clear-patch payloads, so
// we verify the chip wiring against the actual filter→pill mapping.

const haptics = vi.hoisted(() => ({ selection: vi.fn() }));

// Minimal RN surface. ScrollView/View → div. PressableSurface is mocked
// separately (it's a sibling component, not part of react-native).
vi.mock('react-native', () => ({
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-scroll': 'true' }, children),
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {} },
}));

// t returns the key so chip labels are deterministic and assertable. The chip
// label for a couple of filters is built from interpolation
// (formatMinAscentsFilterCount / `${count}+`), which the real pill module emits
// regardless of t, so those stay verifiable too.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { fill: '#eee', secondaryLabel: '#888' } }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticSelection: haptics.selection }));

// PressableSurface → button that surfaces its accessibility label + forwards
// onPress, so each chip is individually addressable and tappable. It also
// reflects the inline { height, borderRadius } the component computes from
// chipHeight (last entry of the style array) so sizing is assertable.
type SizeStyle = { height?: number; borderRadius?: number };
type PressMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: unknown;
};
function readSizeStyle(style: unknown): SizeStyle {
  const entries = Array.isArray(style) ? style : [style];
  return (entries.find((entry) => entry && typeof entry === 'object' && 'height' in entry) ?? {}) as SizeStyle;
}
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, accessibilityLabel, style }: PressMockProps) => {
    const size = readSizeStyle(style);
    return createElement(
      'button',
      {
        onClick: onPress,
        'data-chip': accessibilityLabel ?? '',
        'data-height': size.height == null ? '' : String(size.height),
        'data-radius': size.borderRadius == null ? '' : String(size.borderRadius),
      },
      children,
    );
  },
}));

vi.mock('../../GlassSurface', () => ({
  GlassSurface: () => createElement('div', { 'data-glass': 'true' }),
}));

vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-text': 'true' }, children),
}));

import { ActiveFilterChips } from '../ActiveFilterChips';

// A base filter state with everything off, so each test opts in to exactly the
// filters it wants surfaced.
function makeFilters(over: Partial<ClimbFilters> = {}): ClimbFilters {
  return { sortBy: 'ascents', sortOrder: 'desc', status: 'any', ...over };
}

function makeProps(over: Partial<Parameters<typeof ActiveFilterChips>[0]> = {}) {
  return {
    filters: makeFilters(),
    boardFilters: {} as ClimbBoardFilterState,
    onPatchFilters: vi.fn(),
    onPatchBoardFilters: vi.fn(),
    ...over,
  };
}

const chips = (root: HTMLElement) => Array.from(root.querySelectorAll('[data-chip]')) as HTMLButtonElement[];

describe('ActiveFilterChips', () => {
  beforeEach(() => {
    haptics.selection.mockClear();
  });

  it('renders nothing when no filters are active', () => {
    const { container } = render(<ActiveFilterChips {...makeProps()} />);
    expect(container.querySelector('[data-scroll]')).toBeNull();
    expect(chips(container)).toHaveLength(0);
  });

  it('renders one removable chip per active filter, with the right labels', () => {
    const { container } = render(
      <ActiveFilterChips
        {...makeProps({
          filters: makeFilters({ hideCompleted: true, onlyTallClimbs: true }),
          boardFilters: { onlyBenchmarks: true } as ClimbBoardFilterState,
        })}
      />,
    );
    const labels = chips(container).map((chip) => chip.getAttribute('data-chip'));
    expect(labels).toHaveLength(3);
    // accessibilityLabel = t('mobile.search.removeFilter', { name }); the mock t
    // returns the key, so each chip's a11y label is the removeFilter key.
    expect(labels.every((label) => label === 'mobile.search.removeFilter')).toBe(true);
    // The visible chip text carries the per-filter label keys.
    expect(container.textContent).toContain('mobile.filter.hideSent');
    expect(container.textContent).toContain('mobile.filter.tall');
    expect(container.textContent).toContain('mobile.filter.benchmark');
    // Each chip carries a close affordance.
    expect(container.querySelectorAll('[data-icon="close"]')).toHaveLength(3);
  });

  it('clears a filter-state chip via onPatchFilters with the cleared value', () => {
    const onPatchFilters = vi.fn();
    const onPatchBoardFilters = vi.fn();
    const { container } = render(
      <ActiveFilterChips
        {...makeProps({
          filters: makeFilters({ hideCompleted: true }),
          onPatchFilters,
          onPatchBoardFilters,
        })}
      />,
    );
    fireEvent.click(chips(container)[0]);
    expect(onPatchFilters).toHaveBeenCalledTimes(1);
    expect(onPatchFilters).toHaveBeenCalledWith({ hideCompleted: undefined });
    // A filter-state chip must not touch the board-filter patch.
    expect(onPatchBoardFilters).not.toHaveBeenCalled();
    expect(haptics.selection).toHaveBeenCalledTimes(1);
  });

  it('clears a board-filter chip via onPatchBoardFilters with the cleared value', () => {
    const onPatchFilters = vi.fn();
    const onPatchBoardFilters = vi.fn();
    const { container } = render(
      <ActiveFilterChips
        {...makeProps({
          boardFilters: { onlyBenchmarks: true } as ClimbBoardFilterState,
          onPatchFilters,
          onPatchBoardFilters,
        })}
      />,
    );
    fireEvent.click(chips(container)[0]);
    expect(onPatchBoardFilters).toHaveBeenCalledTimes(1);
    expect(onPatchBoardFilters).toHaveBeenCalledWith({ onlyBenchmarks: undefined });
    expect(onPatchFilters).not.toHaveBeenCalled();
  });

  it('clearing the climb-type chip resets to all climbs', () => {
    const onPatchFilters = vi.fn();
    const { container } = render(
      <ActiveFilterChips {...makeProps({ filters: makeFilters({ boulders: false, routes: true }), onPatchFilters })} />,
    );
    expect(container.textContent).toContain('mobile.filter.climbType.routes');
    fireEvent.click(chips(container)[0]);
    expect(onPatchFilters).toHaveBeenCalledWith({ boulders: undefined, routes: undefined });
  });

  it('defaults the chip height to 30 (radius 15) when chipHeight is omitted', () => {
    const { container } = render(
      <ActiveFilterChips {...makeProps({ filters: makeFilters({ hideCompleted: true }) })} />,
    );
    const [chip] = chips(container);
    expect(chip.getAttribute('data-height')).toBe('30');
    expect(chip.getAttribute('data-radius')).toBe('15');
  });

  it('honours the chipHeight prop (border radius = height / 2)', () => {
    // chipHeight=44 matches the grade pill when the chips sit beside it.
    const { container } = render(
      <ActiveFilterChips {...makeProps({ filters: makeFilters({ hideCompleted: true }), chipHeight: 44 })} />,
    );
    const [chip] = chips(container);
    expect(chip.getAttribute('data-height')).toBe('44');
    expect(chip.getAttribute('data-radius')).toBe('22');
  });
});
