import { describe, it, expect } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import { buildManageItems, type ManageItem } from '../manage-items';

// buildManageItems only reads uuid + ownerId, so a minimal cast is enough.
const board = (uuid: string, ownerId: string): UserBoard => ({ uuid, ownerId }) as unknown as UserBoard;
const labels = { ownedHeader: 'Your boards', followingHeader: 'Following' };

function boardItem(items: ManageItem[], key: string) {
  const found = items.find((item) => item.type === 'board' && item.key === key);
  if (!found || found.type !== 'board') throw new Error(`board item not found: ${key}`);
  return found;
}

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
});
