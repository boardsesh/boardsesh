import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import {
  DEFAULT_LOGBOOK_FILTERS,
  DEFAULT_LOGBOOK_SORT,
  filtersForStatusSegment,
  logbookSortFor,
  type LogbookFilterState,
} from '@boardsesh/logbook';
import type {
  Capsule,
  MenuCapsule,
  RailCapsule,
  SheetCapsule,
  ToggleCapsule,
} from '../../filter-capsules/CapsuleRow.types';
import type { NamedGradeStop } from '../../../lib/grade-stops';
import {
  LOGBOOK_DEFAULT_PINNED_CHIPS,
  LOGBOOK_PINNABLE_CHIP_CATALOG,
  type LogbookPinnableChipKind,
} from '../../../lib/logbook-pinnable-chips';
import {
  buildLogbookCapsules,
  buildLogbookFilterTokens,
  countLogbookFilters,
  type LogbookCapsuleInput,
  type LogbookTokenInput,
} from '../logbook-capsules';
import type { LogbookBoardOption } from '../use-logbook-board-options';

// Returns the key with its interpolations, so each assertion names the exact
// catalog key in play.
const mockT = ((key: string, options?: Record<string, unknown>) =>
  options == null ? key : `${key}(${Object.values(options).join(',')})`) as unknown as TFunction<'you'>;

const GRADE_STOPS: NamedGradeStop[] = [
  { minGradeId: 16, maxGradeId: 16, label: 'V3', gradeLabels: [{ difficultyId: 16, label: 'V3' }] },
  { minGradeId: 18, maxGradeId: 18, label: 'V4', gradeLabels: [{ difficultyId: 18, label: 'V4' }] },
  { minGradeId: 20, maxGradeId: 20, label: 'V5', gradeLabels: [{ difficultyId: 20, label: 'V5' }] },
];

const BOARDS: LogbookBoardOption[] = [
  {
    boardType: 'kilter',
    label: 'Kilter',
    layouts: [
      { layoutId: 1, label: 'Kilter Original' },
      { layoutId: 8, label: 'Kilter Homewall' },
    ],
  },
  { boardType: 'tension', label: 'Tension', layouts: [{ layoutId: 10, label: 'Tension 2 Mirror' }] },
];

function filtersWith(patch: Partial<LogbookFilterState>): LogbookFilterState {
  return { ...DEFAULT_LOGBOOK_FILTERS, ...patch };
}

function makeInput(overrides: Partial<LogbookCapsuleInput> = {}): LogbookCapsuleInput {
  return {
    pinned: LOGBOOK_DEFAULT_PINNED_CHIPS,
    filters: DEFAULT_LOGBOOK_FILTERS,
    sort: DEFAULT_LOGBOOK_SORT,
    name: '',
    viewerIsOwner: true,
    gradeStops: GRADE_STOPS,
    boardOptions: BOARDS,
    openRail: null,
    locale: 'en-US',
    onOpenFilters: vi.fn(),
    onOpenCustomDates: vi.fn(),
    onToggleRail: vi.fn(),
    onChangeFilters: vi.fn(),
    onChangeSort: vi.fn(),
    onOpenSetters: vi.fn(),
    ...overrides,
  };
}

function makeTokenInput(overrides: Partial<LogbookTokenInput> = {}): LogbookTokenInput {
  return {
    pinned: LOGBOOK_DEFAULT_PINNED_CHIPS,
    filters: DEFAULT_LOGBOOK_FILTERS,
    sort: DEFAULT_LOGBOOK_SORT,
    name: '',
    viewerIsOwner: true,
    gradeStops: GRADE_STOPS,
    boardOptions: BOARDS,
    locale: 'en-US',
    onChangeFilters: vi.fn(),
    onChangeSort: vi.fn(),
    onClearName: vi.fn(),
    ...overrides,
  };
}

function capsuleFor<K extends Capsule['kind']>(
  capsules: Capsule[],
  key: string,
  kind: K,
): Extract<Capsule, { kind: K }> {
  const capsule = capsules.find((candidate) => candidate.key === key);
  if (!capsule || capsule.kind !== kind) throw new Error(`no ${kind} capsule "${key}"`);
  return capsule as Extract<Capsule, { kind: K }>;
}

