import { describe, expect, it } from 'vitest';
import type { Gym } from '@boardsesh/shared-schema';
import { buildGymPickRows, distanceBetweenMeters, gymPickSubtitle, type GymPickLabels } from '../gym-pick-rows';
import type { GymListRow } from '../gym-list-rows';

const labels: GymPickLabels = {
  section: 'Gyms near you',
  empty: 'No gyms nearby yet',
  offline: 'Offline',
  failed: "Couldn't search gyms",
  retry: 'Try again',
  boardCount: (count) => `${count} boards`,
  noBoards: 'No boards yet',
};

function makeGym(overrides: Partial<Gym>): Gym {
  return {
    uuid: 'gym',
    name: 'Gym',
    address: null,
    latitude: null,
    longitude: null,
    boardCount: 0,
    boardTypes: [],
    listingState: 'CLIMBER_LISTED',
    ...overrides,
  } as Gym;
}

// Amsterdam Centraal, and a gym about 1.2 km south-west of it.
const climber = { latitude: 52.3791, longitude: 4.9003 };
const nearby = makeGym({
  uuid: 'near',
  name: 'Boulderhal',
  address: 'Fokkerweg 75',
  latitude: 52.3705,
  longitude: 4.8888,
  boardCount: 3,
});

const kinds = (rows: GymListRow[]) => rows.map((row) => row.kind);

describe('gymPickSubtitle', () => {
  it('leads with the distance from the climber when their position is known', () => {
    expect(gymPickSubtitle(nearby, climber)).toBe('1.2 km · Fokkerweg 75');
  });

  it('shows only the address without the climber position, even near a searched town', () => {
    expect(gymPickSubtitle(nearby, null)).toBe('Fokkerweg 75');
  });

  it('shows the distance alone for a gym with no address, and leaves the line out with neither', () => {
    expect(gymPickSubtitle({ ...nearby, address: '  ' }, climber)).toBe('1.2 km');
    expect(gymPickSubtitle({ ...nearby, latitude: null }, null)).toBe('Fokkerweg 75');
    expect(gymPickSubtitle(makeGym({}), climber)).toBeNull();
  });

  it('measures great-circle distance', () => {
    expect(Math.round(distanceBetweenMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }))).toBe(
      111195,
    );
  });
});

describe('buildGymPickRows', () => {
  it('lists gyms as one card with their board pills and the tapped pin selected', () => {
    const empty = makeGym({ uuid: 'empty', name: 'Home Board' });
    const rows = buildGymPickRows({
      gyms: [nearby, empty],
      lookup: 'listed',
      origin: climber,
      selectedId: 'empty',
      labels,
    });
    expect(kinds(rows)).toEqual(['sectionHeader', 'pickGym', 'pickGym']);
    const [, first, second] = rows;
    expect(first).toMatchObject({ key: 'gym:near', boardsLabel: '3 boards', position: 'first', selected: false });
    expect(second).toMatchObject({
      key: 'gym:empty',
      subtitle: null,
      boardsLabel: 'No boards yet',
      position: 'last',
      selected: true,
    });
  });

  it('keeps every listing that shares a name: nothing is folded', () => {
    const twin = { ...nearby, uuid: 'twin', address: null };
    const rows = buildGymPickRows({ gyms: [nearby, twin], lookup: 'listed', origin: null, selectedId: null, labels });
    expect(rows.filter((row) => row.kind === 'pickGym')).toHaveLength(2);
  });

  it.each([
    { lookup: 'loading', expected: ['sectionHeader', 'loading'] },
    { lookup: 'empty', expected: ['sectionHeader', 'empty'] },
    { lookup: 'failed', expected: ['sectionHeader', 'empty'] },
    { lookup: 'offline', expected: ['sectionHeader', 'empty'] },
    { lookup: 'idle', expected: [] },
  ] as const)('$lookup: never draws a failure as an empty list', ({ lookup, expected }) => {
    const rows = buildGymPickRows({ gyms: [], lookup, origin: null, selectedId: null, labels });
    expect(kinds(rows)).toEqual(expected);
    const notice = rows.find((row) => row.kind === 'empty');
    // Only a failure offers Try again.
    if (lookup === 'failed')
      expect(notice).toEqual({ kind: 'empty', key: 'failed', label: labels.failed, retryLabel: 'Try again' });
    if (lookup === 'offline') expect(notice).toEqual({ kind: 'empty', key: 'offline', label: labels.offline });
    if (lookup === 'empty') expect(notice).toEqual({ kind: 'empty', key: 'empty', label: labels.empty });
  });
});
