import { describe, expect, it } from 'vitest';
import type { ExistingWallCandidate, UserBoard } from '@boardsesh/shared-schema';
import { boardSetupLabelParts } from '@boardsesh/board-config';
import {
  acknowledgedWallUuids,
  countWallCandidates,
  groupWallCandidates,
  MAX_ACKNOWLEDGED_WALLS,
  wallCandidateItem,
  wallCandidateMatch,
  wallRelation,
  wallShelfFor,
  type WallRowCopy,
} from '../wall-candidates';

const copy: WallRowCopy = {
  adjustable: 'Adjustable',
  stats: ({ climbers, sends }) => `${climbers} climbers · ${sends} sends`,
  addedBy: (name) => `Added by ${name}`,
  nearbyGym: (gym, distance) => `${gym} · ${distance} m away`,
  yourBoard: 'Your board',
  following: 'Following',
};

// A MoonBoard Masters 2019 (layout 5) with every set but the Screw-on Feet.
function board(overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid: 'wall-1',
    name: 'Boulder Space MoonBoard',
    boardType: 'moonboard',
    layoutId: 5,
    sizeId: 1,
    setIds: '17,18,19',
    angle: 40,
    isAngleAdjustable: false,
    isPublic: true,
    isUnlisted: false,
    ownerId: 'owner-1',
    ownerDisplayName: 'Sam',
    uniqueClimbers: 12,
    totalAscents: 340,
    isFollowedByMe: false,
    ...overrides,
  } as UserBoard;
}

function candidate(overrides: Partial<ExistingWallCandidate> & { uuid?: string } = {}): ExistingWallCandidate {
  const { uuid = 'wall-1', ...rest } = overrides;
  return {
    board: board({ uuid }),
    matchKind: null,
    missingSetIds: [],
    extraSetIds: [],
    source: 'SELECTED_GYM',
    gymName: 'Boulder Space',
    gymDistanceMeters: null,
    ...rest,
  };
}

describe('wallShelfFor', () => {
  it.each([
    { matchKind: 'EXACT', source: 'SELECTED_GYM', shelf: 'same_setup', match: 'exact' },
    { matchKind: 'EXACT', source: 'MERGED_LISTING', shelf: 'same_setup', match: 'exact' },
    { matchKind: 'SETS_DIFFER', source: 'SELECTED_GYM', shelf: 'set_up_differently', match: 'near_miss' },
    { matchKind: 'LAYOUT_OR_SIZE_DIFFERS', source: 'SELECTED_GYM', shelf: 'set_up_differently', match: 'near_miss' },
    // The find step sends no draft, so its walls have no match kind.
    { matchKind: null, source: 'SELECTED_GYM', shelf: 'at_gym', match: 'at_gym' },
    { matchKind: null, source: 'MERGED_LISTING', shelf: 'at_gym', match: 'at_gym' },
    // A nearby listing goes on its own shelf, whatever it matched: the gym is in question.
    { matchKind: 'EXACT', source: 'NEARBY_LISTING', shelf: 'listed_nearby', match: 'nearby' },
    { matchKind: null, source: 'NEARBY_LISTING', shelf: 'listed_nearby', match: 'nearby' },
  ] as const)('$matchKind at $source goes on $shelf', ({ matchKind, source, shelf, match }) => {
    expect(wallShelfFor({ matchKind, source })).toBe(shelf);
    expect(wallCandidateMatch({ matchKind, source })).toBe(match);
  });
});

describe('groupWallCandidates', () => {
  it('draws the shelves in a fixed order, keeps the server rank inside each and drops empty ones', () => {
    const shelves = groupWallCandidates([
      candidate({ uuid: 'nearby', source: 'NEARBY_LISTING', matchKind: 'EXACT' }),
      candidate({ uuid: 'differs-1', matchKind: 'SETS_DIFFER' }),
      candidate({ uuid: 'exact', matchKind: 'EXACT' }),
      candidate({ uuid: 'differs-2', matchKind: 'LAYOUT_OR_SIZE_DIFFERS' }),
    ]);
    expect(shelves.map((shelf) => [shelf.key, shelf.candidates.map((entry) => entry.board.uuid)])).toEqual([
      ['same_setup', ['exact']],
      ['set_up_differently', ['differs-1', 'differs-2']],
      ['listed_nearby', ['nearby']],
    ]);
  });

  it('has no shelves for no walls', () => {
    expect(groupWallCandidates([])).toEqual([]);
  });
});