const ALL_PINNED: readonly LogbookPinnableChipKind[] = LOGBOOK_PINNABLE_CHIP_CATALOG;

describe('buildLogbookCapsules order and pins', () => {
  it('leads with Filters, then the default pins in catalog order', () => {
    const capsules = buildLogbookCapsules(makeInput(), mockT);
    expect(capsules.map((capsule) => `${capsule.key}:${capsule.kind}`)).toEqual([
      'filters:sheet',
      'grade:rail',
      'status:menu',
      'date:menu',
      'angle:rail',
      'sort:menu',
    ]);
  });

  it('draws every pinned kind in catalog order, whatever order the pins were saved in', () => {
    const capsules = buildLogbookCapsules(makeInput({ pinned: [...ALL_PINNED].reverse() }), mockT);
    expect(capsules.map((capsule) => capsule.key)).toEqual([
      'filters',
      'grade',
      'status',
      'stars',
      'date',
      'board',
      'angle',
      'setter',
      'benchmarks',
      'sort',
    ]);
  });

  it('drops an unpinned kind', () => {
    const capsules = buildLogbookCapsules(makeInput({ pinned: ['sort'] }), mockT);
    expect(capsules.map((capsule) => capsule.key)).toEqual(['filters', 'sort']);
  });

  it('hides Board with fewer than two boards to pick, unless one is already set', () => {
    const oneBoard = BOARDS.slice(0, 1);
    expect(
      buildLogbookCapsules(makeInput({ pinned: ['board'], boardOptions: oneBoard }), mockT).map(
        (capsule) => capsule.key,
      ),
    ).toEqual(['filters']);
    const stale = buildLogbookCapsules(
      makeInput({ pinned: ['board'], boardOptions: oneBoard, filters: filtersWith({ boardType: 'moonboard' }) }),
      mockT,
    );
    const board = capsuleFor(stale, 'board', 'menu');
    // The saved board stays listed so it can be cleared.
    expect(board.options.map((option) => option.value)).toEqual(['all', 'kilter', 'moonboard']);
    expect(board.selected).toBe('moonboard');
  });
});

describe('Filters · N', () => {
  it('rests as "Filters" with no count', () => {
    const filters = capsuleFor(buildLogbookCapsules(makeInput(), mockT), 'filters', 'sheet');
    expect(filters.label).toBe('mobile.logbook.capsules.filters');
    expect(filters.count).toBe(0);
    expect(filters.icon).toBe('filters');
  });

  it('counts each active dimension once, plus the climb-name search', () => {
    const input = makeInput({
      name: ' crimp ',
      filters: filtersWith({ ...filtersForStatusSegment('flashes'), minGrade: 16, maxGrade: 18 }),
    });
    const filters = capsuleFor(buildLogbookCapsules(input, mockT), 'filters', 'sheet');
    expect(filters.count).toBe(3);
    expect(filters.label).toBe('mobile.logbook.capsules.filtersWithCount(3)');
    expect(countLogbookFilters(input.filters, '   ')).toBe(2);
  });

  it('opens the sheet', () => {
    const input = makeInput();
    capsuleFor(buildLogbookCapsules(input, mockT), 'filters', 'sheet').onPress();
    expect(input.onOpenFilters).toHaveBeenCalledTimes(1);
  });
});

