import { describe, expect, it } from 'vitest';
import {
  CLIMB_LIST_TWO_COLUMN_MIN_WIDTH,
  DEFAULT_CLIMB_LIST_LAYOUT,
  climbListColumns,
  climbListThumbnailSize,
  climbListThumbnailRenderWidth,
  climbListTwoColumnsPossible,
  estimateClimbListWidth,
  sanitiseClimbListLayout,
  sizedThumbnailRenderWidth,
} from '../climb-list-thumbnail-metrics';

// The list's own width on each device, as `climbListColumns` sees it: the window
// less whatever sits beside the list. Native iPad: the sidebar (280pt) in
// landscape, a top tab bar in portrait. iPhone Duo open in landscape: the player
// takes the leading half (476pt) and the tab rail 84pt of the rest.
const LIST_WIDTH = {
  iPhone17Pro: 402,
  iPhoneProMax: 440,
  duoClosed: 466,
  duoOpenPortrait: 669,
  duoOpenLandscapeSplit: 951 - 476 - 84,
  duoOpenLandscapeSplitRailCollapsed: 951 - 476,
  ipad11Portrait: 834,
  ipad11Landscape: 1194 - 280,
  ipad11LandscapeSidebarHidden: 1194,
  ipad13Portrait: 1032,
  ipad13Landscape: 1366 - 280,
  ipadMiniLandscape: 1133 - 280,
  ipad13OneThirdSplit: 440,
  ipad11OneThirdSplit: 375,
};

function columnsAt(listWidth: number, preference: 'one' | 'two' = 'two') {
  return climbListColumns({ listWidth, preference });
}

describe('climbListColumns', () => {
  it('keeps every iPhone on one column', () => {
    expect(columnsAt(LIST_WIDTH.iPhone17Pro)).toBe(1);
    expect(columnsAt(LIST_WIDTH.iPhoneProMax)).toBe(1);
  });

  it('keeps the closed iPhone Duo on one column', () => {
    expect(columnsAt(LIST_WIDTH.duoClosed)).toBe(1);
  });

  it('keeps the open iPhone Duo on one column while the player shares the window', () => {
    expect(columnsAt(LIST_WIDTH.duoOpenPortrait)).toBe(1);
    expect(columnsAt(LIST_WIDTH.duoOpenLandscapeSplit)).toBe(1);
    expect(columnsAt(LIST_WIDTH.duoOpenLandscapeSplitRailCollapsed)).toBe(1);
  });

  it('gives the open iPhone Duo two columns only if its list ever gets the full inner display', () => {
    // 951 wide with the rail collapsed to nothing: the one Duo width that clears the floor.
    expect(columnsAt(951)).toBe(2);
    // With the 84pt rail beside it, 867 does not.
    expect(columnsAt(951 - 84)).toBe(1);
  });

  it('keeps the 11" iPad on one column in portrait', () => {
    expect(columnsAt(LIST_WIDTH.ipad11Portrait)).toBe(1);
  });

  it('gives the 11" iPad two columns in landscape, with or without the sidebar', () => {
    expect(columnsAt(LIST_WIDTH.ipad11Landscape)).toBe(2);
    expect(columnsAt(LIST_WIDTH.ipad11LandscapeSidebarHidden)).toBe(2);
  });

  it('gives the 13" iPad two columns either way up', () => {
    expect(columnsAt(LIST_WIDTH.ipad13Portrait)).toBe(2);
    expect(columnsAt(LIST_WIDTH.ipad13Landscape)).toBe(2);
  });

  it('keeps a ⅓ split and an iPad mini with its sidebar open on one column', () => {
    expect(columnsAt(LIST_WIDTH.ipad13OneThirdSplit)).toBe(1);
    expect(columnsAt(LIST_WIDTH.ipad11OneThirdSplit)).toBe(1);
    expect(columnsAt(LIST_WIDTH.ipadMiniLandscape)).toBe(1);
  });

  it('starts two columns exactly at the floor', () => {
    expect(CLIMB_LIST_TWO_COLUMN_MIN_WIDTH).toBe(900);
    expect(columnsAt(899)).toBe(1);
    expect(columnsAt(900)).toBe(2);
  });

  it('honours One column on a list wide enough for two', () => {
    expect(columnsAt(LIST_WIDTH.ipad13Landscape, 'one')).toBe(1);
    expect(columnsAt(LIST_WIDTH.ipad11Landscape, 'one')).toBe(1);
  });
});

