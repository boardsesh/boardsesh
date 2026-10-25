import { describe, it, expect } from 'vitest';
import type { Gym, UserBoard } from '@boardsesh/shared-schema';
import {
  buildGymListRows,
  filterBoardsByChips,
  findRowIndex,
  type GymListLabels,
  type GymListRow,
} from '../gym-list-rows';

// ── Factory helpers (only the fields the builder reads) ──────────────────

function makeGym(uuid: string, overrides: Partial<Gym> = {}): Gym {
  return {
    uuid,
    name: `Gym ${uuid}`,
    address: null,
    boardCount: 0,
    latitude: 1,
    longitude: 2,
    ...overrides,
  } as unknown as Gym;
}

function makeBoard(uuid: string, overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid,
    name: `Board ${uuid}`,
    boardType: 'kilter',
    gymUuid: null,
    locationName: null,
    latitude: 1,
    longitude: 2,
    ...overrides,
  } as unknown as UserBoard;
}

const labels: GymListLabels = {
  gymsSection: 'GYMS',
  otherBoards: 'OTHER BOARDS',
  empty: 'No gyms here',
  boardCount: (count) => `${count} boards`,
};

function build(overrides: Partial<Parameters<typeof buildGymListRows>[0]> = {}): GymListRow[] {
  return buildGymListRows({
    gyms: [],
    boardsByGym: new Map(),
    standaloneBoards: [],
    expandedGymUuid: null,
    selectedId: null,
    gymsLoading: false,
    labels,
    ...overrides,
  });
}

