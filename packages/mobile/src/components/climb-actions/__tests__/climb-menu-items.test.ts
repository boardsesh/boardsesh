import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import type { Climb } from '@boardsesh/shared-schema';
import { buildClimbMenuItems, climbAuroraAppUrl, type ClimbMenuArgs, type ClimbMenuState } from '../climb-menu-items';

// The rules alone: the menu a hold shows and the command host that runs a
// selection both read this builder, so what it offers is what every menu offers.
const climb = { uuid: 'climb-1', name: 'Crimp Line', userId: 'setter-1' } as Climb;
const kilter = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };
const tension = { ...kilter, boardName: 'tension' };

function menu(args: Partial<ClimbMenuArgs> = {}, state: Partial<ClimbMenuState> = {}, dispatch = vi.fn()) {
  return buildClimbMenuItems(
    { climb, boardConfig: kilter, isAuthenticated: false, ...args },
    {
      t: ((key: string) => key) as unknown as TFunction<'climbs'>,
      actionColors: { success: 'green', favorite: 'pink', accent: 'purple' } as ClimbMenuState['actionColors'],
      activeClimbUuid: null,
      wallArchived: false,
      moderationEnabled: true,
      canReplay: false,
      ...state,
    },
    dispatch,
  );
}
const ids = (...input: Parameters<typeof menu>) => menu(...input).map((item) => item.id);

describe('buildClimbMenuItems', () => {
  it('offers the universal rows for a plain climb, and never a Preview', () => {
    expect(ids()).toEqual(['playNext', 'queue', 'playlist', 'favorite', 'tick', 'fork', 'share']);
    // An archived wall keeps its climbs readable but takes no new climb.
    expect(ids({}, { wallArchived: true })).not.toContain('fork');
  });

  it('hides Play next on the climb already up and shows Replay only for a replayable slot', () => {
    expect(ids({}, { activeClimbUuid: climb.uuid })).not.toContain('playNext');
    expect(ids({}, { canReplay: true })).toEqual(expect.arrayContaining(['replayFromHere']));
    expect(ids({}, { canReplay: false })).not.toContain('replayFromHere');
  });

  it('adds the caller-owned rows only when the caller passes them', () => {
    const withCallers = ids({
      onEditEntry: vi.fn(),
      onOpenQueue: vi.fn(),
      onOpenViewOptions: vi.fn(),
      onOpenAngle: vi.fn(),
      mirrorControl: { isMirrored: false, onToggle: vi.fn() },
    });
    expect(withCallers).toEqual(expect.arrayContaining(['editEntry', 'openQueue', 'viewOptions', 'angle', 'mirror']));
  });

  it('gates the signed-in and board rows', () => {
    expect(ids({ isAuthenticated: true })).toEqual(expect.arrayContaining(['betaVideo', 'report']));
    expect(ids({ isAuthenticated: true }, { moderationEnabled: false })).not.toContain('report');
    // A draft is never shared or reported.
    const draft = ids({ isAuthenticated: true, climb: { ...climb, is_draft: true } as Climb });
    expect(draft).not.toContain('share');
    expect(draft).not.toContain('report');
    expect(ids({ boardConfig: tension })).toContain('openInApp');
    expect(ids()).not.toContain('openInApp');
  });

  it('labels a caller-owned favourite by the way it goes', () => {
    const favorite = (isFavorited: boolean) =>
      menu({ favoriteControl: { isFavorited, onToggle: vi.fn() } }).find((item) => item.id === 'favorite');
    expect(favorite(true)).toMatchObject({
      title: 'session:playView.actionBar.removeFavoriteAria',
      icon: 'favorite.fill',
    });
    expect(favorite(false)).toMatchObject({ title: 'session:playView.actionBar.addFavoriteAria', icon: 'favorite' });
  });

  it("names a list menu's favourite by what it knows", () => {
    const favorite = (isFavorited?: boolean) => menu({}, { isFavorited }).find((item) => item.id === 'favorite');
    // A favourite the store holds is certain, so the row says it removes it.
    expect(favorite(true)).toMatchObject({
      title: 'session:playView.actionBar.removeFavoriteAria',
      icon: 'favorite.fill',
    });
    // A miss may only mean the status hasn't loaded: the label stays neutral.
    expect(favorite(false)).toMatchObject({ title: 'mobile.climbRow.toggleFavorite', icon: 'favorite' });
    expect(favorite(undefined)).toMatchObject({ title: 'mobile.climbRow.toggleFavorite', icon: 'favorite' });
  });

  it('dispatches the id of the row that was chosen', () => {
    const dispatch = vi.fn();
    const items = menu({ isAuthenticated: true }, {}, dispatch);
    for (const item of items) item.run();
    expect(dispatch.mock.calls.map(([id]) => id)).toEqual(items.map((item) => item.id));
  });

  it('builds nothing without a climb or a board', () => {
    expect(menu({ climb: null })).toEqual([]);
    expect(menu({ boardConfig: null })).toEqual([]);
  });
});

describe('climbAuroraAppUrl', () => {
  it('links Tension to its app page and gives Kilter none', () => {
    expect(climbAuroraAppUrl('tension', climb)).toBe('https://tensionboardapp2.com/climbs/climb-1');
    expect(climbAuroraAppUrl('kilter', climb)).toBeNull();
    expect(climbAuroraAppUrl('moonboard', climb)).toBeNull();
  });
});
