// @vitest-environment jsdom
// FilterChipRow, the climbs adapter: builds the capsules and adds the Angle
// capsule + its sheet only off iOS. Screen suites import the extensionless
// `search/FilterChipRow`, which mobile Vitest aliases to a null stub; this
// relative import (`../FilterChipRow`) is not aliased, so it runs the real one.
// The platform is read once at module load, so each case re-imports it.
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLIMB_FILTER_STATE } from '@boardsesh/climb-filters';
import { DEFAULT_PINNED_CHIPS } from '../../../lib/pinnable-chips';
import type { Capsule } from '../../filter-capsules/CapsuleRow.types';
import type { FilterChipRowProps } from '../FilterChipRow.types';

const state = vi.hoisted(() => ({
  os: 'ios',
  capsules: [] as Capsule[][],
  angleSheets: [] as Record<string, unknown>[],
  angleControlCalls: 0,
  angle: {
    activeBoard: { angle: 40, boardType: 'kilter', layoutId: 1 } as {
      angle: number;
      boardType: string;
      layoutId: number;
    } | null,
    canAdjust: true,
  },
  open: () => {},
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return state.os;
    },
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../filter-capsules/CapsuleRow', () => ({
  CapsuleRow: ({ capsules }: { capsules: Capsule[] }) => {
    state.capsules.push(capsules);
    return null;
  },
}));
vi.mock('../../chrome/use-material-angle-control', () => ({
  useMaterialAngleControl: () => {
    state.angleControlCalls += 1;
    return {
      activeBoard: state.angle.activeBoard,
      canAdjust: state.angle.canAdjust,
      visible: false,
      open: state.open,
      close: () => {},
      change: () => {},
    };
  },
}));
vi.mock('../../play-drawer/AngleSelectorSheet', () => ({
  AngleSelectorSheet: (props: Record<string, unknown>) => {
    state.angleSheets.push(props);
    return null;
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
  canFilterDrafts: true,
  isSprayWall: false,
  sortBy: 'ascents',
  sortActive: false,
  onChangeSort: noop,
  accuracyValue: 'off',
  onChangeAccuracy: noop,
  climbType: 'boulders',
  onChangeClimbType: noop,
  betaActive: false,
  onToggleBeta: noop,
};

async function renderOn(os: 'ios' | 'android' | 'web') {
  state.os = os;
  vi.resetModules();
  const { FilterChipRow } = await import('../FilterChipRow');
  render(createElement(FilterChipRow, PROPS));
  const capsules = state.capsules.at(-1);
  if (!capsules) throw new Error('CapsuleRow did not render');
  return capsules;
}

beforeEach(() => {
  state.capsules = [];
  state.angleSheets = [];
  state.angleControlCalls = 0;
  state.angle.activeBoard = { angle: 40, boardType: 'kilter', layoutId: 1 };
  state.angle.canAdjust = true;
  state.open = vi.fn();
});

describe('FilterChipRow', () => {
  it('on iOS leads with Filters, with no angle capsule, sheet or angle hook', async () => {
    const capsules = await renderOn('ios');
    expect(capsules.map(({ key }) => key)).toEqual([
      'filters',
      'grade',
      'progress',
      'collection',
      'popularity',
      'rating',
    ]);
    expect(state.angleSheets).toHaveLength(0);
    expect(state.angleControlCalls).toBe(0);
  });

  it.each(['android', 'web'] as const)('on %s leads with the Angle capsule and mounts its sheet', async (os) => {
    const capsules = await renderOn(os);
    expect(capsules.map(({ key }) => key).slice(0, 2)).toEqual(['angle', 'filters']);
    const [angle] = capsules;
    expect(angle).toMatchObject({
      kind: 'sheet',
      label: '40°',
      accessibilityLabel: 'angleSelector.selectAngle',
      onPress: state.open,
    });
    expect(state.angleSheets.at(-1)).toMatchObject({ boardName: 'kilter', layoutId: 1, currentAngle: 40 });
  });

  it('drops the Angle capsule and its sheet on a fixed-angle board', async () => {
    state.angle.canAdjust = false;
    const capsules = await renderOn('android');
    expect(capsules[0].key).toBe('filters');
    expect(state.angleSheets).toHaveLength(0);
  });
});
