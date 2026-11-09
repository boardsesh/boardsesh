// @vitest-environment jsdom
// FilterChipRow keeps board angle out of quick filters in both appearances. Screen suites
// import the extensionless `search/FilterChipRow`, which mobile Vitest aliases to
// a null stub; this relative import (`../FilterChipRow`) is not aliased, so it
// runs the real one.
import { render } from '@testing-library/react';
import { createElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLIMB_FILTER_STATE } from '@boardsesh/climb-filters';
import { DEFAULT_PINNED_CHIPS } from '../../../lib/pinnable-chips';
import type { Capsule } from '../../filter-capsules/CapsuleRow.types';
import type { FilterChipRowProps } from '../FilterChipRow.types';
import { FilterChipRow } from '../FilterChipRow';

type Board = { angle: number | null; boardType: string; layoutId: number; isAngleAdjustable?: boolean };
const state = vi.hoisted(() => ({
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  capsules: [] as Capsule[][],
  pickerMounts: 0,
  board: { angle: 40, boardType: 'kilter', layoutId: 1, isAngleAdjustable: true } as Board | null,
  open: () => {},
}));

vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ variant: state.variant }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { angle?: number }) =>
      key === 'mobile.angleSelector.buttonAria' ? `Board angle, ${options?.angle}°` : key,
  }),
}));
vi.mock('../../filter-capsules/CapsuleRow', () => ({
  CapsuleRow: ({ capsules }: { capsules: Capsule[] }) => {
    state.capsules.push(capsules);
    return null;
  },
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: state.board }) }));
// The picker's own presentation is covered by climb-list-board-actions; here it
// only hands the row its `open`.
vi.mock('../../chrome/BoardAnglePicker', () => ({
  BoardAnglePicker: ({ children }: { children: (open: () => void) => ReactElement }) => {
    state.pickerMounts += 1;
    return children(state.open);
  },
}));

const noop = () => {};
const PROPS: FilterChipRowProps = {
  pinnedChips: DEFAULT_PINNED_CHIPS,
  activeFilterCount: 0,
  onOpenFilters: noop,
  recentFilters: [],
  currentFilters: DEFAULT_CLIMB_FILTER_STATE,
  currentSearchText: '',
  onApplyRecent: noop,
  onClearRecent: noop,
  gradeLabel: 'Grade',
  gradeActive: false,
  onOpenGrade: noop,
  gradeRailOpen: false,
  onCloseGrade: noop,
  dimensionChips: [],
  minAscents: undefined,
  onChangePopularity: noop,
  minRating: undefined,
  onChangeRating: noop,
  progress: 'all',
  onChangeProgress: noop,
  canFilterProgress: true,
  collection: 'any',
  onChangeCollection: noop,
  canFilterPersonalCollections: true,
  isSprayWall: false,
  sortBy: 'ascents',
  sortActive: false,
  onChangeSort: noop,
  accuracyValue: 'off',
  onChangeAccuracy: noop,
  climbType: 'boulders',
  benchmarksActive: false,
  onToggleBenchmarks: noop,
  onChangeClimbType: noop,
  betaActive: false,
  onToggleBeta: noop,
};

function renderIn(variant: 'liquidGlass' | 'material') {
  state.variant = variant;
  render(createElement(FilterChipRow, PROPS));
  const capsules = state.capsules.at(-1);
  if (!capsules) throw new Error('CapsuleRow did not render');
  return capsules;
}

beforeEach(() => {
  state.capsules = [];
  state.pickerMounts = 0;
  state.variant = 'liquidGlass';
  state.board = { angle: 40, boardType: 'kilter', layoutId: 1, isAngleAdjustable: true };
  state.open = vi.fn();
});

describe('FilterChipRow', () => {
  it.each(['liquidGlass', 'material'] as const)(
    'starts with Filters on %s without mounting an angle picker',
    (variant) => {
      const capsules = renderIn(variant);
      expect(capsules.map(({ key }) => key)).toEqual([
        'filters',
        'grade',
        'benchmarks',
        'progress',
        'collection',
        'popularity',
        'rating',
      ]);
      expect(state.pickerMounts).toBe(0);
    },
  );
});
