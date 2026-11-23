import { describe, expect, it } from 'vite-plus/test';
import type { BoardImageDetails } from '@/app/lib/types';
import type { SetterClimbRow } from '../server-setter-data';
import { MOST_SENT_CARD_COUNT, selectMostSentClimbs } from '../setter-most-sent-picks';

const KILTER: BoardImageDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 20],
  boardWidth: 1080,
  boardHeight: 1350,
  backgroundImagePaths: [],
};

function climb(uuid: string, sends: number, overrides: Partial<SetterClimbRow> = {}): SetterClimbRow {
  return {
    uuid,
    layoutId: 1,
    boardType: 'kilter',
    setter_username: 'marco',
    name: `Climb ${uuid}`,
    description: '',
    frames: 'p1080r15',
    angle: 40,
    ascensionist_count: sends,
    difficulty: '6a/V3',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
    created_at: null,
    compatibleSizeIds: [10],
    requiredSetIds: [1],
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Every climb drawn on Kilter and linked, unless the test says otherwise. */
function linksFor(climbs: SetterClimbRow[], unlinked: string[] = [], undrawable: string[] = []) {
  return {
    boardDetailsByClimb: Object.fromEntries(
      climbs.filter((row) => !undrawable.includes(row.uuid)).map((row) => [row.uuid, KILTER]),
    ),
    unlinkedClimbUuids: new Set(unlinked),
  };
}

// Page one arrives most sent first, as `buildSetterClimbsQuery` orders it.
const PAGE_ONE = [climb('a', 4171), climb('b', 1912), climb('c', 846), climb('d', 12), climb('e', 0)];

describe('selectMostSentClimbs', () => {
  it("takes page one's three most-sent climbs, in the order the page read them", () => {
    const picks = selectMostSentClimbs({ climbs: PAGE_ONE, links: linksFor(PAGE_ONE), page: 1, climbCount: 41 });

    expect(picks.map((pick) => pick.climb.uuid)).toEqual(['a', 'b', 'c']);
    expect(picks.every((pick) => pick.linked && pick.boardDetails === KILTER)).toBe(true);
  });

  it("shows no cards on a later page, whose top rows are not the setter's most sent", () => {
    expect(selectMostSentClimbs({ climbs: PAGE_ONE, links: linksFor(PAGE_ONE), page: 2, climbCount: 141 })).toEqual([]);
  });

  it('shows no cards when the list under them would hold the same climbs', () => {
    const three = PAGE_ONE.slice(0, MOST_SENT_CARD_COUNT);
    expect(selectMostSentClimbs({ climbs: three, links: linksFor(three), page: 1, climbCount: 3 })).toEqual([]);
  });

  it('never calls an unsent climb "most sent", and drops the row rather than show two cards', () => {
    const fewSent = [climb('a', 9), climb('b', 3), climb('c', 0), climb('d', 0)];

    expect(selectMostSentClimbs({ climbs: fewSent, links: linksFor(fewSent), page: 1, climbCount: 4 })).toEqual([]);
  });

  it('skips a climb it cannot draw and takes the next most sent', () => {
    // `b` has no frames to draw; `c` has no board the art can be drawn on.
    const climbs = [
      climb('a', 900),
      climb('b', 800, { frames: '' }),
      climb('c', 700),
      climb('d', 600),
      climb('e', 500),
    ];
    const picks = selectMostSentClimbs({ climbs, links: linksFor(climbs, [], ['c']), page: 1, climbCount: 10 });

    expect(picks.map((pick) => pick.climb.uuid)).toEqual(['a', 'd', 'e']);
  });

  it('keeps a climb with no canonical config, drawn but unlinked, as its row is', () => {
    const picks = selectMostSentClimbs({
      climbs: PAGE_ONE,
      links: linksFor(PAGE_ONE, ['b']),
      page: 1,
      climbCount: 41,
    });

    expect(picks.map((pick) => [pick.climb.uuid, pick.linked])).toEqual([
      ['a', true],
      ['b', false],
      ['c', true],
    ]);
  });
});
