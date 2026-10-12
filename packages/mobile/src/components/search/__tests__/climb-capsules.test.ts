// Parity lock for the climbs capsule row. Before CapsuleRow, the climbs row was
// three hand-written platform trees (FilterChipRow.ios/.android/.web). These
// cases pin what those trees rendered: the order, kinds, labels, active flags
// and visibility rules, plus what each capsule commits, so moving the row onto
// shared descriptors changed nothing a climber can see or tap.
import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { createElement } from 'react';
import { DEFAULT_CLIMB_FILTER_STATE, SORT_OPTIONS } from '@boardsesh/climb-filters';
import { DEFAULT_PINNED_CHIPS, PINNABLE_CHIP_CATALOG } from '../../../lib/pinnable-chips';
import type { RecentFilter } from '../../../lib/recent-filter-store';
import { isCapsuleActive } from '../../filter-capsules/CapsuleRow.logic';
import type { Capsule, MenuCapsule, RailCapsule, ToggleMenuCapsule } from '../../filter-capsules/CapsuleRow.types';
import { buildClimbCapsules, type ClimbAngleCapsule } from '../climb-capsules';
import type { DimensionChip, FilterChipRowProps } from '../FilterChipRow.types';

// Returns the key, with the interpolated count where there is one, so each
// assertion names the exact catalog key in play.
const mockT = ((key: string, options?: { count?: number }) =>
  options?.count == null ? key : `${key}(${options.count})`) as unknown as TFunction<'climbs'>;

function makeProps(overrides: Partial<FilterChipRowProps> = {}): FilterChipRowProps {
  return {
    pinnedChips: DEFAULT_PINNED_CHIPS,
    activeFilterCount: 0,
    onOpenFilters: vi.fn(),
    recentFilters: [],
    currentFilters: DEFAULT_CLIMB_FILTER_STATE,
    currentSearchText: '',
    onApplyRecent: vi.fn(),
    onClearRecent: vi.fn(),
    gradeLabel: 'Grade',
    gradeActive: false,
    onOpenGrade: vi.fn(),
    gradeRailOpen: false,
    onCloseGrade: vi.fn(),
    dimensionChips: [],
    minAscents: undefined,
    onChangePopularity: vi.fn(),
    minRating: undefined,
    onChangeRating: vi.fn(),
    progress: 'all',
    onChangeProgress: vi.fn(),
    canFilterProgress: true,
    collection: 'any',
    onChangeCollection: vi.fn(),
    canFilterDrafts: true,
    isSprayWall: false,
    sortBy: DEFAULT_CLIMB_FILTER_STATE.sortBy,
    sortActive: false,
    onChangeSort: vi.fn(),
    accuracyValue: 'off',
    onChangeAccuracy: vi.fn(),
    climbType: 'boulders',
    onChangeClimbType: vi.fn(),
    betaActive: false,
    onToggleBeta: vi.fn(),
    ...overrides,
  };
}

function dimension(key: 'tall' | 'wide', state: Partial<DimensionChip> = {}): DimensionChip {
  return { key, active: false, locked: false, onToggle: vi.fn(), onToggleLock: vi.fn(), ...state };
}

/** [kind, key, label, active] per capsule, in order: what a climber sees. */
function summarize(capsules: Capsule[]): [string, string, string, boolean][] {
  return capsules.map((capsule) => [capsule.kind, capsule.key, capsule.label, isCapsuleActive(capsule)]);
}

function capsuleByKey<K extends Capsule['kind']>(
  capsules: Capsule[],
  key: string,
  kind: K,
): Extract<Capsule, { kind: K }> {
  const capsule = capsules.find((candidate) => candidate.key === key);
  if (!capsule || capsule.kind !== kind) throw new Error(`missing ${kind} capsule ${key}`);
  return capsule as Extract<Capsule, { kind: K }>;
}

const ANGLE: ClimbAngleCapsule = { label: '40°', accessibilityLabel: 'angleSelector.selectAngle', onPress: vi.fn() };

