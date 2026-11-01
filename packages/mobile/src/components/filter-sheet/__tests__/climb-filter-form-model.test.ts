import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import type { ClimbFilters } from '../../../lib/climb-filter-types';
import type { MoreRow } from '../../MoreForm.types';
import type { ClimbFilterFormRow } from '../../ClimbFilterForm.types';
import { buildClimbFilterFormModel, type ClimbFilterFormInput } from '../climb-filter-form-model';

const t = ((key: string, options?: { count?: number }) =>
  options?.count == null ? key : `${key}:${options.count}`) as unknown as TFunction<'climbs'>;

const baseFilters = {
  sortBy: 'popular',
  sortOrder: 'desc',
  status: 'any',
  boulders: true,
  routes: false,
} as unknown as ClimbFilters;

function makeInput(overrides: Partial<ClimbFilterFormInput> = {}): ClimbFilterFormInput {
  return {
    t,
    filters: baseFilters,
    isAuthenticated: true,
    name: {
      value: 'crimp',
      placeholder: 'Climb name',
      clearLabel: 'Clear',
      onChangeText: vi.fn(),
      onClear: vi.fn(),
      onFocus: vi.fn(),
    },
    recent: { items: [], currentId: undefined, onSelect: vi.fn() },
    grade: { rail: null, height: 52 },
    accuracy: { options: [{ key: 'off', label: 'Off' }], onSelect: vi.fn() },
    progress: {
      labels: { all: 'All', sent: 'Sent', projects: 'Projects' } as unknown as Record<never, string>,
      selected: 'all',
      onSelect: vi.fn(),
      showMyRating: true,
    } as unknown as ClimbFilterFormInput['progress'],
    collection: {
      options: [{ key: 'all', label: 'All' }],
      selected: 'all',
      onSelect: vi.fn(),
    } as unknown as ClimbFilterFormInput['collection'],
    popularity: { onStatusChange: vi.fn(), onBucket: vi.fn() },
    climbType: {
      show: true,
      options: [
        { key: 'boulders', label: 'Boulders' },
        { key: 'routes', label: 'Routes' },
      ],
      selected: 'boulders',
      onSelect: vi.fn(),
    } as unknown as ClimbFilterFormInput['climbType'],
    showOtherAngles: true,
    tall: { show: true, locked: false },
    wide: { show: true, locked: false },
    showFollowing: true,
    showBeta: true,
    boardFit: null,
    pickers: {
      setters: { show: true, disabled: false, value: 'None', onPress: vi.fn() },
      holds: { show: true, disabled: false, value: 'None', onPress: vi.fn() },
      zone: { show: true, disabled: false, value: 'None', onPress: vi.fn() },
    },
    sort: {
      kind: 'climbs',
      sortBy: 'popular',
      sortOrder: 'desc',
      labels: { popular: 'Popular', difficulty: 'Difficulty', random: 'Random' } as unknown as Record<never, string>,
      orderOptions: [
        { key: 'asc', label: 'Asc' },
        { key: 'desc', label: 'Desc' },
      ],
      onSortBy: vi.fn(),
      onSortOrder: vi.fn(),
      onReshuffle: vi.fn(),
    } as unknown as ClimbFilterFormInput['sort'],
    quickFilters: { label: 'Quick filters', footer: 'Footer', onPress: vi.fn() },
    setFiltersPatch: vi.fn(),
    ...overrides,
  };
}

function sectionOf(input: ClimbFilterFormInput, key: string) {
  const section = buildClimbFilterFormModel(input).sections.find((entry) => entry.key === key);
  if (!section) throw new Error(`no section ${key}`);
  return section;
}

function rowOf<Kind extends ClimbFilterFormRow['kind']>(
  input: ClimbFilterFormInput,
  sectionKey: string,
  rowKey: string,
  kind: Kind,
): Extract<ClimbFilterFormRow, { kind: Kind }> {
  const row = sectionOf(input, sectionKey).rows.find((entry) => entry.key === rowKey);
  if (!row || row.kind !== kind) throw new Error(`no ${kind} row ${rowKey} in ${sectionKey}`);
  return row as Extract<ClimbFilterFormRow, { kind: Kind }>;
}

function rowKeys(rows: ClimbFilterFormRow[]): string[] {
  return rows.map((row) => row.key);
}