describe('rail capsules', () => {
  it('names the grade bound the way the rail does, and rests as "Grade"', () => {
    const resting = capsuleFor(buildLogbookCapsules(makeInput(), mockT), 'grade', 'rail');
    expect(resting).toMatchObject({ label: 'mobile.logbook.grade', active: false, expanded: false });

    const range = (patch: Partial<LogbookFilterState>) =>
      capsuleFor(buildLogbookCapsules(makeInput({ filters: filtersWith(patch) }), mockT), 'grade', 'rail');
    expect(range({ minGrade: 16, maxGrade: 20 })).toMatchObject({ label: 'V3–V5', active: true });
    expect(range({ minGrade: 18, maxGrade: 18 }).label).toBe('V4');
    expect(range({ minGrade: 18 }).label).toBe('≥V4');
    expect(range({ maxGrade: 18 }).label).toBe('≤V4');
  });

  it('keeps an active grade lit, with its plain name, while the scale loads', () => {
    const grade = capsuleFor(
      buildLogbookCapsules(makeInput({ gradeStops: [], filters: filtersWith({ minGrade: 18 }) }), mockT),
      'grade',
      'rail',
    );
    expect(grade).toMatchObject({ label: 'mobile.logbook.grade', active: true });
  });

  it('names an angle range with a true minus sign', () => {
    const angle = (range: [number, number]) =>
      capsuleFor(
        buildLogbookCapsules(makeInput({ filters: filtersWith({ angleRange: range }) }), mockT),
        'angle',
        'rail',
      );
    expect(capsuleFor(buildLogbookCapsules(makeInput(), mockT), 'angle', 'rail')).toMatchObject({
      label: 'mobile.logbook.angle',
      active: false,
    });
    expect(angle([20, 40])).toMatchObject({ label: '20°–40°', active: true });
    expect(angle([-5, -5]).label).toBe('−5°');
  });

  it('marks the open rail expanded, flips its hint, and reports the tap with its own kind', () => {
    const input = makeInput({ openRail: 'angle' });
    const capsules = buildLogbookCapsules(input, mockT);
    const grade = capsuleFor(capsules, 'grade', 'rail');
    const angle = capsuleFor(capsules, 'angle', 'rail');
    expect(grade.expanded).toBe(false);
    expect(grade.accessibilityHint).toBe('mobile.logbook.capsules.gradeOpenHint');
    expect(angle.expanded).toBe(true);
    expect(angle.accessibilityHint).toBe('mobile.logbook.capsules.angleCloseHint');
    angle.onPress();
    grade.onPress();
    expect(vi.mocked(input.onToggleRail).mock.calls).toEqual([['angle'], ['grade']]);
  });
});

describe('Status', () => {
  it('offers the four segments and writes the stored fields for the picked one', () => {
    const input = makeInput();
    const status = capsuleFor(buildLogbookCapsules(input, mockT), 'status', 'menu');
    expect(status.label).toBe('mobile.logbook.capsules.status');
    expect(status.active).toBe(false);
    expect(status.selected).toBe('all');
    expect(status.options.map((option) => option.value)).toEqual(['all', 'sends', 'flashes', 'attempts']);
    status.onSelect('flashes');
    status.onSelect('nonsense');
    expect(vi.mocked(input.onChangeFilters).mock.calls).toEqual([
      [{ includeSends: true, includeAttempts: false, flashOnly: true }],
    ]);
  });

  it('reads a stored sends + attempts + flash only as Flashes', () => {
    const status = capsuleFor(
      buildLogbookCapsules(makeInput({ filters: filtersWith({ flashOnly: true }) }), mockT),
      'status',
      'menu',
    );
    expect(status).toMatchObject({ label: 'mobile.logbook.status.flashes', active: true, selected: 'flashes' });
  });
});

describe('Stars', () => {
  it('offers Any and 1★+ to 5★, and writes the minimum', () => {
    const input = makeInput({ pinned: ['stars'] });
    const stars = capsuleFor(buildLogbookCapsules(input, mockT), 'stars', 'menu');
    expect(stars).toMatchObject({ label: 'mobile.logbook.capsules.stars', active: false, selected: 'any' });
    expect(stars.options.map((option) => option.label)).toEqual([
      'mobile.logbook.capsules.anyStars',
      'mobile.logbook.capsules.starsAtLeast(1)',
      'mobile.logbook.capsules.starsAtLeast(2)',
      'mobile.logbook.capsules.starsAtLeast(3)',
      'mobile.logbook.capsules.starsAtLeast(4)',
      'mobile.logbook.row.stars(5)',
    ]);
    stars.onSelect('3');
    stars.onSelect('any');
    stars.onSelect('9');
    stars.onSelect('two');
    expect(vi.mocked(input.onChangeFilters).mock.calls).toEqual([[{ minQuality: 3 }], [{ minQuality: '' }]]);
  });

  it('labels an active minimum', () => {
    const stars = capsuleFor(
      buildLogbookCapsules(makeInput({ pinned: ['stars'], filters: filtersWith({ minQuality: 3 }) }), mockT),
      'stars',
      'menu',
    );
    expect(stars).toMatchObject({ label: 'mobile.logbook.capsules.starsAtLeast(3)', active: true, selected: '3' });
  });
});

