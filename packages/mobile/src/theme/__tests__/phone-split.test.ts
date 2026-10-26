import { describe, it, expect } from 'vitest';
import {
  resolveDeviceLayout,
  resolveDetailPaneSurface,
  resolvePhoneSplit,
  resolvePhoneSplitColumns,
  resolveWallSurface,
  PHONE_SPLIT_FOLD_GUTTER,
  PHONE_SPLIT_MIN_HEIGHT,
  PHONE_SPLIT_MIN_WIDTH,
} from '../size-class';

const SIDEBAR_WIDTH = 96;

// iPhone Duo windows, in points: closed (outer display), open portrait and open
// landscape (inner display). The landscape window is the only phone split.
const DUO_CLOSED = { width: 466, height: 678 };
const DUO_OPEN_PORTRAIT = { width: 669, height: 951 };
const DUO_OPEN_LANDSCAPE = { width: 951, height: 669 };
// iPad windows the tablet shell already handles: mini portrait, 11" portrait and
// landscape, 13" portrait and landscape.
const IPAD_WINDOWS = [
  { width: 744, height: 1133 },
  { width: 834, height: 1210 },
  { width: 1194, height: 834 },
  { width: 1032, height: 1376 },
  { width: 1376, height: 1032 },
];

describe('resolvePhoneSplit', () => {
  it('splits only the open Duo held in landscape', () => {
    expect(resolvePhoneSplit({ platformOS: 'ios', isTablet: false, ...DUO_OPEN_LANDSCAPE })).toBe(true);
    expect(resolvePhoneSplit({ platformOS: 'ios', isTablet: false, ...DUO_OPEN_PORTRAIT })).toBe(false);
    expect(resolvePhoneSplit({ platformOS: 'ios', isTablet: false, ...DUO_CLOSED })).toBe(false);
  });

  it('keeps a landscape Pro Max on the phone UI: wide, but too short for a board beside a list', () => {
    expect(resolvePhoneSplit({ platformOS: 'ios', isTablet: false, width: 956, height: 440 })).toBe(false);
  });

  it('includes both floors', () => {
    expect(
      resolvePhoneSplit({
        platformOS: 'ios',
        isTablet: false,
        width: PHONE_SPLIT_MIN_WIDTH,
        height: PHONE_SPLIT_MIN_HEIGHT,
      }),
    ).toBe(true);
    expect(
      resolvePhoneSplit({ platformOS: 'ios', isTablet: false, width: PHONE_SPLIT_MIN_WIDTH - 1, height: 669 }),
    ).toBe(false);
    expect(
      resolvePhoneSplit({ platformOS: 'ios', isTablet: false, width: 951, height: PHONE_SPLIT_MIN_HEIGHT - 1 }),
    ).toBe(false);
  });

  it('never splits a tablet, so every iPad window keeps its own shell', () => {
    for (const ipadWindow of IPAD_WINDOWS) {
      expect(resolvePhoneSplit({ platformOS: 'ios', isTablet: true, ...ipadWindow })).toBe(false);
    }
  });

  it('is iOS-only', () => {
    expect(resolvePhoneSplit({ platformOS: 'android', isTablet: false, ...DUO_OPEN_LANDSCAPE })).toBe(false);
    expect(resolvePhoneSplit({ platformOS: 'web', isTablet: false, ...DUO_OPEN_LANDSCAPE })).toBe(false);
  });
});

describe('phone windows leave the iPad rules alone', () => {
  it('keeps every Duo pose compact, with no tablet pane or wall surface', () => {
    for (const duoWindow of [DUO_CLOSED, DUO_OPEN_PORTRAIT, DUO_OPEN_LANDSCAPE]) {
      const layout = resolveDeviceLayout({ width: duoWindow.width, isTablet: false });
      expect(layout).toEqual({ widthClass: 'compact', expanded: false });
      expect(
        resolveDetailPaneSurface({
          width: duoWindow.width,
          widthClass: layout.widthClass,
          sidebarWidth: SIDEBAR_WIDTH,
        }),
      ).toBe('sheet');
      expect(
        resolveWallSurface({ width: duoWindow.width, widthClass: layout.widthClass, sidebarWidth: SIDEBAR_WIDTH }),
      ).toBe('none');
    }
  });

  it('resolves iPad windows exactly as before', () => {
    const resolved = IPAD_WINDOWS.map(({ width }) => {
      const { widthClass, expanded } = resolveDeviceLayout({ width, isTablet: true });
      return {
        width,
        widthClass,
        expanded,
        detail: resolveDetailPaneSurface({ width, widthClass, sidebarWidth: SIDEBAR_WIDTH }),
        wall: resolveWallSurface({ width, widthClass, sidebarWidth: SIDEBAR_WIDTH }),
      };
    });
    expect(resolved).toEqual([
      { width: 744, widthClass: 'regular', expanded: false, detail: 'sheet', wall: 'strip' },
      { width: 834, widthClass: 'regular', expanded: false, detail: 'pane', wall: 'strip' },
      { width: 1194, widthClass: 'regular', expanded: true, detail: 'pane', wall: 'column' },
      { width: 1032, widthClass: 'regular', expanded: true, detail: 'pane', wall: 'strip' },
      { width: 1376, widthClass: 'regular', expanded: true, detail: 'pane', wall: 'column' },
    ]);
  });
});

describe('resolvePhoneSplitColumns', () => {
  it('puts the split on the hinge, the window centre', () => {
    expect(resolvePhoneSplitColumns({ windowWidth: 951, partiallyFolded: false })).toEqual({
      leadingWidth: 476,
      foldInset: 0,
    });
  });

  it('keeps half the fold gutter clear on each side when half open, without moving the hinge', () => {
    expect(resolvePhoneSplitColumns({ windowWidth: 951, partiallyFolded: true })).toEqual({
      leadingWidth: 476,
      foldInset: PHONE_SPLIT_FOLD_GUTTER / 2,
    });
  });
});
