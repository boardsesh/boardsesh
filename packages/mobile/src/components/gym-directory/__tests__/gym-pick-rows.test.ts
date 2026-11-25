import { describe, expect, it } from 'vitest';
import type { Gym } from '@boardsesh/shared-schema';
import {
  ADD_GYM_ROW_KEY,
  buildGymPickRows,
  distanceBetweenMeters,
  gymPickSubtitle,
  type GymPickLabels,
} from '../gym-pick-rows';
import type { GymListRow } from '../gym-list-rows';

const labels: GymPickLabels = {
  section: 'Gyms near you',
  empty: 'No gyms nearby yet',
  offline: 'Offline',
  failed: "Couldn't search gyms",
  boardCount: (count) => `${count} boards`,
  noBoards: 'No boards yet',
  noAddress: 'No address yet',
  addGymTitle: 'Add my gym',
  addGymSubtitle: 'Not listed? Add it with your board',
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
    expect(gymPickSubtitle(nearby, climber, labels.noAddress)).toBe('1.2 km · Fokkerweg 75');
  });

  it('shows only the address without the climber position, even near a searched town', () => {
    expect(gymPickSubtitle(nearby, null, labels.noAddress)).toBe('Fokkerweg 75');
  });

  it('shows the distance alone for a gym with no address, and says so when there is neither', () => {
    expect(gymPickSubtitle({ ...nearby, address: '  ' }, climber, labels.noAddress)).toBe('1.2 km');
    expect(gymPickSubtitle({ ...nearby, latitude: null }, null, labels.noAddress)).toBe('Fokkerweg 75');
    expect(gymPickSubtitle(makeGym({}), climber, labels.noAddress)).toBe('No address yet');
  });

  it('measures great-circle distance', () => {
    expect(Math.round(distanceBetweenMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }))).toBe(
      111195,
    );
  });
});

describe('buildGymPickRows', () => {
  it('lists gyms as one card with their board pills, the tapped pin selected, and Add my gym last', () => {
    const empty = makeGym({ uuid: 'empty', name: 'Home Board' });
    const rows = buildGymPickRows({
      gyms: [nearby, empty],
      lookup: 'listed',
      origin: climber,
      selectedId: 'empty',
      labels,
    });
    expect(kinds(rows)).toEqual(['sectionHeader', 'pickGym', 'pickGym', 'addGym']);
    const [, first, second, last] = rows;
    expect(first).toMatchObject({ key: 'gym:near', boardsLabel: '3 boards', position: 'first', selected: false });
    expect(second).toMatchObject({ key: 'gym:empty', boardsLabel: 'No boards yet', position: 'last', selected: true });
    expect(last).toMatchObject({ key: ADD_GYM_ROW_KEY, title: 'Add my gym' });
  });

  it('keeps every listing that shares a name: nothing is folded', () => {
    const twin = { ...nearby, uuid: 'twin', address: null };
    const rows = buildGymPickRows({ gyms: [nearby, twin], lookup: 'listed', origin: null, selectedId: null, labels });
    expect(rows.filter((row) => row.kind === 'pickGym')).toHaveLength(2);
  });

  it.each([
    { lookup: 'loading', expected: ['sectionHeader', 'loading', 'addGym'] },
    { lookup: 'empty', expected: ['sectionHeader', 'empty', 'addGym'] },
    { lookup: 'failed', expected: ['sectionHeader', 'empty', 'addGym'] },
    { lookup: 'offline', expected: ['sectionHeader', 'empty', 'addGym'] },
    { lookup: 'idle', expected: ['addGym'] },
  ] as const)('$lookup: never draws a failure as an empty list', ({ lookup, expected }) => {
    const rows = buildGymPickRows({ gyms: [], lookup, origin: null, selectedId: null, labels });
    expect(kinds(rows)).toEqual(expected);
    const notice = rows.find((row) => row.kind === 'empty');
    if (lookup === 'failed') expect(notice).toMatchObject({ label: labels.failed });
    if (lookup === 'offline') expect(notice).toMatchObject({ label: labels.offline });
    if (lookup === 'empty') expect(notice).toMatchObject({ label: labels.empty });
  });
});