describe('When', () => {
  it('offers the rolling windows, and Custom… as a command that opens the When section', () => {
    const input = makeInput();
    const when = capsuleFor(buildLogbookCapsules(input, mockT), 'date', 'menu');
    expect(when).toMatchObject({ label: 'mobile.logbook.capsules.when', active: false, selected: 'any' });
    expect(when.options.map((option) => option.value)).toEqual(['any', 'last7', 'month', 'last3months', 'year']);
    when.onSelect('month');
    when.onSelect('custom-ish');
    when.actions?.[0].onPress();
    expect(when.actions?.map((action) => action.label)).toEqual(['mobile.logbook.capsules.customDates']);
    expect(vi.mocked(input.onChangeFilters).mock.calls).toEqual([
      [{ dateWindow: 'month' }],
      [{ dateWindow: 'custom' }],
    ]);
    expect(input.onOpenCustomDates).toHaveBeenCalledTimes(1);
    expect(input.onOpenFilters).not.toHaveBeenCalled();
  });

  it('labels a window by name and a custom range by its dates', () => {
    const when = (patch: Partial<LogbookFilterState>, input: Partial<LogbookCapsuleInput> = {}) =>
      capsuleFor(buildLogbookCapsules(makeInput({ ...input, filters: filtersWith(patch) }), mockT), 'date', 'menu');
    expect(when({ dateWindow: 'month' })).toMatchObject({ label: 'mobile.logbook.dateWindow.month', active: true });
    const custom = when({ dateWindow: 'custom', fromDate: '2026-06-03', toDate: '2026-06-30' });
    expect(custom).toMatchObject({ label: 'Jun 3 – Jun 30', active: true, selected: undefined });
    expect(when({ dateWindow: 'custom', fromDate: '2026-06-03' }).label).toBe('mobile.logbook.dateSince(Jun 3)');
    expect(when({ dateWindow: 'custom', toDate: '2026-06-30' }).label).toBe('mobile.logbook.dateUntil(Jun 30)');
    // A Custom window with no date picked narrows nothing.
    expect(when({ dateWindow: 'custom' })).toMatchObject({ label: 'mobile.logbook.capsules.when', active: false });
  });

  it('only opens the When section from Custom… when Custom is already the window', () => {
    const input = makeInput({ filters: filtersWith({ dateWindow: 'custom', fromDate: '2026-06-03' }) });
    capsuleFor(buildLogbookCapsules(input, mockT), 'date', 'menu').actions?.[0].onPress();
    expect(input.onChangeFilters).not.toHaveBeenCalled();
    expect(input.onOpenCustomDates).toHaveBeenCalledTimes(1);
  });
});

describe('Board', () => {
  it('offers All boards and the logged boards, and clears layouts on a switch', () => {
    const input = makeInput({ pinned: ['board'] });
    const board = capsuleFor(buildLogbookCapsules(input, mockT), 'board', 'menu');
    expect(board).toMatchObject({ label: 'mobile.logbook.capsules.board', active: false, selected: 'all' });
    expect(board.options).toEqual([
      { value: 'all', label: 'mobile.filter.allBoards' },
      { value: 'kilter', label: 'Kilter' },
      { value: 'tension', label: 'Tension' },
    ]);
    board.onSelect('tension');
    board.onSelect('all');
    expect(vi.mocked(input.onChangeFilters).mock.calls).toEqual([
      [{ boardType: 'tension', layoutIds: [] }],
      [{ boardType: '', layoutIds: [] }],
    ]);
  });

  it('names the board, its one layout, or how many layouts', () => {
    const board = (patch: Partial<LogbookFilterState>) =>
      capsuleFor(
        buildLogbookCapsules(makeInput({ pinned: ['board'], filters: filtersWith(patch) }), mockT),
        'board',
        'menu',
      ).label;
    expect(board({ boardType: 'kilter' })).toBe('Kilter');
    expect(board({ boardType: 'kilter', layoutIds: [8] })).toBe('Kilter Homewall');
    expect(board({ boardType: 'kilter', layoutIds: [1, 8] })).toBe('mobile.logbook.capsules.boardLayouts(Kilter,2)');
  });
});

