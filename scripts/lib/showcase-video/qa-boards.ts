import {
  matchScreenshotBoardCandidates,
  parseScreenshotBoardSelectors,
} from '../../../packages/mobile/src/dev/integration/screenshot-board-matching';
import { SHOWCASE_BOARD_SLOTS, type ShowcaseTake } from './takes';

export const SHOWCASE_QA_GYM_UUID = 'ef8b823e-8d2e-4840-8218-761369f9c059';
export const SHOWCASE_PROD_ORIGIN = 'https://ws.boardsesh.com';

type Board = { uuid: string; name: string; layoutName: string | null; boardType: string; gymUuid: string | null };
export type ShowcaseRosterPage = { boards: Board[]; hasMore: boolean; totalCount: number };

export async function verifyShowcaseQaBoards(
  selectors: string,
  takes: readonly Pick<ShowcaseTake, 'id' | 'board'>[],
  readPage: (input: { limit: number; offset: number }) => Promise<ShowcaseRosterPage>,
): Promise<string> {
  const slots = new Set([0]); // Both phones select the first wall at startup.
  for (const take of takes) {
    if (!take.board) continue;
    if (take.board.slot === null) throw new Error(`Production take ${take.id} needs a named QA board.`);
    slots.add(take.board.slot);
  }
  const roster: Board[] = [];
  let total: number | undefined;
  for (let page = 0; ; page++) {
    const { boards, hasMore, totalCount } = await readPage({ limit: 50, offset: roster.length });
    roster.push(...boards);
    if (
      !Number.isSafeInteger(totalCount) ||
      (total !== undefined && totalCount !== total) ||
      roster.length > totalCount ||
      hasMore !== roster.length < totalCount ||
      (hasMore && (boards.length === 0 || page >= 19))
    )
      throw new Error('Incomplete production board roster. Retry after the roster is stable.');
    total = totalCount;
    if (!hasMore) break;
  }
  if (new Set(roster.map((board) => board.uuid)).size !== roster.length)
    throw new Error('Duplicate UUID in production board roster. Retry after the roster is stable.');
  const names = parseScreenshotBoardSelectors(selectors);
  // Keep unused slots inert without changing native's positional parsing.
  const pinned = names.map(() => 'uuid:');
  for (const slot of slots) {
    const selector = names[slot];
    const matches = selector ? matchScreenshotBoardCandidates(roster, selector) : [];
    const description = `Production slot ${slot} (${selector ?? 'missing selector'})`;
    if (matches.length !== 1)
      throw new Error(`${description} matched ${matches.length} boards. Select one QA fixture.`);
    const [board] = matches;
    if (board.gymUuid !== SHOWCASE_QA_GYM_UUID || board.boardType !== SHOWCASE_BOARD_SLOTS[slot])
      throw new Error(`${description} needs a ${SHOWCASE_BOARD_SLOTS[slot]} board in the Boardsesh QA gym.`);
    pinned[slot] = `uuid:${board.uuid}:gym:${SHOWCASE_QA_GYM_UUID}`;
  }
  return pinned.join('|');
}

export function localShowcaseOrigin(raw: string): string {
  const url = new URL(raw);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('SHOWCASE_LOCAL_BACKEND_URL must be a loopback origin.');
  return url.origin;
}