describe('buildClimbCapsules: the resting row', () => {
  it('renders the default pins in catalog order, all resting', () => {
    expect(summarize(buildClimbCapsules(makeProps(), mockT, null))).toEqual([
      ['sheet', 'filters', 'mobile.filter.title', false],
      ['rail', 'grade', 'Grade', false],
      ['menu', 'progress', 'mobile.filter.progress.label', false],
      ['menu', 'collection', 'mobile.filter.collection.label', false],
      ['menu', 'popularity', 'mobile.filter.popularity', false],
      ['menu', 'rating', 'mobile.filter.minRating', false],
    ]);
  });

  it('leads with the Angle capsule on Android / web, before Filters', () => {
    const capsules = buildClimbCapsules(makeProps(), mockT, ANGLE);
    expect(summarize(capsules).slice(0, 2)).toEqual([
      ['sheet', 'angle', '40°', false],
      ['sheet', 'filters', 'mobile.filter.title', false],
    ]);
    const angle = capsuleByKey(capsules, 'angle', 'sheet');
    expect(angle.accessibilityLabel).toBe('angleSelector.selectAngle');
    expect(angle.icon).toBeUndefined();
    expect(angle.onPress).toBe(ANGLE.onPress);
  });

  it('hides Your progress when signed out, keeping the pin', () => {
    const keys = buildClimbCapsules(makeProps({ canFilterProgress: false }), mockT, null).map(({ key }) => key);
    expect(keys).toEqual(['filters', 'grade', 'collection', 'popularity', 'rating']);
  });

  it('drops an unpinned chip and keeps the fixed chrome', () => {
    const keys = buildClimbCapsules(makeProps({ pinnedChips: ['rating'] }), mockT, null).map(({ key }) => key);
    expect(keys).toEqual(['filters', 'rating']);
  });

  it('shows the active filter count on Filters and lights it', () => {
    const filters = capsuleByKey(
      buildClimbCapsules(makeProps({ activeFilterCount: 3 }), mockT, null),
      'filters',
      'sheet',
    );
    expect(filters.label).toBe('mobile.search.chips.filtersWithCount(3)');
    expect(filters.count).toBe(3);
    expect(filters.icon).toBe('filters');
    expect(isCapsuleActive(filters)).toBe(true);
  });
});

describe('buildClimbCapsules: every chip pinned and set', () => {
  const props = makeProps({
    pinnedChips: PINNABLE_CHIP_CATALOG,
    activeFilterCount: 9,
    recentFilters: [
      {
        id: 'recent-1',
        label: 'Crimpy V4',
        filters: DEFAULT_CLIMB_FILTER_STATE,
        searchText: 'crimp',
        timestamp: 1,
      },
    ],
    gradeLabel: 'V4–V6',
    gradeActive: true,
    dimensionChips: [dimension('tall', { active: true }), dimension('wide', { active: true, locked: true })],
    minAscents: 10,
    minRating: 3,
    progress: 'unsent',
    collection: 'benchmarks',
    sortBy: 'quality',
    sortActive: true,
    accuracyValue: '0.1',
    climbType: 'routes',
    betaActive: true,
  });

  it('renders in catalog order with each value as its label', () => {
    expect(summarize(buildClimbCapsules(props, mockT, null))).toEqual([
      ['sheet', 'filters', 'mobile.search.chips.filtersWithCount(9)', true],
      ['menu', 'recent', 'mobile.search.recentFilters', false],
      ['rail', 'grade', 'V4–V6', true],
      ['menu', 'accuracy', 'mobile.filter.accuracy.moderate', true],
      ['menu', 'progress', 'mobile.filter.progress.unsent', true],
      ['menu', 'collection', 'mobile.filter.benchmark', true],
      ['menu', 'climbType', 'mobile.filter.climbType.routes', true],
      ['toggleMenu', 'tall', 'mobile.search.chips.tall', true],
      ['toggleMenu', 'wide', 'mobile.search.chips.wide', true],
      ['toggle', 'beta', 'mobile.filter.betaVideos', true],
      ['menu', 'popularity', '10+', true],
      ['menu', 'rating', 'mobile.search.rating(3)', true],
      ['menu', 'sort', 'mobile.filter.sort.quality', true],
    ]);
  });

  it('marks the selected option in each menu', () => {
    const capsules = buildClimbCapsules(props, mockT, null);
    const selected = (key: string) => capsuleByKey(capsules, key, 'menu').selected;
    expect(selected('accuracy')).toBe('0.1');
    expect(selected('progress')).toBe('unsent');
    expect(selected('collection')).toBe('benchmarks');
    expect(selected('climbType')).toBe('routes');
    expect(selected('popularity')).toBe('10');
    expect(selected('rating')).toBe('3');
    expect(selected('sort')).toBe('quality');
  });

  it('keeps the menus at their old option sets', () => {
    const capsules = buildClimbCapsules(props, mockT, null);
    const values = (key: string) => capsuleByKey(capsules, key, 'menu').options.map(({ value }) => value);
    expect(values('accuracy')).toEqual(['off', '0.2', '0.1', '0.05']);
    expect(values('progress')).toEqual(['all', 'unsent', 'untried', 'projects', 'sent']);
    expect(values('collection')).toEqual(['any', 'benchmarks', 'drafts']);
    expect(values('climbType')).toEqual(['boulders', 'routes', 'both']);
    expect(values('popularity')).toEqual(['any', '2', '10', '100', '1000']);
    expect(values('rating')).toEqual(['any', '1', '2', '3', '4', '5']);
    expect(values('sort')).toEqual([...SORT_OPTIONS]);
    const labels = (key: string) => capsuleByKey(capsules, key, 'menu').options.map(({ label }) => label);
    expect(labels('accuracy')).toEqual([
      'mobile.filter.accuracy.off',
      'mobile.filter.accuracy.loose',
      'mobile.filter.accuracy.moderate',
      'mobile.filter.accuracy.tight',
    ]);
    expect(labels('popularity')).toEqual([
      'mobile.filter.anyAscents',
      'mobile.filter.established2plus',
      '10+',
      '100+',
      '1k+',
    ]);
    expect(labels('rating')[0]).toBe('mobile.filter.anyRating');
  });

  it('drops My drafts when signed out and Benchmarks on a spray wall', () => {
    const signedOut = buildClimbCapsules(makeProps({ canFilterDrafts: false }), mockT, null);
    expect(capsuleByKey(signedOut, 'collection', 'menu').options.map(({ value }) => value)).toEqual([
      'any',
      'benchmarks',
    ]);
    const spray = buildClimbCapsules(makeProps({ isSprayWall: true }), mockT, null);
    expect(capsuleByKey(spray, 'collection', 'menu').options.map(({ value }) => value)).toEqual(['any', 'drafts']);
  });
});