describe('Setter and Benchmarks', () => {
  it('opens the setter picker and carries the pick count', () => {
    const input = makeInput({ pinned: ['setter'] });
    const resting = capsuleFor(buildLogbookCapsules(input, mockT), 'setter', 'sheet');
    expect(resting).toMatchObject({ label: 'mobile.logbook.capsules.setter', count: 0 });
    // A press event from the platform never reaches the handler.
    (resting.onPress as unknown as (event: unknown) => void)({ nativeEvent: {} });
    expect(input.onOpenSetters).toHaveBeenCalledTimes(1);
    expect(input.onOpenSetters).toHaveBeenCalledWith();

    const setter = (setterUsernames: string[]) =>
      capsuleFor(
        buildLogbookCapsules(makeInput({ pinned: ['setter'], filters: filtersWith({ setterUsernames }) }), mockT),
        'setter',
        'sheet',
      ) as SheetCapsule;
    expect(resting.accessibilityLabel).toBe('mobile.logbook.capsules.setterAria');
    // The spoken label replaces the visible one on iOS and the web, so it names the picks.
    expect(setter(['alex'])).toMatchObject({
      label: 'alex',
      count: 1,
      accessibilityLabel: 'mobile.logbook.capsules.setterPickedAria(alex)',
    });
    expect(setter(['alex', 'sam'])).toMatchObject({
      label: 'mobile.logbook.capsules.setters(2)',
      count: 2,
      accessibilityLabel: 'mobile.logbook.capsules.setterPickedAria(mobile.logbook.capsules.setters(2))',
    });
  });

  it('flips Benchmarks', () => {
    const input = makeInput({ pinned: ['benchmarks'], filters: filtersWith({ benchmarkOnly: true }) });
    const benchmarks = capsuleFor(buildLogbookCapsules(input, mockT), 'benchmarks', 'toggle') as ToggleCapsule;
    expect(benchmarks).toMatchObject({ label: 'mobile.logbook.capsules.benchmarks', active: true });
    benchmarks.onPress();
    expect(input.onChangeFilters).toHaveBeenCalledWith({ benchmarkOnly: false });
  });
});

describe('Sort', () => {
  it('rests on Latest, unlit', () => {
    const sort = capsuleFor(buildLogbookCapsules(makeInput(), mockT), 'sort', 'menu');
    expect(sort).toMatchObject({ label: 'mobile.logbook.sortLabel.latest', active: false, selected: 'date' });
  });

  it('names each option by what it gives, the current key in its current order', () => {
    const sort = capsuleFor(
      buildLogbookCapsules(makeInput({ sort: logbookSortFor('date', 'asc') }), mockT),
      'sort',
      'menu',
    ) as MenuCapsule;
    expect(sort).toMatchObject({ label: 'mobile.logbook.sortLabel.oldest', active: true });
    expect(sort.options.map((option) => option.label)).toEqual([
      'mobile.logbook.sortLabel.oldest',
      'mobile.logbook.sortLabel.hardest',
      'mobile.logbook.sortLabel.yourHardest',
      'mobile.logbook.sortLabel.nameAsc',
      'mobile.logbook.sortLabel.mostTries',
    ]);
  });

  it('never says "Your" on someone else\'s logbook', () => {
    const sort = capsuleFor(
      buildLogbookCapsules(makeInput({ viewerIsOwner: false, sort: logbookSortFor('loggedGrade', 'asc') }), mockT),
      'sort',
      'menu',
    );
    expect(sort.label).toBe('mobile.logbook.sortLabel.theirEasiest');
    expect(sort.options.map((option) => option.label)).not.toContain('mobile.logbook.sortLabel.yourHardest');
  });

  it('switches to a key in the order it opens with, and ignores the current key', () => {
    const input = makeInput();
    const sort = capsuleFor(buildLogbookCapsules(input, mockT), 'sort', 'menu');
    sort.onSelect('climbName');
    sort.onSelect('grade');
    sort.onSelect('date');
    sort.onSelect('bogus');
    expect(vi.mocked(input.onChangeSort).mock.calls).toEqual([
      [logbookSortFor('climbName', 'asc')],
      [logbookSortFor('grade', 'desc')],
    ]);
  });
});

