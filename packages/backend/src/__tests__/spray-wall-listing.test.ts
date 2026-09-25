import { describe, expect, it } from 'vite-plus/test';
import { sprayWallIsListable } from '../graphql/resolvers/board/spray-wall-listing';

/**
 * The row form of the listing rule has to say exactly what the SQL form
 * (`listableSprayWallCondition`) says: the owner, or a published wall that is
 * not admin-hidden. `gymSprayWalls` reads this one; the board listings read the
 * SQL — a disagreement is a wall that is listed on one surface and not another.
 */
const OWNER = 'listing-owner';
const STRANGER = 'listing-stranger';
const board = { ownerId: OWNER };
const published = { currentVersionId: 7, hiddenAt: null };

describe('sprayWallIsListable', () => {
  it('lists a published wall to anybody', () => {
    expect(sprayWallIsListable(published, board, STRANGER)).toBe(true);
    expect(sprayWallIsListable(published, board, null)).toBe(true);
  });

  it('keeps an unpublished wall to its owner', () => {
    const draft = { currentVersionId: null, hiddenAt: null };
    expect(sprayWallIsListable(draft, board, STRANGER)).toBe(false);
    expect(sprayWallIsListable(draft, board, OWNER)).toBe(true);
  });

  it('keeps an admin-hidden wall to its owner, published or not', () => {
    const hidden = { currentVersionId: 7, hiddenAt: new Date() };
    expect(sprayWallIsListable(hidden, board, STRANGER)).toBe(false);
    expect(sprayWallIsListable(hidden, board, null)).toBe(false);
    expect(sprayWallIsListable(hidden, board, OWNER)).toBe(true);
    expect(sprayWallIsListable({ currentVersionId: null, hiddenAt: new Date() }, board, OWNER)).toBe(true);
  });
});
