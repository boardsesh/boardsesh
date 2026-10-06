import { describe, it, expect } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import { archivedSprayWallSummaries, boardIsOwnedBy, buildManageItems, type ManageItem } from '../manage-items';

// buildManageItems only reads uuid + ownerId, so a minimal cast is enough.
const board = (uuid: string, ownerId: string): UserBoard => ({ uuid, ownerId }) as unknown as UserBoard;
const labels = { ownedHeader: 'Your boards', followingHeader: 'Following' };

function boardItem(items: ManageItem[], key: string) {
  const found = items.find((item) => item.type === 'board' && item.key === key);
  if (!found || found.type !== 'board') throw new Error(`board item not found: ${key}`);
  return found;
}

describe('boardIsOwnedBy', () => {
  it('compares ownerId whenever the board carries one', () => {
    expect(boardIsOwnedBy(board('o1', 'me'), 'me')).toBe(true);
    expect(boardIsOwnedBy(board('f1', 'other'), 'me')).toBe(false);
    expect(boardIsOwnedBy(board('o1', 'me'), undefined)).toBe(false);
  });

  it('falls back to the persisted isOwned only when ownerId is absent or blank', () => {
    expect(boardIsOwnedBy({ uuid: 'x', isOwned: true } as unknown as UserBoard, 'me')).toBe(true);
    expect(boardIsOwnedBy({ uuid: 'x', isOwned: false } as unknown as UserBoard, 'me')).toBe(false);
    expect(boardIsOwnedBy({ uuid: 'x' } as unknown as UserBoard, 'me')).toBe(false);
    expect(boardIsOwnedBy({ uuid: 'x', ownerId: '', isOwned: true } as unknown as UserBoard, 'me')).toBe(true);
  });
});

describe('buildManageItems', () => {
  it('splits owned vs followed by ownerId, each under its own header (owned first)', () => {
    const items = buildManageItems(
      [board('o1', 'me'), board('o2', 'me'), board('f1', 'other')],
      'me',
      undefined,
      labels,
    );
    expect(items.map((item) => (item.type === 'header' ? `#${item.title}` : item.key))).toEqual([
      '#Your boards',
      'o1',
      'o2',
      '#Following',
      'f1',
    ]);
    expect(boardItem(items, 'o1').isOwned).toBe(true);
    expect(boardItem(items, 'f1').isOwned).toBe(false);
  });

  it('omits a section header when that group is empty', () => {
    const ownedOnly = buildManageItems([board('o1', 'me')], 'me', undefined, labels);
    expect(ownedOnly.some((item) => item.type === 'header' && item.title === 'Following')).toBe(false);
    expect(ownedOnly.some((item) => item.type === 'header' && item.title === 'Your boards')).toBe(true);

    const followedOnly = buildManageItems([board('f1', 'other')], 'me', undefined, labels);
    expect(followedOnly.some((item) => item.type === 'header' && item.title === 'Your boards')).toBe(false);
    expect(followedOnly.some((item) => item.type === 'header' && item.title === 'Following')).toBe(true);
  });

  it('returns an empty array for no boards', () => {
    expect(buildManageItems([], 'me', undefined, labels)).toEqual([]);
  });

  it('flags only the active board', () => {
    const items = buildManageItems([board('o1', 'me'), board('o2', 'me')], 'me', 'o2', labels);
    expect(boardItem(items, 'o1').isActive).toBe(false);
    expect(boardItem(items, 'o2').isActive).toBe(true);
  });

  it('classifies every board as followed when currentUserId is undefined', () => {
    // The manage screen must NOT render in this state — this documents why
    // (an undefined id would file owned boards under "Following").
    const items = buildManageItems([board('o1', 'me')], undefined, undefined, labels);
    expect(items[0]).toEqual({ type: 'header', key: 'header:following', title: 'Following' });
    expect(boardItem(items, 'o1').isOwned).toBe(false);
  });

  // The offline My Boards list replays persisted snapshots instead of a live
  // myBoards fetch, and gets its id from the stored JWT rather than the profile.
  describe('offline snapshot rows', () => {
    it('groups downloaded boards under their headers once a persisted id is available', () => {
      const items = buildManageItems(
        [board('home-wall', 'me'), board('gym-wall', 'someone-else')],
        'me',
        undefined,
        labels,
      );
      expect(items.map((item) => (item.type === 'header' ? `#${item.title}` : item.key))).toEqual([
        '#Your boards',
        'home-wall',
        '#Following',
        'gym-wall',
      ]);
      expect(boardItem(items, 'home-wall').isOwned).toBe(true);
      expect(boardItem(items, 'gym-wall').isOwned).toBe(false);
    });

    it("falls back to a card's persisted isOwned when the snapshot carries no ownerId", () => {
      // Cards written by a build that didn't capture ownerId still hold the server's
      // own answer — better than filing the home wall under "Following".
      const legacyOwnedCard = { uuid: 'legacy', isOwned: true } as unknown as UserBoard;
      const items = buildManageItems([legacyOwnedCard, board('f1', 'other')], 'me', undefined, labels);
      expect(items.map((item) => (item.type === 'header' ? `#${item.title}` : item.key))).toEqual([
        '#Your boards',
        'legacy',
        '#Following',
        'f1',
      ]);
    });
  });
});

describe('the Archived section', () => {
  const archivedLabels = { ...labels, archivedHeader: 'Archived' };
  const archived = archivedSprayWallSummaries([
    { uuid: 'old-garage', layoutId: 1, archivedAt: '2026-08-01T10:00:00.000Z', board: { name: 'Garage' } },
    { uuid: 'live-wall', layoutId: 2, archivedAt: null, board: { name: 'Garage' } },
    { uuid: 'older-garage', layoutId: 3, archivedAt: '2026-02-01T10:00:00.000Z', board: { name: 'Garage' } },
    { uuid: 'nameless', layoutId: 4, archivedAt: '2026-09-01T10:00:00.000Z', board: null },
  ]);

  it('keeps only archived walls, most recently archived first', () => {
    expect(archived.map((wall) => wall.uuid)).toEqual(['old-garage', 'older-garage']);
    expect(archived[0].layoutId).toBe(1);
    expect(archivedSprayWallSummaries(undefined)).toEqual([]);
  });

  it('lists archived walls last, under their own header, marking the active one', () => {
    const items = buildManageItems([board('o1', 'me')], 'me', 'older-garage', archivedLabels, archived);
    expect(items.map((item) => (item.type === 'header' ? `#${item.title}` : item.key))).toEqual([
      '#Your boards',
      'o1',
      '#Archived',
      'archived:old-garage',
      'archived:older-garage',
    ]);
    const active = items.find((item) => item.key === 'archived:older-garage');
    expect(active?.type === 'archivedWall' && active.isActive).toBe(true);
  });

  it('shows the section even when every live board is gone', () => {
    const items = buildManageItems([], 'me', undefined, archivedLabels, archived);
    expect(items[0]).toEqual({ type: 'header', key: 'header:archived', title: 'Archived' });
  });

  it('leaves the section out with no archived walls or no header to put over them', () => {
    expect(buildManageItems([board('o1', 'me')], 'me', undefined, archivedLabels).map((item) => item.key)).toEqual([
      'header:owned',
      'o1',
    ]);
    expect(buildManageItems([], 'me', undefined, labels, archived)).toEqual([]);
  });
});
