import { describe, expect, it } from 'vitest';
import { MOONBOARD_LAYOUTS, MOONBOARD_SETS } from '../moonboard-metadata';
import {
  SETUP_OMISSION_HINTS,
  classifyWallMatch,
  compareWallCandidates,
  diffWallSetIds,
  likelySetupOmissions,
  type WallCandidateRankFields,
} from '../wall-match';

const MASTERS_2019 = { boardType: 'moonboard', layoutId: 5, sizeId: 1, setIds: '17,18,19,20' };

describe('classifyWallMatch', () => {
  it('calls the same layout, size and sets EXACT whatever the set order', () => {
    expect(classifyWallMatch(MASTERS_2019, { ...MASTERS_2019, setIds: '20,19,18,17' })).toBe('EXACT');
    expect(classifyWallMatch(MASTERS_2019, { ...MASTERS_2019, setIds: ' 17,18 ,19,20,20' })).toBe('EXACT');
  });

  it('compares set ids as numbers, so a leading zero is the same set', () => {
    expect(classifyWallMatch({ ...MASTERS_2019, setIds: '017,18' }, { ...MASTERS_2019, setIds: '17,18' })).toBe(
      'EXACT',
    );
  });

  it('calls a missing, extra or swapped set SETS_DIFFER', () => {
    expect(classifyWallMatch(MASTERS_2019, { ...MASTERS_2019, setIds: '17,18,19' })).toBe('SETS_DIFFER');
    expect(classifyWallMatch(MASTERS_2019, { ...MASTERS_2019, setIds: '17,18,19,20,21' })).toBe('SETS_DIFFER');
    expect(classifyWallMatch(MASTERS_2019, { ...MASTERS_2019, setIds: '21,22' })).toBe('SETS_DIFFER');
  });

  it('calls another layout or size LAYOUT_OR_SIZE_DIFFERS', () => {
    expect(classifyWallMatch(MASTERS_2019, { ...MASTERS_2019, layoutId: 2, setIds: '2,3,4' })).toBe(
      'LAYOUT_OR_SIZE_DIFFERS',
    );
    expect(classifyWallMatch(MASTERS_2019, { ...MASTERS_2019, sizeId: 2 })).toBe('LAYOUT_OR_SIZE_DIFFERS');
  });

  it('never matches another board type', () => {
    expect(classifyWallMatch(MASTERS_2019, { ...MASTERS_2019, boardType: 'kilter' })).toBeNull();
  });
});

describe('diffWallSetIds', () => {
  it('names the draft sets the wall lacks and the wall sets the draft lacks', () => {
    expect(diffWallSetIds(MASTERS_2019, { ...MASTERS_2019, setIds: '21,19,18,17' })).toEqual({
      missingSetIds: [20],
      extraSetIds: [21],
    });
  });

  it('is empty for an exact match and for another layout', () => {
    expect(diffWallSetIds(MASTERS_2019, { ...MASTERS_2019, setIds: '20,17,18,19' })).toEqual({
      missingSetIds: [],
      extraSetIds: [],
    });
    expect(diffWallSetIds(MASTERS_2019, { ...MASTERS_2019, layoutId: 4, setIds: '11,12' })).toEqual({
      missingSetIds: [],
      extraSetIds: [],
    });
  });
});

describe('compareWallCandidates', () => {
  const base: WallCandidateRankFields = {
    matchKind: 'EXACT',
    source: 'SELECTED_GYM',
    gymDistanceMeters: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    uuid: 'b',
  };

  const sortUuids = (candidates: WallCandidateRankFields[]) =>
    [...candidates].sort(compareWallCandidates).map((candidate) => candidate.uuid);

  it('ranks match kind first, with no kind last', () => {
    expect(
      sortUuids([
        { ...base, uuid: 'none', matchKind: null },
        { ...base, uuid: 'layout', matchKind: 'LAYOUT_OR_SIZE_DIFFERS' },
        { ...base, uuid: 'sets', matchKind: 'SETS_DIFFER' },
        { ...base, uuid: 'exact', matchKind: 'EXACT', source: 'NEARBY_LISTING' },
      ]),
    ).toEqual(['exact', 'sets', 'layout', 'none']);
  });

  it('then the chosen gym, merged listings, nearby listings', () => {
    expect(
      sortUuids([
        { ...base, uuid: 'nearby', source: 'NEARBY_LISTING', gymDistanceMeters: 10 },
        { ...base, uuid: 'merged', source: 'MERGED_LISTING' },
        { ...base, uuid: 'selected', source: 'SELECTED_GYM' },
      ]),
    ).toEqual(['selected', 'merged', 'nearby']);
  });

  it('then nearest gym with unknown distance last, then oldest, then uuid', () => {
    expect(
      sortUuids([
        { ...base, uuid: 'unknown', source: 'NEARBY_LISTING', gymDistanceMeters: null },
        { ...base, uuid: 'far', source: 'NEARBY_LISTING', gymDistanceMeters: 120 },
        { ...base, uuid: 'near', source: 'NEARBY_LISTING', gymDistanceMeters: 40 },
      ]),
    ).toEqual(['near', 'far', 'unknown']);
    expect(
      sortUuids([
        { ...base, uuid: 'newer', createdAt: new Date('2025-01-01T00:00:00Z') },
        { ...base, uuid: 'older', createdAt: new Date('2016-01-01T00:00:00Z') },
      ]),
    ).toEqual(['older', 'newer']);
    expect(
      sortUuids([
        { ...base, uuid: 'b' },
        { ...base, uuid: 'a' },
      ]),
    ).toEqual(['a', 'b']);
  });
});

describe('SETUP_OMISSION_HINTS', () => {
  it('points at the Screw-on Feet set of each Masters layout in the bundled metadata', () => {
    const layoutKeyById = new Map<number, string>(
      Object.entries(MOONBOARD_LAYOUTS).map(([layoutKey, layout]) => [layout.id, layoutKey]),
    );
    expect(layoutKeyById.get(4)).toBe('moonboard-masters-2017');
    expect(layoutKeyById.get(5)).toBe('moonboard-masters-2019');
    for (const hint of SETUP_OMISSION_HINTS) {
      const layoutKey = layoutKeyById.get(hint.layoutId) as keyof typeof MOONBOARD_SETS;
      const hintedSet = MOONBOARD_SETS[layoutKey].find((boardSet) => boardSet.id === hint.setId);
      expect(hintedSet?.name).toBe('Screw-on Feet');
    }
  });
});

describe('likelySetupOmissions', () => {
  it('flags Masters 2019 entered without its feet', () => {
    expect(likelySetupOmissions({ boardType: 'moonboard', layoutId: 5, setIds: '17,18,19' })).toEqual([
      { boardType: 'moonboard', layoutId: 5, setId: 20, reason: 'screw_on_feet' },
    ]);
  });

  it('flags Masters 2017 entered without its feet', () => {
    expect(likelySetupOmissions({ boardType: 'moonboard', layoutId: 4, setIds: '11,12,13' })).toHaveLength(1);
  });

  it('stays quiet when the feet are there, on other layouts, and before any set is chosen', () => {
    expect(likelySetupOmissions({ boardType: 'moonboard', layoutId: 5, setIds: '20,17' })).toEqual([]);
    expect(likelySetupOmissions({ boardType: 'moonboard', layoutId: 3, setIds: '5,6' })).toEqual([]);
    expect(likelySetupOmissions({ boardType: 'kilter', layoutId: 5, setIds: '1' })).toEqual([]);
    expect(likelySetupOmissions({ boardType: 'moonboard', layoutId: 5, setIds: '' })).toEqual([]);
  });
});