describe('buildLogbookFilterTokens', () => {
  it('shows nothing for a resting logbook', () => {
    expect(buildLogbookFilterTokens(makeTokenInput(), mockT)).toEqual([]);
  });

  it('names the climb-name search first, then active filters whose capsule is not pinned', () => {
    const tokens = buildLogbookFilterTokens(
      makeTokenInput({
        name: ' crimp ',
        // Grade and status are pinned by default; stars, board and benchmarks are not.
        filters: filtersWith({
          minGrade: 16,
          ...filtersForStatusSegment('sends'),
          minQuality: 4,
          boardType: 'tension',
          benchmarkOnly: true,
        }),
      }),
      mockT,
    );
    expect(tokens.map((token) => [token.key, token.label])).toEqual([
      ['name', 'mobile.logbook.capsules.nameToken(crimp)'],
      ['stars', 'mobile.logbook.capsules.starsAtLeast(4)'],
      ['board', 'Tension'],
      ['benchmarks', 'mobile.logbook.capsules.benchmarks'],
    ]);
  });

  it('shows a token for a pinned kind once it is unpinned', () => {
    const input = makeTokenInput({
      pinned: [],
      filters: filtersWith({ angleRange: [30, 40] }),
      sort: logbookSortFor('grade', 'desc'),
    });
    expect(buildLogbookFilterTokens(input, mockT).map((token) => [token.key, token.label])).toEqual([
      ['angle', '30°–40°'],
      ['sort', 'mobile.logbook.sortLabel.hardest'],
    ]);
  });

  it('clears just its own filter', () => {
    const input = makeTokenInput({
      pinned: [],
      name: 'crimp',
      filters: filtersWith({
        minGrade: 16,
        maxGrade: 18,
        ...filtersForStatusSegment('attempts'),
        minQuality: 2,
        dateWindow: 'custom',
        fromDate: '2026-06-01',
        boardType: 'kilter',
        layoutIds: [1],
        angleRange: [20, 20],
        setterUsernames: ['alex'],
        benchmarkOnly: true,
      }),
      sort: logbookSortFor('attemptCount', 'desc'),
    });
    const tokens = buildLogbookFilterTokens(input, mockT);
    expect(tokens.map((token) => token.key)).toEqual([
      'name',
      'grade',
      'status',
      'stars',
      'date',
      'board',
      'angle',
      'setter',
      'benchmarks',
      'sort',
    ]);
    for (const token of tokens) token.clear();
    expect(input.onClearName).toHaveBeenCalledTimes(1);
    expect(vi.mocked(input.onChangeFilters).mock.calls).toEqual([
      [{ minGrade: '', maxGrade: '' }],
      [{ includeSends: true, includeAttempts: true, flashOnly: false }],
      [{ minQuality: '' }],
      [{ dateWindow: 'any', fromDate: '', toDate: '' }],
      [{ boardType: '', layoutIds: [] }],
      [{ angleRange: [-5, 70] }],
      [{ setterUsernames: [] }],
      [{ benchmarkOnly: false }],
    ]);
    expect(input.onChangeSort).toHaveBeenCalledWith(DEFAULT_LOGBOOK_SORT);
  });
});

describe('rail capsule shape', () => {
  it('never carries a popover (the Logbook rails stay inline)', () => {
    const grade = capsuleFor(buildLogbookCapsules(makeInput(), mockT), 'grade', 'rail') as RailCapsule;
    expect(grade.popover).toBeUndefined();
  });
});
