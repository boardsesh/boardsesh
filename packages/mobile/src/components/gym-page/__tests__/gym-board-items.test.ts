import { describe, expect, it } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import { gymBoardsToItems } from '../gym-board-items';
import { gymPageHref } from '../gym-page-route';

function board(overrides: Partial<UserBoard>): UserBoard {
  return {
    uuid: 'board-1',
    name: 'Crux - Kilter',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    angle: 40,
    ownerId: 'someone-else',
    gymName: 'Crux',
    gymUuid: 'gym-1',
    isFollowedByMe: false,
    isPinnedByMe: true,
    canEdit: false,
    canDelete: false,
    canRemoveFromGym: false,
    ...overrides,
  } as UserBoard;
}

describe('gymBoardsToItems', () => {
  it('drops the gym from the front of a board name, as the website does', () => {
    const [item] = gymBoardsToItems([board({})], { gymName: 'Crux' });
    expect(item?.title).toBe('Kilter');
  });

  it("marks the climber's own board, a saved one, and leaves someone else's unmarked", () => {
    const items = gymBoardsToItems(
      [
        board({ uuid: 'mine', ownerId: 'viewer' }),
        board({ uuid: 'saved', isFollowedByMe: true }),
        board({ uuid: 'theirs' }),
      ],
      { gymName: 'Crux', viewerId: 'viewer' },
    );
    expect(items.map((item) => [item.key, item.isViewerOwner])).toEqual([
      ['mine', true],
      ['saved', false],
      ['theirs', undefined],
    ]);
  });

  it('puts boards with a waiting report first for staff, keeping the server order within each group', () => {
    const boards = [
      board({ uuid: 'a' }),
      board({ uuid: 'b', openReportCount: 2 }),
      board({ uuid: 'c', openReportCount: 0 }),
      board({ uuid: 'd', openReportCount: 1 }),
    ];
    const staffOrder = gymBoardsToItems(boards, { gymName: 'Crux', reportedFirst: true }).map((item) => item.key);
    expect(staffOrder).toEqual(['b', 'd', 'a', 'c']);
    const climberOrder = gymBoardsToItems(boards, { gymName: 'Crux' }).map((item) => item.key);
    expect(climberOrder).toEqual(['a', 'b', 'c', 'd']);
  });

  it('carries the report flags each row draws its pill and menu from', () => {
    const [item] = gymBoardsToItems([board({ openReportCount: 3, viewerHasOpenReport: false })], { gymName: 'Crux' });
    expect(item).toMatchObject({ openReportCount: 3, viewerHasOpenReport: false });
  });

  it('claims nothing about ownership without a viewer id', () => {
    const items = gymBoardsToItems([board({ ownerId: 'viewer' })], { gymName: 'Crux' });
    expect(items[0]?.isViewerOwner).toBeUndefined();
  });

  it("carries the server's staff flags through to the menu, and no pin or download state", () => {
    const [item] = gymBoardsToItems([board({ canEdit: true, canDelete: true, canRemoveFromGym: true })], {
      gymName: 'Crux',
    });
    expect(item).toMatchObject({ canEdit: true, canDelete: true, canRemoveFromGym: true, gymName: 'Crux' });
    expect(item?.isPinned).toBe(false);
    expect(item?.offlineState).toBeUndefined();
  });

  it('names the gym for Remove from {gym} when the board came without one', () => {
    const [item] = gymBoardsToItems([board({ gymName: null })], { gymName: 'Crux' });
    expect(item?.gymName).toBe('Crux');
  });

  it('marks the board the climber is on', () => {
    const items = gymBoardsToItems([board({ uuid: 'a' }), board({ uuid: 'b' })], {
      gymName: 'Crux',
      activeUuid: 'b',
    });
    expect(items.map((item) => item.isActive)).toEqual([false, true]);
  });
});

describe('gymPageHref', () => {
  it('opens the root copy by default and the picker copy inside the picker', () => {
    expect(gymPageHref('gym-1')).toEqual({ pathname: '/gyms/[gym]', params: { gym: 'gym-1' } });
    expect(gymPageHref('gym-1', 'boards', '/(tabs)/discover')).toEqual({
      pathname: '/boards/gym/[gym]',
      params: { gym: 'gym-1', returnTo: '/(tabs)/discover' },
    });
  });
});
