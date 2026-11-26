import { describe, expect, it } from 'vitest';
import type { FriendBoard, FriendBoardAccess } from '@boardsesh/shared-schema';
import {
  FRIENDS_SHELF_MAX_ROWS,
  friendBoardListCells,
  friendBoardOwnerName,
  friendBoardToItem,
  friendBoardsEmptyKind,
  friendsShelfBoards,
} from '../friend-boards';

const copy = { ownerFallback: 'A climber', requested: 'Requested' };

function friendBoard(
  uuid: string,
  { ownerId = 'sam', ownerName = 'Sam', access = 'CAN_CLIMB' as FriendBoardAccess, boardType = 'kilter' } = {},
): FriendBoard {
  return {
    viewerAccess: access,
    owner: { userId: ownerId, displayName: ownerName, avatarUrl: null },
    preview: { uuid, name: `Board ${uuid}`, boardType, layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 },
    board: null,
  };
}

describe('friendsShelfBoards', () => {
  it('leaves out boards already in Your boards and keeps the server order', () => {
    const shelf = friendsShelfBoards([friendBoard('a'), friendBoard('b'), friendBoard('c')], new Set(['b']));
    expect(shelf.map((entry) => entry.preview.uuid)).toEqual(['a', 'c']);
  });

  it(`shows at most ${FRIENDS_SHELF_MAX_ROWS} rows, filling past a deduped one`, () => {
    const boards = ['a', 'b', 'c', 'd', 'e', 'f'].map((uuid) => friendBoard(uuid));
    expect(friendsShelfBoards(boards, new Set()).map((entry) => entry.preview.uuid)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(friendsShelfBoards(boards, new Set(['a'])).map((entry) => entry.preview.uuid)).toEqual([
      'b',
      'c',
      'd',
      'e',
      'f',
    ]);
  });

  it('drops a board the server listed twice', () => {
    expect(friendsShelfBoards([friendBoard('a'), friendBoard('a')], new Set())).toHaveLength(1);
  });

  it('is empty when every friend board is already yours', () => {
    expect(friendsShelfBoards([friendBoard('a')], new Set(['a']))).toEqual([]);
  });
});

describe('friendBoardToItem', () => {
  it('names the owner, the board and its angle on the shelf, with nothing over the art', () => {
    const item = friendBoardToItem(friendBoard('a'), { includeOwner: true, copy });
    expect(item?.title).toBe('Board a');
    expect(item?.subtitle?.startsWith('Sam · Kilter')).toBe(true);
    expect(item?.subtitle?.endsWith('· 40°')).toBe(true);
    expect(item?.accessLocked).toBe(false);
    expect(item?.badge).toBeNull();
  });

  it('leaves the owner out under an owner header', () => {
    const item = friendBoardToItem(friendBoard('a'), { includeOwner: false, copy });
    expect(item?.subtitle?.startsWith('Kilter')).toBe(true);
  });

  it('locks a board the viewer has to ask for, and pills a waiting request', () => {
    expect(friendBoardToItem(friendBoard('a', { access: 'CAN_REQUEST' }), { includeOwner: true, copy })).toMatchObject({
      accessLocked: true,
      badge: null,
    });
    expect(friendBoardToItem(friendBoard('a', { access: 'REQUESTED' }), { includeOwner: true, copy })).toMatchObject({
      accessLocked: false,
      badge: 'Requested',
    });
  });

  it('marks the board the climber is on', () => {
    expect(friendBoardToItem(friendBoard('a'), { includeOwner: true, copy, activeUuid: 'a' })?.isActive).toBe(true);
  });

  it('draws nothing for a board type the app does not know', () => {
    expect(friendBoardToItem(friendBoard('a', { boardType: 'mystery' }), { includeOwner: true, copy })).toBeNull();
  });

  it('falls back to a word for an owner with no name', () => {
    expect(friendBoardOwnerName({ userId: 'x', displayName: '  ', avatarUrl: null }, 'A climber')).toBe('A climber');
  });
});

describe('friendBoardListCells', () => {
  it('groups boards under their owner, owners in first-listed order', () => {
    const cells = friendBoardListCells(
      [
        friendBoard('a', { ownerId: 'sam' }),
        friendBoard('b', { ownerId: 'kim', ownerName: 'Kim' }),
        friendBoard('c', { ownerId: 'sam' }),
        friendBoard('a', { ownerId: 'sam' }),
      ],
      { copy },
    );
    expect(
      cells.map((cell) => (cell.kind === 'owner' ? `owner:${cell.name}` : `${cell.item.key}:${cell.position}`)),
    ).toEqual(['owner:Sam', 'a:first', 'c:last', 'owner:Kim', 'b:only']);
  });
});

describe('friendBoardsEmptyKind', () => {
  it.each([
    { offline: false, query: '', followerCount: 3, boardCount: 2, expected: null },
    { offline: true, query: '', followerCount: 3, boardCount: 0, expected: 'offline' },
    { offline: false, query: 'sam', followerCount: 3, boardCount: 0, expected: 'no_match' },
    { offline: false, query: '', followerCount: 0, boardCount: 0, expected: 'no_followers' },
    { offline: false, query: '', followerCount: 4, boardCount: 0, expected: 'no_boards' },
    // Unknown follower count: never tell someone nobody follows them on a guess.
    { offline: false, query: '', followerCount: undefined, boardCount: 0, expected: 'no_boards' },
  ])('$expected for $boardCount boards, query "$query", offline $offline', ({ expected, ...input }) => {
    expect(friendBoardsEmptyKind(input)).toBe(expected);
  });
});
