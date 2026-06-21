import { describe, it, expect } from 'vitest';
import { boardLooselyMatches } from '../boards/board-matches';

describe('boardLooselyMatches', () => {
  it('is false when either side is null', () => {
    expect(boardLooselyMatches(null, { boardName: 'kilter', layoutId: 1 })).toBe(false);
    expect(boardLooselyMatches({ boardName: 'kilter', layoutId: 1 }, null)).toBe(false);
    expect(boardLooselyMatches(undefined, undefined)).toBe(false);
  });

  it('matches on board name + layout', () => {
    expect(boardLooselyMatches({ boardName: 'kilter', layoutId: 1 }, { boardName: 'kilter', layoutId: 1 })).toBe(true);
  });

  it('rejects a different board name', () => {
    expect(boardLooselyMatches({ boardName: 'kilter', layoutId: 1 }, { boardName: 'tension', layoutId: 1 })).toBe(
      false,
    );
  });

  it('rejects a different layout on the same board', () => {
    expect(boardLooselyMatches({ boardName: 'kilter', layoutId: 1 }, { boardName: 'kilter', layoutId: 8 })).toBe(false);
  });

  it('treats a null/undefined layout on either side as unspecified (still matches)', () => {
    expect(boardLooselyMatches({ boardName: 'kilter', layoutId: null }, { boardName: 'kilter', layoutId: 8 })).toBe(
      true,
    );
    expect(boardLooselyMatches({ boardName: 'kilter' }, { boardName: 'kilter', layoutId: 8 })).toBe(true);
  });
});