describe('buildClimbCapsules: Recent', () => {
  const recents: RecentFilter[] = [
    { id: 'a', label: 'Crimpy', filters: DEFAULT_CLIMB_FILTER_STATE, searchText: 'crimp', timestamp: 2 },
    {
      id: 'b',
      label: 'Beta only',
      filters: { ...DEFAULT_CLIMB_FILTER_STATE, onlyWithBetaVideos: true },
      searchText: '',
      timestamp: 1,
    },
  ];

  it('is hidden with no saved searches', () => {
    expect(buildClimbCapsules(makeProps(), mockT, null).some(({ key }) => key === 'recent')).toBe(false);
  });

  it('checks the saved search in force and re-applies any tap, the checked one too', () => {
    const onApplyRecent = vi.fn();
    const onClearRecent = vi.fn();
    const recent = capsuleByKey(
      buildClimbCapsules(
        makeProps({ recentFilters: recents, currentSearchText: 'crimp', onApplyRecent, onClearRecent }),
        mockT,
        null,
      ),
      'recent',
      'menu',
    );
    expect(recent.icon).toBe('recent');
    expect(recent.optionStyle).toBe('commands');
    expect(recent.options).toEqual([
      { value: 'a', label: 'Crimpy' },
      { value: 'b', label: 'Beta only' },
    ]);
    expect(recent.selected).toBe('a');

    recent.onSelect('a');
    recent.onSelect('b');
    recent.onSelect('missing');
    expect(onApplyRecent.mock.calls).toEqual([
      [recents[0].filters, 'crimp'],
      [recents[1].filters, ''],
    ]);

    expect(recent.actions).toHaveLength(1);
    const clear = recent.actions?.[0];
    expect(clear?.label).toBe('mobile.search.clearRecentSearches');
    expect(clear?.destructive).toBe(true);
    clear?.onPress();
    expect(onClearRecent).toHaveBeenCalledTimes(1);
  });

  it('checks nothing when no saved search is in force', () => {
    const recent = capsuleByKey(
      buildClimbCapsules(makeProps({ recentFilters: recents, currentSearchText: 'jugs' }), mockT, null),
      'recent',
      'menu',
    );
    expect(recent.selected).toBeUndefined();
  });
});

describe('buildClimbCapsules: Grade', () => {
  it('opens the rail while closed', () => {
    const onOpenGrade = vi.fn();
    const grade: RailCapsule = capsuleByKey(
      buildClimbCapsules(makeProps({ onOpenGrade }), mockT, null),
      'grade',
      'rail',
    );
    expect(grade.expanded).toBe(false);
    expect(grade.onPress).toBe(onOpenGrade);
    expect(grade.accessibilityHint).toBe('mobile.search.gradeOpenHint');
    expect(grade.popover).toBeUndefined();
  });

  it('closes the rail while open, and dismisses the iPad popover the same way', () => {
    const onCloseGrade = vi.fn();
    const content = createElement('div');
    const grade = capsuleByKey(
      buildClimbCapsules(makeProps({ gradeRailOpen: true, onCloseGrade, gradePopoverContent: content }), mockT, null),
      'grade',
      'rail',
    );
    expect(grade.expanded).toBe(true);
    expect(grade.onPress).toBe(onCloseGrade);
    expect(grade.accessibilityHint).toBe('mobile.search.gradeCloseHint');
    expect(grade.popover?.content).toBe(content);
    expect(grade.popover?.onDismiss).toBe(onCloseGrade);
  });
});