describe('climbListThumbnailSize', () => {
  it('draws 88×112 in two columns', () => {
    expect(climbListThumbnailSize(2)).toEqual({ width: 88, height: 112 });
  });

  it('keeps 76×96 in one column: every iPhone, the Duo and narrow iPad splits', () => {
    for (const listWidth of [
      LIST_WIDTH.iPhone17Pro,
      LIST_WIDTH.duoClosed,
      LIST_WIDTH.duoOpenLandscapeSplit,
      LIST_WIDTH.ipad11Portrait,
      LIST_WIDTH.ipad13OneThirdSplit,
    ]) {
      expect(climbListThumbnailSize(columnsAt(listWidth))).toEqual({ width: 76, height: 96 });
    }
  });

  it('hands back the same object for the same column count, so it can be a context value', () => {
    expect(climbListThumbnailSize(2)).toBe(climbListThumbnailSize(2));
    expect(climbListThumbnailSize(1)).toBe(climbListThumbnailSize(1));
  });
});

describe('climbListTwoColumnsPossible', () => {
  it('offers the choice on every iPad', () => {
    expect(climbListTwoColumnsPossible({ isTablet: true, screenLongSide: 1133 })).toBe(true);
    expect(climbListTwoColumnsPossible({ isTablet: true, screenLongSide: 1366 })).toBe(true);
  });

  it('hides it on an iPhone, the Pro Max included: portrait-locked at phone width', () => {
    expect(climbListTwoColumnsPossible({ isTablet: false, screenLongSide: 874 })).toBe(false);
    expect(climbListTwoColumnsPossible({ isTablet: false, screenLongSide: 956 })).toBe(false);
  });

  it('hides it on the iPhone Duo, closed or open: its list never reaches 900pt', () => {
    expect(climbListTwoColumnsPossible({ isTablet: false, screenLongSide: 678 })).toBe(false);
    expect(climbListTwoColumnsPossible({ isTablet: false, screenLongSide: 951 })).toBe(false);
  });
});

describe('estimateClimbListWidth: the first render, before the list is measured', () => {
  const ipad = { safeAreaLeft: 0, safeAreaRight: 0, measuredContentColumnLeft: 0, isPad: true, regularWidth: true };

  it('takes the sidebar off a regular-width iPad in landscape', () => {
    // iPad mini landscape: 1133 − 280 = 853, one column, the same as it measures.
    expect(estimateClimbListWidth({ ...ipad, windowWidth: 1133, windowHeight: 744 })).toBe(853);
    expect(columnsAt(estimateClimbListWidth({ ...ipad, windowWidth: 1133, windowHeight: 744 }))).toBe(1);
    expect(estimateClimbListWidth({ ...ipad, windowWidth: 1194, windowHeight: 834 })).toBe(914);
  });

  it('takes nothing off an iPad in portrait, where the tabs sit at the top', () => {
    expect(estimateClimbListWidth({ ...ipad, windowWidth: 1032, windowHeight: 1376 })).toBe(1032);
  });

  it('prefers the measured content column when there is one', () => {
    expect(
      estimateClimbListWidth({ ...ipad, windowWidth: 1194, windowHeight: 834, measuredContentColumnLeft: 320 }),
    ).toBe(874);
  });

  it('takes the side safe area off a phone and never a sidebar', () => {
    const phone = { ...ipad, isPad: false, regularWidth: false };
    expect(estimateClimbListWidth({ ...phone, windowWidth: 402, windowHeight: 874 })).toBe(402);
    expect(estimateClimbListWidth({ ...phone, windowWidth: 951, windowHeight: 669, safeAreaRight: 84 })).toBe(867);
  });
});

describe('climbListThumbnailRenderWidth: the overlay cache key', () => {
  it('keeps the one-column cell on 400px at every phone density', () => {
    expect(climbListThumbnailRenderWidth(76, 2)).toBe(400);
    expect(climbListThumbnailRenderWidth(76, 3)).toBe(400);
    expect(climbListThumbnailRenderWidth(76, 4)).toBe(400);
  });

  it('keeps the two-column cell on 400px on an iPad, sharing the MiniPlayer’s entry', () => {
    expect(climbListThumbnailRenderWidth(88, 2)).toBe(400);
  });

  it('leaves the sized cells on their shipped 5× widths', () => {
    expect(sizedThumbnailRenderWidth(84)).toBe(420);
    expect(sizedThumbnailRenderWidth(64)).toBe(400);
  });
});

describe('sanitiseClimbListLayout', () => {
  it('keeps a known choice and defaults anything else to two columns', () => {
    expect(DEFAULT_CLIMB_LIST_LAYOUT).toBe('two');
    expect(sanitiseClimbListLayout('one')).toBe('one');
    expect(sanitiseClimbListLayout('two')).toBe('two');
    expect(sanitiseClimbListLayout(null)).toBe('two');
    expect(sanitiseClimbListLayout('three')).toBe('two');
  });
});
