import { describe, expect, it } from 'vite-plus/test';
import { boardTypeLabel } from '@boardsesh/board-constants';
import { getBoardImageDetailsForBoard, getBoardImageDetailsForPlaylist } from '@/app/lib/board-image-details';
import { buildCanonicalClimbListUrl } from '@/app/lib/url-utils';
import type { BoardImageDetails } from '@/app/lib/types';
import type { SetterClimbRow } from '../server-setter-data';
import { resolveSetterBoardLinks } from '../setter-board-links';

/** A real board from the static tables: largest size, every set, as the page draws unlinked art. */
function boardOf(boardType: string, layoutId: number): BoardImageDetails {
  const details = getBoardImageDetailsForPlaylist(boardType, layoutId);
  if (!details) throw new Error(`no ${boardType} layout ${layoutId} in the static tables`);
  return details;
}

const KILTER_ORIGINAL = getBoardImageDetailsForBoard({
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 20],
});
const KILTER_HOMEWALL = boardOf('kilter', 8);
const TENSION = boardOf('tension', 10);

function climb(uuid: string, overrides: Partial<SetterClimbRow> = {}): SetterClimbRow {
  return {
    uuid,
    layoutId: 1,
    boardType: 'kilter',
    setter_username: 'marco',
    name: `Climb ${uuid}`,
    description: '',
    frames: 'p1080r15',
    angle: 40,
    ascensionist_count: 10,
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

function links(detailsByClimb: Record<string, BoardImageDetails>, unlinked: string[] = []) {
  return { boardDetailsByClimb: detailsByClimb, unlinkedClimbUuids: new Set(unlinked) };
}

describe('resolveSetterBoardLinks', () => {
  it("sends each board's chip to that board's climb list, at its most-sent climb's angle", () => {
    // Most sent first, as the page reads them.
    const climbs = [
      climb('a', { angle: 35 }),
      climb('b', { boardType: 'tension', layoutId: 10, angle: 25 }),
      climb('c', { angle: 50 }),
    ];

    const boardLinks = resolveSetterBoardLinks(
      ['kilter', 'tension'],
      climbs,
      links({ a: KILTER_ORIGINAL, b: TENSION, c: KILTER_ORIGINAL }),
      boardTypeLabel,
    );

    expect(boardLinks).toEqual([
      { boardType: 'kilter', label: 'Kilter', href: buildCanonicalClimbListUrl(KILTER_ORIGINAL, 35) },
      { boardType: 'tension', label: 'Tension', href: buildCanonicalClimbListUrl(TENSION, 25) },
    ]);
    // The canonical config-tuple list, not an invented path.
    expect(boardLinks[0].href).toMatch(/^\/kilter\/.+\/35\/list$/);
  });

  it('picks the layout most of the linked climbs sit on, not merely the first one seen', () => {
    const climbs = [climb('a', { layoutId: 8, angle: 45 }), climb('b', { angle: 30 }), climb('c', { angle: 40 })];

    const [kilter] = resolveSetterBoardLinks(
      ['kilter'],
      climbs,
      links({ a: KILTER_HOMEWALL, b: KILTER_ORIGINAL, c: KILTER_ORIGINAL }),
      boardTypeLabel,
    );

    expect(kilter.href).toBe(buildCanonicalClimbListUrl(KILTER_ORIGINAL, 30));
  });

  it('keeps a plain label for a board with no linked climb on this page', () => {
    // `b` is drawn (it has display details) but has no canonical config, so its
    // row carries no anchor and its board gets no list link either.
    const climbs = [climb('a'), climb('b', { boardType: 'moonboard', layoutId: 2 })];

    const boardLinks = resolveSetterBoardLinks(
      ['kilter', 'moonboard', 'tension'],
      climbs,
      links({ a: KILTER_ORIGINAL, b: KILTER_ORIGINAL }, ['b']),
      boardTypeLabel,
    );

    expect(boardLinks.map((boardLink) => [boardLink.label, boardLink.href === null])).toEqual([
      ['Kilter', false],
      ['MoonBoard', true],
      ['Tension', true],
    ]);
  });
});