describe('buildClimbCapsules: Tall / Wide', () => {
  it('shows only sizes that have them, and only while pinned', () => {
    const keys = buildClimbCapsules(
      makeProps({
        pinnedChips: DEFAULT_PINNED_CHIPS.filter((kind) => kind !== 'wide'),
        dimensionChips: [dimension('tall'), dimension('wide')],
      }),
      mockT,
      null,
    ).map(({ key }) => key);
    expect(keys).toEqual(['filters', 'grade', 'progress', 'collection', 'tall', 'popularity', 'rating']);
  });

  it('taps to toggle and offers Lock on an unlocked chip', () => {
    const tall = dimension('tall');
    const capsule: ToggleMenuCapsule = capsuleByKey(
      buildClimbCapsules(makeProps({ dimensionChips: [tall] }), mockT, null),
      'tall',
      'toggleMenu',
    );
    expect(capsule.icon).toBeUndefined();
    expect(capsule.onPress).toBe(tall.onToggle);
    expect(capsule.actions).toEqual([
      { key: 'lock', label: 'mobile.search.chips.lock', icon: 'lock', onPress: tall.onToggleLock },
    ]);
  });

  it('shows a lock and offers Unlock on a locked chip', () => {
    const wide = dimension('wide', { active: true, locked: true });
    const capsule = capsuleByKey(
      buildClimbCapsules(makeProps({ dimensionChips: [wide] }), mockT, null),
      'wide',
      'toggleMenu',
    );
    expect(capsule.active).toBe(true);
    expect(capsule.icon).toBe('locked');
    expect(capsule.actions).toEqual([
      { key: 'lock', label: 'mobile.search.chips.unlock', icon: 'unlock', onPress: wide.onToggleLock },
    ]);
  });
});

describe('buildClimbCapsules: what each capsule commits', () => {
  function pinnedEverything(overrides: Partial<FilterChipRowProps> = {}) {
    return buildClimbCapsules(makeProps({ pinnedChips: PINNABLE_CHIP_CATALOG, ...overrides }), mockT, null);
  }
  const menu = (capsules: Capsule[], key: string): MenuCapsule => capsuleByKey(capsules, key, 'menu');

  it('commits typed values and ignores tags it does not know', () => {
    const props = {
      onChangeAccuracy: vi.fn(),
      onChangeProgress: vi.fn(),
      onChangeCollection: vi.fn(),
      onChangeClimbType: vi.fn(),
      onChangeSort: vi.fn(),
    };
    const capsules = pinnedEverything(props);
    for (const key of ['accuracy', 'progress', 'collection', 'climbType', 'sort'])
      menu(capsules, key).onSelect('bogus');
    menu(capsules, 'accuracy').onSelect('off');
    menu(capsules, 'accuracy').onSelect('0.05');
    menu(capsules, 'progress').onSelect('sent');
    menu(capsules, 'collection').onSelect('drafts');
    menu(capsules, 'climbType').onSelect('both');
    menu(capsules, 'sort').onSelect('random');
    expect(props.onChangeAccuracy.mock.calls).toEqual([['off'], ['0.05']]);
    expect(props.onChangeProgress.mock.calls).toEqual([['sent']]);
    expect(props.onChangeCollection.mock.calls).toEqual([['drafts']]);
    expect(props.onChangeClimbType.mock.calls).toEqual([['both']]);
    expect(props.onChangeSort.mock.calls).toEqual([['random']]);
  });

  it('maps the popularity and rating tags back to their buckets', () => {
    const onChangePopularity = vi.fn();
    const onChangeRating = vi.fn();
    const capsules = pinnedEverything({ onChangePopularity, onChangeRating });
    menu(capsules, 'popularity').onSelect('100');
    menu(capsules, 'popularity').onSelect('any');
    menu(capsules, 'rating').onSelect('4');
    menu(capsules, 'rating').onSelect('any');
    expect(onChangePopularity.mock.calls).toEqual([[100], [undefined]]);
    expect(onChangeRating.mock.calls).toEqual([[4], [undefined]]);
  });

  it('wires the Filters, Beta and sort-at-rest capsules', () => {
    const onOpenFilters = vi.fn();
    const onToggleBeta = vi.fn();
    const capsules = pinnedEverything({ onOpenFilters, onToggleBeta });
    capsuleByKey(capsules, 'filters', 'sheet').onPress();
    capsuleByKey(capsules, 'beta', 'toggle').onPress();
    expect(onOpenFilters).toHaveBeenCalledTimes(1);
    expect(onToggleBeta).toHaveBeenCalledTimes(1);
    // A default sort rests as "Sort by", unlit, with the key still checked.
    const sort = menu(capsules, 'sort');
    expect([sort.label, sort.active, sort.selected]).toEqual(['mobile.filter.sortBy', false, 'ascents']);
  });
});
