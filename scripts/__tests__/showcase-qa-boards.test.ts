import { matchScreenshotBoardCandidates } from '../../packages/mobile/src/dev/integration/screenshot-board-matching';
import { describe, expect, it, vi } from 'vitest';
import { localShowcaseOrigin, SHOWCASE_QA_GYM_UUID, verifyShowcaseQaBoards } from '../lib/showcase-video/qa-boards';
import { SHOWCASE_DEFAULT_BOARDS } from '../lib/showcase-video/record';
import { SHOWCASE_TAKES } from '../lib/showcase-video/takes';

const names = SHOWCASE_DEFAULT_BOARDS.prod;
const kilter = {
  uuid: 'a',
  name: 'Boardsesh QA Kilter Homewall Full',
  boardType: 'kilter',
  gymUuid: SHOWCASE_QA_GYM_UUID,
  layoutName: null,
};
const tension = { ...kilter, uuid: 'b', name: 'Boardsesh QA Tension 2 Mirror', boardType: 'tension' };
const lockScreen = SHOWCASE_TAKES.filter((take) => take.id === 'lock-screen');
const roster =
  (...boards: (typeof kilter)[]) =>
  async () => ({ boards, totalCount: boards.length, hasMore: false });

describe('showcase production board preflight', () => {
  it('uses dedicated QA selectors for every family and preserves local defaults', () => {
    expect(names.split('|')).toHaveLength(7);
    expect(names.split('|').every((name) => name.startsWith('Boardsesh QA '))).toBe(true);
    expect(SHOWCASE_DEFAULT_BOARDS.local).toBe('The Proj Wall|The Slab Lab|MoonBoard 2016');
  });
  it('reads each page and checks only the startup and recording slots', async () => {
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({ boards: [kilter], totalCount: 2, hasMore: true })
      .mockResolvedValueOnce({ boards: [tension], totalCount: 2, hasMore: false });
    const pinned = (await verifyShowcaseQaBoards(names, lockScreen, readPage)).split('|');
    expect(pinned).toEqual([
      `uuid:a:gym:${SHOWCASE_QA_GYM_UUID}`,
      `uuid:b:gym:${SHOWCASE_QA_GYM_UUID}`,
      'uuid:',
      'uuid:',
      'uuid:',
      'uuid:',
      'uuid:',
    ]);
    const impostor = { ...kilter, uuid: 'personal', name: pinned[0], layoutName: kilter.name };
    expect(matchScreenshotBoardCandidates([{ ...kilter, gymUuid: 'moved' }], pinned[0])).toEqual([]);
    expect(matchScreenshotBoardCandidates([{ ...kilter, gymUuid: null }], pinned[0])).toEqual([]);
    expect(matchScreenshotBoardCandidates([{ ...kilter, name: 'uuid:a' }], 'uuid:a')).toEqual([]);
    expect(matchScreenshotBoardCandidates([impostor], pinned[0])).toEqual([]);
    expect(matchScreenshotBoardCandidates([impostor, { ...kilter, name: 'Renamed' }], pinned[0])).toEqual([
      { ...kilter, name: 'Renamed' },
    ]);
    expect(matchScreenshotBoardCandidates([impostor], pinned[2])).toEqual([]);
    expect(readPage.mock.calls).toEqual([[{ limit: 50, offset: 0 }], [{ limit: 50, offset: 1 }]]);
    await expect(verifyShowcaseQaBoards(names, lockScreen, roster(tension))).rejects.toThrow('slot 0');
    await expect(verifyShowcaseQaBoards(names, lockScreen, roster(kilter))).rejects.toThrow('slot 1');
  });
  it('rejects personal override selectors and ambiguous names even across gym boundaries', async () => {
    const personal = { ...kilter, uuid: 'personal', name: "Marco's Board", gymUuid: 'other' };
    await expect(verifyShowcaseQaBoards(personal.name, [], roster(personal))).rejects.toThrow('QA gym');
    await expect(verifyShowcaseQaBoards(names, [], roster(kilter, { ...personal, name: kilter.name }))).rejects.toThrow(
      'matched 2',
    );
  });
  it('rejects truncated, duplicate, or stalled pagination', async () => {
    for (const page of [
      { boards: [kilter], hasMore: false, totalCount: 2 },
      { boards: [kilter, kilter], hasMore: false, totalCount: 2 },
      { boards: [], hasMore: true, totalCount: 1 },
    ])
      await expect(verifyShowcaseQaBoards(names, [], async () => page)).rejects.toThrow(/roster/);
  });
  it('rejects production config links before fetching the roster', async () => {
    const readPage = vi.fn();
    await expect(
      verifyShowcaseQaBoards(names, [{ id: 'boards-touchstone', board: { kind: 'touchstone', slot: null } }], readPage),
    ).rejects.toThrow('named QA board');
    expect(readPage).not.toHaveBeenCalled();
  });
  it('restricts local backend reuse to loopback origins', () => {
    expect(localShowcaseOrigin('http://localhost:8080/')).toBe('http://localhost:8080');
    expect(() => localShowcaseOrigin('https://ws.boardsesh.com')).toThrow('loopback');
  });
});
