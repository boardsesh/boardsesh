import { buildCanonicalClimbListUrl } from '@/app/lib/url-utils';
import type { BoardImageDetails } from '@/app/lib/types';
import type { SetterClimbRow } from './server-setter-data';
import type { SetterClimbLinks } from './setter-climb-links';

export type SetterBoardLink = {
  boardType: string;
  /** The board's name as the page prints it: "Kilter", "MoonBoard", "Spraywall". */
  label: string;
  /** The board's climb list, or null when no climb on this page names a canonical config for it. */
  href: string | null;
};

type LayoutTally = { details: BoardImageDetails; angle: number; linkedCount: number };

/**
 * Where each of the setter's board chips goes: that board's climb list.
 *
 * A board type spans layouts (Kilter Original and Kilter Homewall), so the chip
 * picks the layout most of this page's linked climbs sit on, at the angle of the
 * most-sent of them. Both come from the configs the climb rows already link
 * under, so a chip never names a list URL the rows would not, and it costs no
 * query. A board with no linked climb on this page keeps a plain label: there
 * is no canonical config to send it to.
 *
 * `climbs` must arrive most sent first, as the setter page reads them: the
 * first linked climb seen on a layout is the one whose angle the chip uses.
 */
export function resolveSetterBoardLinks(
  boardTypes: readonly string[],
  climbs: readonly SetterClimbRow[],
  links: Pick<SetterClimbLinks, 'boardDetailsByClimb' | 'unlinkedClimbUuids'>,
  /** The page's own board label, so a chip reads the same word as the line above it. */
  labelFor: (boardType: string) => string,
): SetterBoardLink[] {
  // Map iteration is insertion order, so ties go to the layout seen first: the
  // one holding the most-sent linked climb.
  const layoutsByBoard = new Map<string, Map<number, LayoutTally>>();

  for (const climb of climbs) {
    if (links.unlinkedClimbUuids.has(climb.uuid)) continue;
    const details = links.boardDetailsByClimb[climb.uuid];
    if (!details) continue;

    let layouts = layoutsByBoard.get(climb.boardType);
    if (!layouts) {
      layouts = new Map();
      layoutsByBoard.set(climb.boardType, layouts);
    }
    const tally = layouts.get(climb.layoutId);
    if (tally) {
      tally.linkedCount += 1;
    } else {
      layouts.set(climb.layoutId, { details, angle: climb.angle, linkedCount: 1 });
    }
  }

  return boardTypes.map((boardType) => {
    let best: LayoutTally | null = null;
    for (const tally of layoutsByBoard.get(boardType)?.values() ?? []) {
      if (!best || tally.linkedCount > best.linkedCount) best = tally;
    }
    return {
      boardType,
      label: labelFor(boardType),
      href: best ? buildCanonicalClimbListUrl(best.details, best.angle) : null,
    };
  });
}
