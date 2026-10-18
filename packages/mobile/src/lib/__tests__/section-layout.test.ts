import { describe, expect, it } from 'vitest';
import {
  canMoveSection,
  isSameSectionLayout,
  isSameSectionOrder,
  sanitiseSectionLayout,
  sanitiseSectionOrder,
  unknownSectionVisibility,
  visibleSectionIds,
  withAllSectionsVisible,
  withSectionMoved,
  withSectionVisible,
  withUnknownSectionsKept,
  type SectionLayoutSpec,
} from '../section-layout';

type HomeLikeId = 'board' | 'session' | 'playlists' | 'feed';
const SPEC: SectionLayoutSpec<HomeLikeId> = {
  ids: ['board', 'session', 'playlists', 'feed'],
  defaults: {
    order: ['board', 'session', 'playlists', 'feed'],
    visible: { board: false, session: true, playlists: false, feed: true },
  },
};
const LOCKED_SPEC: SectionLayoutSpec<HomeLikeId> = { ...SPEC, lockedLast: 'feed' };

describe('sanitiseSectionOrder', () => {
  it('falls back to the default order for anything that is not a list', () => {
    for (const stored of [undefined, null, 'board', { 0: 'feed' }]) {
      expect(sanitiseSectionOrder(SPEC, stored)).toEqual(SPEC.defaults.order);
    }
  });

  it('drops unknown and repeated ids', () => {
    expect(sanitiseSectionOrder(SPEC, ['feed', 'gone', 'board', 7, 'feed', 'session', 'playlists'])).toEqual([
      'feed',
      'board',
      'session',
      'playlists',
    ]);
  });

  it('slots a section the record never saw in after the one it follows in the defaults', () => {
    expect(sanitiseSectionOrder(SPEC, ['feed', 'session', 'board'])).toEqual(['feed', 'session', 'playlists', 'board']);
    expect(sanitiseSectionOrder(SPEC, ['session', 'playlists', 'feed'])).toEqual([
      'board',
      'session',
      'playlists',
      'feed',
    ]);
    expect(sanitiseSectionOrder(SPEC, ['playlists'])).toEqual(['board', 'session', 'playlists', 'feed']);
  });

  it('keeps a locked section last whatever the record says', () => {
    expect(sanitiseSectionOrder(LOCKED_SPEC, ['feed', 'playlists', 'session', 'board'])).toEqual([
      'playlists',
      'session',
      'board',
      'feed',
    ]);
  });
});

describe('sanitiseSectionLayout', () => {
  it('reads booleans and fills everything else from the defaults', () => {
    expect(
      sanitiseSectionLayout(SPEC, {
        order: ['playlists', 'board', 'session', 'feed'],
        visible: { board: true, session: 'no', feed: null, gone: true },
      }),
    ).toEqual({
      order: ['playlists', 'board', 'session', 'feed'],
      visible: { board: true, session: true, playlists: false, feed: true },
    });
  });

  it.each([null, undefined, 'broken', 3])('reads %s as the defaults', (stored) => {
    expect(sanitiseSectionLayout(SPEC, stored)).toEqual(SPEC.defaults);
  });
});

describe('moving a section', () => {
  it('swaps with its neighbour, hidden or not, and leaves visibility alone', () => {
    const moved = withSectionMoved(SPEC, SPEC.defaults, 'session', 1);
    expect(moved.order).toEqual(['board', 'playlists', 'session', 'feed']);
    expect(moved.visible).toBe(SPEC.defaults.visible);
    expect(withSectionMoved(SPEC, moved, 'session', -1).order).toEqual(SPEC.defaults.order);
  });

  it('returns the same layout at either end', () => {
    expect(withSectionMoved(SPEC, SPEC.defaults, 'board', -1)).toBe(SPEC.defaults);
    expect(withSectionMoved(SPEC, SPEC.defaults, 'feed', 1)).toBe(SPEC.defaults);
    expect(canMoveSection(SPEC, SPEC.defaults, 'board', -1)).toBe(false);
    expect(canMoveSection(SPEC, SPEC.defaults, 'board', 1)).toBe(true);
  });

  it('never moves a locked section, nor anything past it', () => {
    expect(withSectionMoved(LOCKED_SPEC, LOCKED_SPEC.defaults, 'feed', -1)).toBe(LOCKED_SPEC.defaults);
    expect(withSectionMoved(LOCKED_SPEC, LOCKED_SPEC.defaults, 'playlists', 1)).toBe(LOCKED_SPEC.defaults);
    expect(canMoveSection(LOCKED_SPEC, LOCKED_SPEC.defaults, 'playlists', -1)).toBe(true);
  });

  it('ignores a section the layout does not hold', () => {
    const partial = { ...SPEC.defaults, order: ['board', 'session'] as HomeLikeId[] };
    expect(withSectionMoved(SPEC, partial, 'feed', -1)).toBe(partial);
  });
});