describe('countWallCandidates', () => {
  it('counts what Board Wall Candidates Shown carries', () => {
    expect(
      countWallCandidates([
        candidate({ matchKind: 'EXACT' }),
        candidate({ matchKind: 'EXACT' }),
        candidate({ matchKind: 'SETS_DIFFER' }),
        candidate({ source: 'NEARBY_LISTING' }),
        candidate({ matchKind: null }),
      ]),
    ).toEqual({ exactCount: 2, nearMissCount: 1, nearbyCount: 1, atGymCount: 1 });
  });
});

describe('wallRelation', () => {
  it.each([
    { viewerId: 'owner-1', followed: false, relation: 'owner' },
    { viewerId: 'someone', followed: true, relation: 'following' },
    { viewerId: 'someone', followed: false, relation: null },
    // Signed out: nobody's, even a followed flag from a stale cache can't make it theirs.
    { viewerId: null, followed: false, relation: null },
  ] as const)('$relation for $viewerId', ({ viewerId, followed, relation }) => {
    expect(wallRelation(board({ isFollowedByMe: followed }), viewerId)).toBe(relation);
  });
});

describe('wallCandidateItem', () => {
  const sets = boardSetupLabelParts('moonboard', { layoutId: 5, sizeId: 1, setIds: '17,18,19' }).sets;

  it('names the wall, its setup, every set, its counts and who added it', () => {
    const item = wallCandidateItem(board(), { copy, viewerId: 'someone' });
    expect(item?.title).toBe('Boulder Space MoonBoard');
    expect(item?.subtitle).toMatch(/^MoonBoard .*2019 · 40°$/);
    expect(sets.length).toBe(3);
    expect(item?.detailLines).toEqual([sets.join(', '), '12 climbers · 340 sends', 'Added by Sam']);
    expect(item?.badge).toBeNull();
  });

  it('says Adjustable on an adjustable wall', () => {
    expect(wallCandidateItem(board({ isAngleAdjustable: true }), { copy })?.subtitle).toMatch(/· 40° · Adjustable$/);
  });

  it.each([
    { name: 'a private board', overrides: { isPublic: false } as Partial<UserBoard> },
    { name: 'an unlisted board', overrides: { isUnlisted: true } as Partial<UserBoard> },
    { name: 'a board with no owner name', overrides: { ownerDisplayName: undefined } as Partial<UserBoard> },
  ])('leaves Added by off $name', ({ overrides }) => {
    const item = wallCandidateItem(board(overrides), { copy, viewerId: 'someone' });
    expect(item?.detailLines?.some((line) => line.startsWith('Added by'))).toBe(false);
  });

  it('badges the viewer own wall and leaves their own name off it', () => {
    const item = wallCandidateItem(board(), { copy, viewerId: 'owner-1' });
    expect(item?.badge).toBe('Your board');
    expect(item?.detailLines?.some((line) => line.startsWith('Added by'))).toBe(false);
  });

  it('badges a followed wall', () => {
    expect(wallCandidateItem(board({ isFollowedByMe: true }), { copy, viewerId: 'someone' })?.badge).toBe('Following');
  });

  it('leads a nearby listing with its gym and distance', () => {
    const item = wallCandidateItem(board(), { copy, nearby: { gymName: 'Crag Hall', distanceMeters: 84.6 } });
    expect(item?.detailLines?.[0]).toBe('Crag Hall · 85 m away');
  });

  it('counts zero for a wall with no stats yet', () => {
    const item = wallCandidateItem(board({ uniqueClimbers: undefined, totalAscents: undefined }), { copy });
    expect(item?.detailLines).toContain('0 climbers · 0 sends');
  });

  it('leaves out a board type this build cannot draw', () => {
    expect(wallCandidateItem(board({ boardType: 'not-a-board' }), { copy })).toBeNull();
  });
});

describe('acknowledged walls', () => {
  it('drops repeats and keeps the server cap', () => {
    const uuids = Array.from({ length: 50 }, (_, index) => `wall-${index}`);
    expect(acknowledgedWallUuids(['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(acknowledgedWallUuids(uuids)).toHaveLength(MAX_ACKNOWLEDGED_WALLS);
  });
});
