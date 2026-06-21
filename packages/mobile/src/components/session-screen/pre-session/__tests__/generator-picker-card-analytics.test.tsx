// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeneratorSelection } from '../GeneratorPickerCard';
import type { WarmUpType } from '@boardsesh/playlist-generator';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const haptics = vi.hoisted(() => ({ hapticSelection: vi.fn() }));

// The workout-type chips render in CHIP_VALUES order: off, volume, pyramid,
// ladder, gradeFocus. Each chip's Pressable onPress lands here in render order
// so the test can tap a specific chip. (Only chips push here — the segmented
// controls / steppers are mocked separately below.)
const chips = vi.hoisted(() => ({ entries: [] as Array<{ label?: string; onPress: () => void }> }));

const shelf = vi.hoisted(() => ({
  entries: [] as Array<{
    key: string;
    label: string;
    selected: boolean;
    bars: unknown;
    onPress: () => void;
    accessibilityLabel: string;
  }>,
}));

// Surfaces the mocked SegmentedControls so a test can drive a specific group's
// onSelect (warm-up, climb bias) by its accessibilityLabel.
const segments = vi.hoisted(() => ({
  entries: [] as Array<{ accessibilityLabel?: string; onSelect: (key: string) => void }>,
}));

vi.mock('../../../../lib/analytics', () => ({ track: analytics.track }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  // Chip uses an animated Pressable; capture its onPress + label so a test can
  // tap the workout-type chips.
  Pressable: ({
    onPress,
    accessibilityLabel,
    children,
  }: {
    onPress?: () => void;
    accessibilityLabel?: string;
    children?: ReactNode;
  }) => {
    if (onPress) chips.entries.push({ label: accessibilityLabel, onPress });
    return createElement('button', null, children);
  },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

// createAnimatedComponent returns the component untouched so the mocked
// Pressable still captures the chip onPress.
vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: (component: unknown) => component },
  createAnimatedComponent: (component: unknown) => component,
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: () => ({}),
  withSpring: (value: number) => value,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | number>) => {
      if (key === 'mobile.session.preGeneratorOptionAccessibilityLabel' && options) {
        return `${options.group}, ${options.value}`;
      }
      if (key === 'mobile.session.preGeneratorOptionChartValue' && options) {
        return `${options.value}, ${options.summary}`;
      }
      if (key === 'mobile.session.preGeneratorChartPoint' && options) {
        return `${options.count} climbs at ${options.grade}`;
      }
      if (key === 'mobile.session.preGeneratorChartProgressPoint' && options) {
        return `climb ${options.index}, ${options.grade}`;
      }
      return key;
    },
  }),
}));
vi.mock('@boardsesh/board-config', () => ({
  // Two grades so getDefaultTargetGrade picks the middle one deterministically.
  getGradesForBoard: () => [
    { difficulty_id: 10, difficulty_name: '5a' },
    { difficulty_id: 20, difficulty_name: '6a' },
  ],
}));
vi.mock('@boardsesh/board-constants', () => ({
  KILTER_HOMEWALL_LAYOUT_ID: 8,
  isKilterHomewallTallSizeId: () => false,
  isKilterHomewallWideSizeId: () => false,
}));
vi.mock('@boardsesh/climb-filters', () => ({
  formatMinAscentsFilterCount: (value: number) => String(value),
  getMinAscentsFilterOptions: () => [0, 1, 10],
  getMinRatingPickerValue: (value: number | null | undefined) => (value != null && value > 0 ? value : null),
}));
vi.mock('@boardsesh/playlist-generator', () => ({
  CLIMB_BIAS_OPTIONS: ['unfamiliar', 'attempted', 'any'],
  WARM_UP_OPTIONS: ['none', 'standard', 'extended'],
  DEFAULT_GRADE_FOCUS_OPTIONS: {
    type: 'gradeFocus',
    warmUp: 'none',
    numberOfClimbs: 15,
    climbBias: 'unfamiliar',
    minAscents: 5,
    minRating: 2,
    onlyTallClimbs: false,
    onlyWideClimbs: false,
  },
  DEFAULT_LADDER_OPTIONS: {
    type: 'ladder',
    warmUp: 'none',
    numberOfSteps: 5,
    climbsPerStep: 2,
    climbBias: 'unfamiliar',
    minAscents: 5,
    minRating: 2,
    onlyTallClimbs: false,
    onlyWideClimbs: false,
  },
  DEFAULT_PYRAMID_OPTIONS: {
    type: 'pyramid',
    warmUp: 'none',
    numberOfSteps: 5,
    climbsPerStep: 1,
    climbBias: 'unfamiliar',
    minAscents: 5,
    minRating: 2,
    onlyTallClimbs: false,
    onlyWideClimbs: false,
  },
  DEFAULT_VOLUME_OPTIONS: {
    type: 'volume',
    warmUp: 'none',
    mainSetClimbs: 20,
    mainSetVariability: 0,
    climbBias: 'unfamiliar',
    minAscents: 5,
    minRating: 2,
    onlyTallClimbs: false,
    onlyWideClimbs: false,
  },
  generateWorkoutPlan: (options: { targetGrade: number; type: string }) =>
    options.type === 'pyramid'
      ? [
          { grade: options.targetGrade - 1, section: 'increasing', index: 0 },
          { grade: options.targetGrade, section: 'peak', index: 1 },
          { grade: options.targetGrade - 1, section: 'decreasing', index: 2 },
        ]
      : [{ grade: options.targetGrade, section: 'main', index: 0 }],
}));
vi.mock('../../../SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('h2', null, title),
}));
vi.mock('../../../SegmentedControl', () => ({
  SegmentedControl: ({
    accessibilityLabel,
    onSelect,
  }: {
    accessibilityLabel?: string;
    onSelect: (key: string) => void;
  }) => {
    segments.entries.push({ accessibilityLabel, onSelect });
    return null;
  },
}));
vi.mock('../../../CollapsibleSection', () => ({
  // Render children so the Tuning controls mount.
  CollapsibleSection: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../StarRating', () => ({ StarRating: () => null }));
vi.mock('../../../SwitchRow', () => ({ SwitchRow: () => null }));
vi.mock('../../../Stepper', () => ({ Stepper: () => null }));
vi.mock('../../../grade', () => ({ GradeSingleSelectRail: () => null }));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGradeByDifficultyId: (difficultyId: number) => `V${difficultyId}` }),
}));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#eee' },
    brandColors: {},
    opacity: { disabled: 0.5 },
    variant: 'liquidGlass',
  }),
}));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: haptics.hapticSelection }));
vi.mock('../../../../theme/tokens', () => ({ spacing: {}, borderRadius: {} }));
vi.mock('../../../../theme/animations', () => ({ springs: { snappy: {} } }));
vi.mock('../../../../theme/colors', () => ({ brandColors: { primary: '#6D28D9' } }));
vi.mock('../../../../theme/ios-colors', () => ({ iosSystemColors: { white: '#fff', systemGray: '#999' } }));
vi.mock('../WorkoutTypeShelf', () => ({
  WorkoutTypeShelf: ({
    items,
  }: {
    items: Array<{
      key: string;
      label: string;
      selected: boolean;
      bars: unknown;
      onPress: () => void;
      accessibilityLabel: string;
    }>;
  }) => {
    shelf.entries = items.map((item) => ({
      key: item.key,
      label: item.label,
      selected: item.selected,
      bars: item.bars,
      onPress: item.onPress,
      accessibilityLabel: item.accessibilityLabel,
    }));
    return createElement('div', null);
  },
}));