describe('visibility', () => {
  it('hides a section in place, so showing it again puts it back', () => {
    const moved = withSectionMoved(SPEC, SPEC.defaults, 'feed', -1);
    const hidden = withSectionVisible(moved, 'feed', false);
    expect(visibleSectionIds(hidden)).toEqual(['session']);
    expect(hidden.order).toEqual(['board', 'session', 'feed', 'playlists']);
    expect(visibleSectionIds(withSectionVisible(hidden, 'feed', true))).toEqual(['session', 'feed']);
  });

  it('shows or hides everything without touching the order', () => {
    const moved = withSectionMoved(SPEC, SPEC.defaults, 'feed', -1);
    expect(visibleSectionIds(withAllSectionsVisible(moved, true))).toEqual(['board', 'session', 'feed', 'playlists']);
    expect(visibleSectionIds(withAllSectionsVisible(moved, false))).toEqual([]);
  });

  it('returns the same layout when nothing changes', () => {
    expect(withSectionVisible(SPEC.defaults, 'session', true)).toBe(SPEC.defaults);
    const allVisible = withAllSectionsVisible(SPEC.defaults, true);
    expect(withAllSectionsVisible(allVisible, true)).toBe(allVisible);
  });

  it('drops sections that have nothing to show here', () => {
    expect(visibleSectionIds(SPEC.defaults, (sectionId) => sectionId !== 'feed')).toEqual(['session']);
  });
});

describe('comparing layouts', () => {
  it('compares order and visibility', () => {
    expect(
      isSameSectionLayout(SPEC.defaults, { order: [...SPEC.defaults.order], visible: { ...SPEC.defaults.visible } }),
    ).toBe(true);
    expect(isSameSectionLayout(SPEC.defaults, withSectionVisible(SPEC.defaults, 'board', true))).toBe(false);
    expect(isSameSectionLayout(SPEC.defaults, withSectionMoved(SPEC, SPEC.defaults, 'board', 1))).toBe(false);
    expect(isSameSectionOrder(['board'], ['board', 'feed'])).toBe(false);
  });
});

describe('a spec with mistakes', () => {
  it('ignores a locked id the spec does not list instead of dropping the last section', () => {
    const spec = { ...SPEC, lockedLast: 'gone' as HomeLikeId };
    expect(sanitiseSectionOrder(spec, ['feed', 'playlists', 'session', 'board'])).toEqual([
      'feed',
      'playlists',
      'session',
      'board',
    ]);
  });

  it('leaves a stray default id out and shows a section whose default is missing', () => {
    const spec: SectionLayoutSpec<HomeLikeId> = {
      ids: SPEC.ids,
      defaults: {
        order: ['board', 'gone' as HomeLikeId, 'session', 'playlists', 'feed'],
        visible: { board: false, session: true, playlists: false } as Record<HomeLikeId, boolean>,
      },
    };
    expect(sanitiseSectionLayout(spec, spec.defaults)).toEqual({
      order: ['board', 'session', 'playlists', 'feed'],
      visible: { board: false, session: true, playlists: false, feed: true },
    });
  });
});

describe('ids a later release stored', () => {
  it('go back in after the id they followed, or first', () => {
    const stored = ['newFirst', 'feed', 'board', 'newAfterBoard', 'session', 'playlists', 'newLast'];
    const order = sanitiseSectionOrder(SPEC, stored);
    expect(order).toEqual(['feed', 'board', 'session', 'playlists']);
    const moved = withSectionMoved(SPEC, { order, visible: SPEC.defaults.visible }, 'session', -1).order;
    expect(withUnknownSectionsKept(SPEC, moved, stored)).toEqual([
      'newFirst',
      'feed',
      'session',
      'board',
      'newAfterBoard',
      'playlists',
      'newLast',
    ]);
  });

  it('leaves the order alone when the record has none, or nothing unknown', () => {
    expect(withUnknownSectionsKept(SPEC, SPEC.defaults.order, undefined)).toEqual(SPEC.defaults.order);
    expect(withUnknownSectionsKept(SPEC, SPEC.defaults.order, ['feed', 3, 'board'])).toEqual(SPEC.defaults.order);
  });

  it('keep their switches', () => {
    expect(unknownSectionVisibility(SPEC, { board: true, later: false, odd: 'yes' })).toEqual({ later: false });
    expect(unknownSectionVisibility(SPEC, null)).toEqual({});
  });
});
