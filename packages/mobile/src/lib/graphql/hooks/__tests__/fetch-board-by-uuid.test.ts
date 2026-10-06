// Pins the document `fetchBoardByUuid` sends.
//
// There is one `GetBoard` document, in the shared package. A board fetched
// here replaces the active board (self-heal, follow-heal, route targets, spray
// wall activation), and `rogue-timer-provider` reads the active board's
// `timerName` to reconnect the paired timer. #6076 pointed this at a second
// `GetBoard` that selected neither `timerName` nor `isPinnedByMe`, so the timer
// stopped connecting until the next refetch. The second document is gone; this
// keeps the fields from going with it.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const requestMock = vi.fn();
vi.mock('../../client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

import { fetchBoardByUuid } from '../fetch-board-by-uuid';

describe('fetchBoardByUuid', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('asks for the fields the active board is read for', async () => {
    requestMock.mockResolvedValue({ board: null });

    await fetchBoardByUuid('board-1');

    expect(requestMock).toHaveBeenCalledTimes(1);
    const [document, variables] = requestMock.mock.calls[0] as [string, { boardUuid: string }];
    expect(variables).toEqual({ boardUuid: 'board-1' });
    expect(document).toMatch(/\bquery GetBoard\b/);
    for (const field of ['timerName', 'isPinnedByMe', 'slug', 'isPublic', 'isUnlisted']) {
      expect(document, `GetBoard must select ${field}`).toMatch(new RegExp(`\\b${field}\\b`));
    }
  });

  it('returns the board the server answered with', async () => {
    const board = { uuid: 'board-1', timerName: 'Rogue Echo' };
    requestMock.mockResolvedValue({ board });

    await expect(fetchBoardByUuid('board-1')).resolves.toBe(board);
  });
});