import { GeneratorPickerCard } from '../GeneratorPickerCard';

beforeEach(() => {
  analytics.track.mockClear();
  haptics.hapticSelection.mockClear();
  chips.entries = [];
  shelf.entries = [];
  segments.entries = [];
});

const VOLUME_SELECTION: GeneratorSelection = {
  type: 'on',
  options: {
    type: 'volume',
    warmUp: 'standard',
    targetGrade: 20,
    mainSetClimbs: 20,
    mainSetVariability: 0,
    climbBias: 'unfamiliar',
    minAscents: 5,
    minRating: 2,
    onlyTallClimbs: false,
    onlyWideClimbs: false,
  },
};

describe('GeneratorPickerCard analytics', () => {
  it('renders the workout types as a selectable chart shelf', () => {
    render(
      createElement(GeneratorPickerCard, {
        boardName: 'kilter',
        layoutId: 8,
        sizeId: 21,
        angle: 40,
        selection: VOLUME_SELECTION,
        onChange: vi.fn(),
      }),
    );

    expect(shelf.entries.map((entry) => entry.key)).toEqual(['off', 'volume', 'pyramid', 'ladder', 'gradeFocus']);
    expect(shelf.entries.find((entry) => entry.key === 'volume')).toMatchObject({
      selected: true,
      bars: expect.any(Array),
      accessibilityLabel: 'mobile.session.preGeneratorLabel, mobile.session.preGeneratorVolume, 1 climbs at V20',
    });
  });

  it('renders the selected workout chart from current settings without waiting for preview data', () => {
    render(
      createElement(GeneratorPickerCard, {
        boardName: 'kilter',
        layoutId: 8,
        sizeId: 21,
        angle: 40,
        selection: VOLUME_SELECTION,
        onChange: vi.fn(),
      }),
    );

    expect(shelf.entries.find((entry) => entry.key === 'volume')).toMatchObject({
      selected: true,
      bars: expect.any(Array),
    });
    expect(shelf.entries.find((entry) => entry.key === 'pyramid')?.bars).toEqual(expect.any(Array));
  });

  it('renders pyramid shelf charts by climb number instead of grade counts', () => {
    render(
      createElement(GeneratorPickerCard, {
        boardName: 'kilter',
        layoutId: 8,
        sizeId: 21,
        angle: 40,
        selection: VOLUME_SELECTION,
        onChange: vi.fn(),
      }),
    );

    const pyramidBars = shelf.entries.find((entry) => entry.key === 'pyramid')?.bars;
    expect(pyramidBars).toEqual([
      expect.objectContaining({ label: '1' }),
      expect.objectContaining({ label: '2' }),
      expect.objectContaining({ label: '3' }),
    ]);
    expect(shelf.entries.find((entry) => entry.key === 'pyramid')?.accessibilityLabel).toContain('climb 2, V20');
  });

  it('fires "Workout Generator Opened" with web-aligned targetType + angle when switching off → a workout type', () => {
    const onChange = vi.fn();
    render(
      createElement(GeneratorPickerCard, {
        boardName: 'kilter',
        layoutId: 8,
        sizeId: 21,
        angle: 40,
        selection: { type: 'off' } satisfies GeneratorSelection,
        onChange,
      }),
    );

    shelf.entries.find((entry) => entry.key === 'volume')?.onPress();

    expect(haptics.hapticSelection).toHaveBeenCalledTimes(1);
    // Exact payload web sends (playlist-generator-drawer.tsx): { targetType, boardName, angle }.
    // No `workoutType` key — PostHog groups by exact prop name, so it must match web.
    expect(analytics.track).toHaveBeenCalledWith('Workout Generator Opened', {
      targetType: 'session',
      boardName: 'kilter',
      angle: 40,
    });
    expect(onChange).toHaveBeenCalledWith({
      type: 'on',
      options: expect.objectContaining({ type: 'volume', warmUp: 'none' }),
    });
  });

  it('does not fire when tapping "off" (no off → on transition)', () => {
    render(
      createElement(GeneratorPickerCard, {
        boardName: 'kilter',
        layoutId: 8,
        sizeId: 21,
        angle: 40,
        selection: { type: 'off' } satisfies GeneratorSelection,
        onChange: vi.fn(),
      }),
    );

    shelf.entries.find((entry) => entry.key === 'off')?.onPress();

    expect(analytics.track).not.toHaveBeenCalled();
  });

  it('updates warm-up when the warm-up segmented control changes', () => {
    const onChange = vi.fn();
    render(
      createElement(GeneratorPickerCard, {
        boardName: 'kilter',
        layoutId: 8,
        sizeId: 21,
        angle: 40,
        selection: VOLUME_SELECTION,
        onChange,
      }),
    );

    const warmUpControl = segments.entries.find(
      (entry) => entry.accessibilityLabel === 'mobile.session.preGeneratorWarmUp',
    );
    warmUpControl?.onSelect('extended' satisfies WarmUpType);

    expect(onChange).toHaveBeenCalledWith({
      type: 'on',
      options: expect.objectContaining({ warmUp: 'extended' }),
    });
  });
});
