import type { BoardImageDetails } from '@/app/lib/types';
import type { SetterClimbRow } from './server-setter-data';
import type { SetterClimbLinks } from './setter-climb-links';

/** One row of three: the cards are a set, and two cards and a gap read as a missing one. */
export const MOST_SENT_CARD_COUNT = 3;

export type MostSentPick = {
  climb: SetterClimbRow;
  /** The board the art is drawn on: the canonical config when the climb is linked. */
  boardDetails: BoardImageDetails;
  /** False for a climb with no canonical config: its card draws the art with no anchor, as its row does. */
  linked: boolean;
};

type MostSentInput = {
  climbs: readonly SetterClimbRow[];
  links: Pick<SetterClimbLinks, 'boardDetailsByClimb' | 'unlinkedClimbUuids'>;
  /** 1-based page. Only page one's top rows are the setter's most sent. */
  page: number;
  /** The setter's visible climbs across every board. */
  climbCount: number;
};

/**
 * The setter's three most-sent climbs, for the art cards above the full list.
 *
 * No query of its own: page one is already read most sent first
 * (`buildSetterClimbsQuery` orders by each climb's send count at its most-sent
 * angle), so its top rows ARE the setter's most sent. A later page's top rows
 * are not, so it gets no cards.
 *
 * Empty, rather than a short row, when:
 *  - the setter has three climbs or fewer, so the cards would just repeat the
 *    list under them;
 *  - fewer than three climbs have a send: "most sent" over unsent climbs is a
 *    claim the numbers do not make;
 *  - a climb has no frames or no board to draw it on. It is skipped, and the
 *    next most-sent climb takes its place.
 */
export function selectMostSentClimbs({ climbs, links, page, climbCount }: MostSentInput): MostSentPick[] {
  if (page !== 1 || climbCount <= MOST_SENT_CARD_COUNT) return [];

  const picks: MostSentPick[] = [];
  for (const climb of climbs) {
    if (picks.length === MOST_SENT_CARD_COUNT) break;
    if (climb.ascensionist_count <= 0 || !climb.frames) continue;
    const boardDetails = links.boardDetailsByClimb[climb.uuid];
    if (!boardDetails) continue;
    picks.push({ climb, boardDetails, linked: !links.unlinkedClimbUuids.has(climb.uuid) });
  }

  return picks.length === MOST_SENT_CARD_COUNT ? picks : [];
}