describe('buildClimbFilterFormModel', () => {
  it('lays a full Climbs input out in the RN sheet order', () => {
    const { sections } = buildClimbFilterFormModel(makeInput());
    expect(sections.map((section) => section.key)).toEqual([
      'name',
      'difficulty',
      'progress',
      'quality',
      'theClimb',
      'pickers',
      'sort',
      'quickFilters',
    ]);
  });

  describe('hiding', () => {
    it('drops Progress when progress is null', () => {
      const keys = buildClimbFilterFormModel(makeInput({ progress: null })).sections.map((section) => section.key);
      expect(keys).not.toContain('progress');
    });

    it('drops Recent with no footer when recent is null', () => {
      const name = sectionOf(makeInput({ recent: null }), 'name');
      expect(rowKeys(name.rows)).toEqual(['name']);
      expect(name.footer).toBeUndefined();
    });

    it('gives the recentDescription footer and no menu row for zero recents', () => {
      const name = sectionOf(makeInput(), 'name');
      expect(rowKeys(name.rows)).toEqual(['name']);
      expect(name.footer).toBe('mobile.filter.recentDescription');
    });

    it('gives a menu row whose value is the current item and which checks it', () => {
      const onSelect = vi.fn();
      const recent = {
        items: [
          { id: 'a', label: 'Alpha' },
          { id: 'b', label: 'Beta' },
        ],
        currentId: 'b',
        onSelect,
      } as unknown as NonNullable<ClimbFilterFormInput['recent']>;
      const input = makeInput({ recent });
      const menu = rowOf(input, 'name', 'recent', 'menu');
      expect(menu.value).toBe('Beta');
      expect(menu.items).toEqual([
        { key: 'a', label: 'Alpha', checked: false },
        { key: 'b', label: 'Beta', checked: true },
      ]);
      expect(sectionOf(input, 'name').footer).toBeUndefined();
      menu.onSelect('a');
      expect(onSelect).toHaveBeenCalledWith('a');
    });

    it('leaves the menu value undefined when no recent is current', () => {
      const recent = {
        items: [{ id: 'a', label: 'Alpha' }],
        currentId: undefined,
        onSelect: vi.fn(),
      } as unknown as NonNullable<ClimbFilterFormInput['recent']>;
      expect(rowOf(makeInput({ recent }), 'name', 'recent', 'menu').value).toBeUndefined();
    });
  });

  describe('picker rows', () => {
    const picker = (overrides: Partial<ClimbFilterFormInput['pickers']['setters']>) => ({
      show: true,
      disabled: false,
      value: 'None',
      onPress: vi.fn(),
      ...overrides,
    });

    it('puts Following between Setters and Hold types', () => {
      expect(rowKeys(sectionOf(makeInput(), 'pickers').rows)).toEqual(['setters', 'following', 'holds', 'zone']);
    });

    it.each([
      ['show: false', { show: false }],
      ['disabled: true', { disabled: true }],
    ])('leaves a picker out with %s', (_label, overrides) => {
      const input = makeInput({
        pickers: { setters: picker(overrides), holds: picker({}), zone: picker({}) },
      });
      expect(rowKeys(sectionOf(input, 'pickers').rows)).toEqual(['following', 'holds', 'zone']);
    });

    it('drops the section when it has no rows', () => {
      const input = makeInput({
        showFollowing: false,
        pickers: {
          setters: picker({ show: false }),
          holds: picker({ disabled: true }),
          zone: picker({ show: false }),
        },
      });
      const keys = buildClimbFilterFormModel(input).sections.map((section) => section.key);
      expect(keys).not.toContain('pickers');
    });

    it('wires a nav row to its picker value and press', () => {
      const onPress = vi.fn();
      const input = makeInput({
        pickers: {
          setters: picker({ value: '2 setters', onPress }),
          holds: picker({}),
          zone: picker({}),
        },
      });
      const nav = rowOf(input, 'pickers', 'setters', 'nav');
      expect(nav.value).toBe('2 setters');
      nav.onPress();
      expect(onPress).toHaveBeenCalledOnce();
    });
  });

  describe('handlers', () => {
    it("My rating '3' patches minUserRating 3 and 'any' clears it", () => {
      const setFiltersPatch = vi.fn();
      const row = rowOf(makeInput({ setFiltersPatch }), 'progress', 'myRating', 'select');
      row.onSelect('3');
      expect(setFiltersPatch).toHaveBeenLastCalledWith({ minUserRating: 3 });
      row.onSelect('any');
      expect(setFiltersPatch).toHaveBeenLastCalledWith({ minUserRating: undefined });
    });

    it("Min rating '3' patches minRating 3 and 'any' clears it", () => {
      const setFiltersPatch = vi.fn();
      const row = rowOf(makeInput({ setFiltersPatch }), 'quality', 'minRating', 'select');
      row.onSelect('3');
      expect(setFiltersPatch).toHaveBeenLastCalledWith({ minRating: 3 });
      row.onSelect('any');
      expect(setFiltersPatch).toHaveBeenLastCalledWith({ minRating: undefined });
    });

    it('selects the current star count, or any', () => {
      const withRating = makeInput({ filters: { ...baseFilters, minRating: 4 } });
      expect(rowOf(withRating, 'quality', 'minRating', 'select').selectedKey).toBe('4');
      expect(rowOf(makeInput(), 'quality', 'minRating', 'select').selectedKey).toBe('any');
    });

    it('routes Popularity: projects to status, a bucket to onBucket, any to undefined', () => {
      const popularity = { onStatusChange: vi.fn(), onBucket: vi.fn() };
      const row = rowOf(makeInput({ popularity }), 'quality', 'popularity', 'select');
      row.onSelect('projects');
      expect(popularity.onStatusChange).toHaveBeenCalledWith('projects');
      expect(popularity.onBucket).not.toHaveBeenCalled();
      row.onSelect('10');
      expect(popularity.onBucket).toHaveBeenLastCalledWith(10);
      row.onSelect('any');
      expect(popularity.onBucket).toHaveBeenLastCalledWith(undefined);
    });

    it('reads the Popularity selection from status and minAscents', () => {
      const projects = makeInput({ filters: { ...baseFilters, status: 'projects' } as ClimbFilters });
      expect(rowOf(projects, 'quality', 'popularity', 'select').selectedKey).toBe('projects');
      const bucket = makeInput({ filters: { ...baseFilters, minAscents: 100 } as ClimbFilters });
      expect(rowOf(bucket, 'quality', 'popularity', 'select').selectedKey).toBe('100');
      expect(rowOf(makeInput(), 'quality', 'popularity', 'select').selectedKey).toBe('any');
    });

    it('sets a toggle to true or undefined, never false', () => {
      const setFiltersPatch = vi.fn();
      const input = makeInput({ setFiltersPatch });
      const cases: [string, string, string][] = [
        ['theClimb', 'beta', 'onlyWithBetaVideos'],
        ['theClimb', 'tall', 'onlyTallClimbs'],
        ['theClimb', 'wide', 'onlyWideClimbs'],
        ['theClimb', 'otherAngles', 'includeOtherAngles'],
        ['pickers', 'following', 'onlyFollowedAuthors'],
        ['progress', 'onlyRatedByMe', 'onlyRatedByMe'],
      ];
      for (const [sectionKey, rowKey, field] of cases) {
        const row = rowOf(input, sectionKey, rowKey, 'toggle');
        row.onValueChange(true);
        expect(setFiltersPatch).toHaveBeenLastCalledWith({ [field]: true });
        row.onValueChange(false);
        expect(setFiltersPatch).toHaveBeenLastCalledWith({ [field]: undefined });
      }
    });

    it('hides My rating rows and the footer when showMyRating is false', () => {
      const progress = { ...makeInput().progress!, showMyRating: false };
      const section = sectionOf(makeInput({ progress }), 'progress');
      expect(rowKeys(section.rows)).toEqual(['progress']);
      expect(section.footer).toBeUndefined();
    });
  });

  describe('Tall and Wide', () => {
    it('shows a locked Tall as on, disabled, with the locked hint', () => {
      const row = rowOf(makeInput({ tall: { show: true, locked: true } }), 'theClimb', 'tall', 'toggle');
      expect(row.value).toBe(true);
      expect(row.disabled).toBe(true);
      expect(row.subtitle).toBe('mobile.filter.tallLockedHint');
    });

    it('shows an unlocked Tall from the filter with its description', () => {
      const row = rowOf(makeInput(), 'theClimb', 'tall', 'toggle');
      expect(row.value).toBe(false);
      expect(row.disabled).toBe(false);
      expect(row.subtitle).toBe('mobile.filter.tallDescription');
    });

    it('leaves Tall and Wide out when not shown', () => {
      const input = makeInput({ tall: { show: false, locked: false }, wide: { show: false, locked: false } });
      expect(rowKeys(sectionOf(input, 'theClimb').rows)).not.toContain('tall');
      expect(rowKeys(sectionOf(input, 'theClimb').rows)).not.toContain('wide');
    });
  });

  describe('sort', () => {
    it('gives a Climbs sort a segmented order row', () => {
      const sort = rowOf(makeInput(), 'sort', 'sortOrder', 'segmented');
      expect(sort.selectedKey).toBe('desc');
    });

    it('swaps the order row for a reshuffle button on random', () => {
      const onReshuffle = vi.fn();
      const base = makeInput().sort as Extract<ClimbFilterFormInput['sort'], { kind: 'climbs' }>;
      const input = makeInput({ sort: { ...base, sortBy: 'random', onReshuffle } });
      expect(rowKeys(sectionOf(input, 'sort').rows)).toEqual(['sortBy', 'reshuffle']);
      rowOf(input, 'sort', 'reshuffle', 'button').onPress();
      expect(onReshuffle).toHaveBeenCalledOnce();
    });

    it('forwards the Climbs sort-by key', () => {
      const onSortBy = vi.fn();
      const base = makeInput().sort as Extract<ClimbFilterFormInput['sort'], { kind: 'climbs' }>;
      const input = makeInput({ sort: { ...base, onSortBy } });
      rowOf(input, 'sort', 'sortBy', 'select').onSelect('difficulty');
      expect(onSortBy).toHaveBeenCalledWith('difficulty');
    });

    const listSort = (overrides: Record<string, unknown>) =>
      ({
        kind: 'list',
        options: [{ key: 'name', label: 'Name' }],
        selected: 'name',
        orderOptions: [{ key: 'asc', label: 'Asc' }],
        order: 'asc',
        showReshuffle: false,
        onSelect: vi.fn(),
        onOrderChange: vi.fn(),
        onReshuffle: vi.fn(),
        ...overrides,
      }) as unknown as ClimbFilterFormInput['sort'];

    it('gives a list sort a reshuffle button when showReshuffle is set', () => {
      const input = makeInput({ sort: listSort({ showReshuffle: true }) });
      expect(rowKeys(sectionOf(input, 'sort').rows)).toEqual(['sortBy', 'reshuffle']);
    });

    it('gives a list sort no order row when orderOptions is null', () => {
      const input = makeInput({ sort: listSort({ orderOptions: null }) });
      expect(rowKeys(sectionOf(input, 'sort').rows)).toEqual(['sortBy']);
    });

    it('gives a list sort an order row that forwards the order', () => {
      const onOrderChange = vi.fn();
      const input = makeInput({ sort: listSort({ onOrderChange }) });
      rowOf(input, 'sort', 'sortOrder', 'segmented').onSelect('asc');
      expect(onOrderChange).toHaveBeenCalledWith('asc');
    });
  });

  describe('row kinds', () => {
    it('makes Grade accuracy and Collection menu rows and climb type segmented', () => {
      const input = makeInput();
      expect(rowOf(input, 'difficulty', 'accuracy', 'select').selectedKey).toBe('off');
      rowOf(input, 'quality', 'collection', 'select');
      rowOf(input, 'theClimb', 'climbType', 'segmented');
    });

    it('hosts the grade rail as a full-bleed custom row of the stated height', () => {
      const row = rowOf(makeInput({ grade: { rail: null, height: 70 } }), 'difficulty', 'grade', 'custom');
      expect(row.height).toBe(70);
      expect(row.fullBleed).toBe(true);
    });
  });

  describe('Quick filters', () => {
    it('ends on a single nav row that calls quickFilters.onPress', () => {
      const onPress = vi.fn();
      const input = makeInput({ quickFilters: { label: 'Quick filters', footer: 'Footer', onPress } });
      const { sections } = buildClimbFilterFormModel(input);
      const last = sections.at(-1)!;
      expect(last.key).toBe('quickFilters');
      expect(last.footer).toBe('Footer');
      expect(last.rows).toHaveLength(1);
      const row: MoreRow = last.rows[0] as MoreRow;
      expect(row.kind).toBe('nav');
      (row as Extract<MoreRow, { kind: 'nav' }>).onPress();
      expect(onPress).toHaveBeenCalledOnce();
    });
  });
});