describe('buildGymListRows', () => {
  it('always leads with the gyms section header', () => {
    const rows = build();
    expect(rows[0]).toEqual({ kind: 'sectionHeader', key: 'sh:gyms', label: 'GYMS' });
  });

  it('shows a loading row only while loading with no gyms yet', () => {
    expect(build({ gymsLoading: true }).some((row) => row.kind === 'loading')).toBe(true);
    // Once gyms have loaded, no spinner even if a refetch is in flight.
    expect(build({ gymsLoading: true, gyms: [makeGym('a')] }).some((row) => row.kind === 'loading')).toBe(false);
  });

  it('shows the empty row when not loading and there are no gyms', () => {
    const rows = build();
    expect(rows.some((row) => row.kind === 'empty' && row.label === 'No gyms here')).toBe(true);
  });

  it('renders an address subtitle when present, else falls back to the board count', () => {
    const rows = build({
      gyms: [makeGym('withAddr', { address: '12 Crag St' }), makeGym('noAddr', { boardCount: 3 })],
    });
    const withAddr = rows.find((row) => row.kind === 'gym' && row.gym.uuid === 'withAddr');
    const noAddr = rows.find((row) => row.kind === 'gym' && row.gym.uuid === 'noAddr');
    expect(withAddr?.kind === 'gym' && withAddr.subtitle).toBe('12 Crag St');
    expect(noAddr?.kind === 'gym' && noAddr.subtitle).toBe('3 boards');
  });

  it('falls back to the indexed board count when boardCount is absent', () => {
    const gym = makeGym('g', { boardCount: undefined as unknown as number });
    const boardsByGym = new Map([['g', [makeBoard('b1', { gymUuid: 'g' }), makeBoard('b2', { gymUuid: 'g' })]]]);
    const rows = build({ gyms: [gym], boardsByGym });
    const gymRow = rows.find((row) => row.kind === 'gym');
    expect(gymRow?.kind === 'gym' && gymRow.subtitle).toBe('2 boards');
  });

  it('carries a gym’s boards and reflects the expanded/selected flags', () => {
    const boards = [makeBoard('b1', { gymUuid: 'g' })];
    const rows = build({
      gyms: [makeGym('g')],
      boardsByGym: new Map([['g', boards]]),
      expandedGymUuid: 'g',
      selectedId: 'g',
    });
    const gymRow = rows.find((row) => row.kind === 'gym');
    expect(gymRow?.kind).toBe('gym');
    if (gymRow?.kind !== 'gym') throw new Error('expected gym row');
    expect(gymRow.expanded).toBe(true);
    expect(gymRow.selected).toBe(true);
    expect(gymRow.boards).toEqual(boards);
  });

  it('appends the standalone section with its own header and selection flags', () => {
    const rows = build({
      standaloneBoards: [makeBoard('s1', { locationName: 'The Shed' }), makeBoard('s2')],
      selectedId: 's2',
    });
    const headerIndex = rows.findIndex((row) => row.kind === 'sectionHeader' && row.key === 'sh:other');
    expect(headerIndex).toBeGreaterThan(0);
    const s1 = rows.find((row) => row.kind === 'standalone' && row.board.uuid === 's1');
    const s2 = rows.find((row) => row.kind === 'standalone' && row.board.uuid === 's2');
    // Subtitle prefers locationName, else the board type.
    expect(s1?.kind === 'standalone' && s1.subtitle).toBe('The Shed');
    expect(s2?.kind === 'standalone' && s2.subtitle).toBe('kilter');
    expect(s2?.kind === 'standalone' && s2.selected).toBe(true);
    expect(s1?.kind === 'standalone' && s1.selected).toBe(false);
  });

  it('omits the standalone section entirely when there are no standalone boards', () => {
    const rows = build({ gyms: [makeGym('g')] });
    expect(rows.some((row) => row.kind === 'sectionHeader' && row.key === 'sh:other')).toBe(false);
  });

  it('keys every row uniquely so FlashList can track them', () => {
    const rows = build({
      gyms: [makeGym('g1'), makeGym('g2')],
      standaloneBoards: [makeBoard('s1')],
    });
    const keys = rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('findRowIndex', () => {
  it('locates a row by key and returns -1 when absent', () => {
    const rows = build({ gyms: [makeGym('g1')], standaloneBoards: [makeBoard('s1')] });
    expect(findRowIndex(rows, 'gym:g1')).toBeGreaterThanOrEqual(0);
    expect(rows[findRowIndex(rows, 'gym:g1')].key).toBe('gym:g1');
    expect(findRowIndex(rows, 'gym:missing')).toBe(-1);
  });
});

describe('expanded gym roster', () => {
  const gym = makeGym('g1');
  const gymRow = (rows: GymListRow[]) => rows.find((row) => row.kind === 'gym');

  it('lists boards the nearby search never returned', () => {
    const noPin = makeBoard('a', { gymUuid: 'g1', latitude: undefined, longitude: undefined });
    const row = gymRow(build({ gyms: [gym], expandedGymUuid: 'g1', expandedGymRoster: [noPin] }));
    expect(row && row.kind === 'gym' && row.boards).toEqual([noPin]);
  });

  it('puts roster boards first and dedupes nearby ones by uuid', () => {
    const a = makeBoard('a');
    const b = makeBoard('b');
    const nearbyB = makeBoard('b', { name: 'nearby copy' });
    const c = makeBoard('c');
    const row = gymRow(
      build({
        gyms: [gym],
        expandedGymUuid: 'g1',
        expandedGymRoster: [a, b],
        boardsByGym: new Map([['g1', [nearbyB, c]]]),
      }),
    );
    expect(row && row.kind === 'gym' && row.boards).toEqual([a, b, c]);
  });

  it('never gives the roster to a collapsed gym', () => {
    const row = gymRow(build({ gyms: [gym], expandedGymUuid: null, expandedGymRoster: [makeBoard('a')] }));
    expect(row && row.kind === 'gym' && row.boards).toEqual([]);
  });
});

describe('filterBoardsByChips', () => {
  const kilter = makeBoard('k', { boardType: 'kilter', layoutId: 1, sizeId: 10 });
  const tension = makeBoard('t', { boardType: 'tension', layoutId: 2, sizeId: 20 });

  it('keeps everything for an empty filter', () => {
    expect(filterBoardsByChips([kilter, tension], {})).toEqual([kilter, tension]);
  });

  it('narrows by board type, layout and size', () => {
    expect(filterBoardsByChips([kilter, tension], { boardTypes: ['kilter'] })).toEqual([kilter]);
    expect(filterBoardsByChips([kilter, tension], { layoutIds: [2] })).toEqual([tension]);
    expect(filterBoardsByChips([kilter, tension], { sizeIds: [10, 20], boardTypes: ['tension'] })).toEqual([tension]);
  });

  it('flags only the expanded gym as pending while its roster has not settled', () => {
    const other = makeGym('g2');
    const rows = build({ gyms: [makeGym('g1'), other], expandedGymUuid: 'g1', expandedGymRosterPending: true });
    const pending = rows.flatMap((row) => (row.kind === 'gym' ? [row.boardsPending] : []));
    expect(pending).toEqual([true, false]);
  });
});
