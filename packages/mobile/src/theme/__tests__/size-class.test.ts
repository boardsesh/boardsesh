import { describe, it, expect } from 'vitest';
import {
  resolveDeviceLayout,
  resolveIsTablet,
  resolveWallSurface,
  resolveWallDeviceClass,
  resolveEffectiveWallSurface,
  resolveDetailPaneSurface,
  resolveDetailPaneWidth,
  REGULAR_WIDTH_BREAKPOINT,
  EXPANDED_WIDTH_BREAKPOINT,
  WALL_PANEL_MIN_DEVICE_LONG_SIDE,
  TABLET_MIN_SHORT_SIDE_DP,
} from '../size-class';

const SIDEBAR_WIDTH = 96;

describe('resolveDeviceLayout', () => {
  it('keeps every phone compact regardless of width', () => {
    // A phone is never a tablet, so even a wide landscape phone stays compact
    // (renders the phone UI verbatim).
    expect(resolveDeviceLayout({ width: 932, isTablet: false })).toEqual({ widthClass: 'compact', expanded: false });
    expect(resolveDeviceLayout({ width: 430, isTablet: false })).toEqual({ widthClass: 'compact', expanded: false });
  });

  it('keeps a tablet compact in a narrow split (Slide Over / ⅓ / ½ / small multi-window)', () => {
    // 12.9" iPad split widths: Slide Over ~320, ½ ~507, ⅔ ~664 — all below 700.
    for (const width of [320, 375, 507, 664, REGULAR_WIDTH_BREAKPOINT - 1]) {
      expect(resolveDeviceLayout({ width, isTablet: true })).toEqual({ widthClass: 'compact', expanded: false });
    }
  });

  it('is regular but not expanded for a narrow-regular tablet window', () => {
    // 11" iPad portrait (834) and a ⅔ split that clears 700 but not 1024.
    expect(resolveDeviceLayout({ width: 834, isTablet: true })).toEqual({ widthClass: 'regular', expanded: false });
    expect(resolveDeviceLayout({ width: REGULAR_WIDTH_BREAKPOINT, isTablet: true })).toEqual({
      widthClass: 'regular',
      expanded: false,
    });
    expect(resolveDeviceLayout({ width: EXPANDED_WIDTH_BREAKPOINT - 1, isTablet: true })).toEqual({
      widthClass: 'regular',
      expanded: false,
    });
  });

  it('is regular but not expanded across the tightest real tablet portraits', () => {
    // iPad mini portrait (744), 9.7"/10.2" portrait (768/810) — the narrow-regular
    // band where a persistent detail pane squeezes the browse list. All clear 700
    // (sidebar shows) but not 1024 (no master+detail). See resolveDetailPaneSurface.
    for (const width of [744, 768, 810]) {
      expect(resolveDeviceLayout({ width, isTablet: true })).toEqual({ widthClass: 'regular', expanded: false });
    }
  });

  it('is expanded for a full-screen tablet (portrait 1024+ and any landscape)', () => {
    for (const width of [EXPANDED_WIDTH_BREAKPOINT, 1194, 1366]) {
      expect(resolveDeviceLayout({ width, isTablet: true })).toEqual({ widthClass: 'regular', expanded: true });
    }
  });
});

describe('resolveIsTablet', () => {
  it('is always true on iPad, whatever the screen size', () => {
    for (const screenShortSide of [768, 820, 1024]) {
      expect(resolveIsTablet({ platformOS: 'ios', isPad: true, screenShortSide })).toBe(true);
    }
  });

  it('is false on an iPhone regardless of a wide landscape short side', () => {
    // An iPhone is never a tablet; the sw600 rule only applies to Android.
    expect(resolveIsTablet({ platformOS: 'ios', isPad: false, screenShortSide: 430 })).toBe(false);
    expect(resolveIsTablet({ platformOS: 'ios', isPad: false, screenShortSide: 932 })).toBe(false);
  });

  it('is false on an Android phone (short side below sw600dp)', () => {
    // Typical Android phone smallest widths: 360–420dp; a folded foldable outer
    // display ~360dp — all below the tablet threshold.
    for (const screenShortSide of [360, 411, TABLET_MIN_SHORT_SIDE_DP - 1]) {
      expect(resolveIsTablet({ platformOS: 'android', isPad: false, screenShortSide })).toBe(false);
    }
  });

  it('is true on an Android tablet at or above sw600dp', () => {
    // 7" (~600dp), 10" (~800dp), unfolded foldable inner display — all tablets.
    for (const screenShortSide of [TABLET_MIN_SHORT_SIDE_DP, 720, 800]) {
      expect(resolveIsTablet({ platformOS: 'android', isPad: false, screenShortSide })).toBe(true);
    }
  });

  it('uses the same physical short-side qualifier for web screens', () => {
    expect(resolveIsTablet({ platformOS: 'web', isPad: false, screenShortSide: TABLET_MIN_SHORT_SIDE_DP - 1 })).toBe(
      false,
    );
    expect(resolveIsTablet({ platformOS: 'web', isPad: false, screenShortSide: TABLET_MIN_SHORT_SIDE_DP })).toBe(true);
    expect(resolveIsTablet({ platformOS: 'web', isPad: false, screenShortSide: 900 })).toBe(true);
  });
});

describe('resolveWallSurface', () => {
  it('shows no wall surface at compact width (phone UI owns its own wall chrome)', () => {
    for (const width of [320, 507, 664, 932]) {
      expect(resolveWallSurface({ width, widthClass: 'compact', sidebarWidth: SIDEBAR_WIDTH })).toBe('none');
    }
  });

  it('shows a strip in portrait, where a 4th column would crush the list', () => {
    // 11" portrait 834 → 118pt list; 13" portrait 1032 → 316pt list — both below the floor.
    expect(resolveWallSurface({ width: 834, widthClass: 'regular', sidebarWidth: SIDEBAR_WIDTH })).toBe('strip');
    expect(resolveWallSurface({ width: 1032, widthClass: 'regular', sidebarWidth: SIDEBAR_WIDTH })).toBe('strip');
  });

  it('shows a dedicated column in landscape on both iPad sizes', () => {
    // Wall column stays fixed at 300pt; content + detail split the remaining width.
    // 11" landscape 1194 → 399/399pt; 13" landscape 1366 → 485/485pt.
    expect(resolveWallSurface({ width: 1194, widthClass: 'regular', sidebarWidth: SIDEBAR_WIDTH })).toBe('column');
    expect(resolveWallSurface({ width: 1366, widthClass: 'regular', sidebarWidth: SIDEBAR_WIDTH })).toBe('column');
  });

  it('flips strip→column exactly at the content floor', () => {
    // balancedContentWidth = (width - 96 - 300) / 2; column requires >= 390 → width >= 1176.
    expect(resolveWallSurface({ width: 1175, widthClass: 'regular', sidebarWidth: SIDEBAR_WIDTH })).toBe('strip');
    expect(resolveWallSurface({ width: 1176, widthClass: 'regular', sidebarWidth: SIDEBAR_WIDTH })).toBe('column');
  });
});

describe('resolveWallDeviceClass', () => {
  it('is always sheet-only on a phone, whatever the screen size', () => {
    // Phones never mount the persistent wall panel — the wall lives in the sheet.
    for (const screenLongSide of [844, 932, 1133, 1366]) {
      expect(resolveWallDeviceClass({ screenLongSide, isPad: false, isTablet: false, platformOS: 'ios' })).toBe(
        'sheet-only',
      );
    }
  });

  it('keeps the small iPads on the sheet: mini, base 10.9/11" and Air 11"', () => {
    // Below the 11" Pro's long side (1194): iPad mini (1133), base iPad and Air
    // 11" (1180), and one point under the floor.
    for (const screenLongSide of [1133, 1180, WALL_PANEL_MIN_DEVICE_LONG_SIDE - 1]) {
      expect(resolveWallDeviceClass({ screenLongSide, isPad: true, isTablet: true, platformOS: 'ios' })).toBe(
        'sheet-only',
      );
    }
  });

  it('keeps the panel on the 11" Pro and every 13"', () => {
    // 11" Pro (1194 / M4 1210) and all 13" (12.9" 1366, M4 13" 1376).
    for (const screenLongSide of [WALL_PANEL_MIN_DEVICE_LONG_SIDE, 1210, 1366, 1376]) {
      expect(resolveWallDeviceClass({ screenLongSide, isPad: true, isTablet: true, platformOS: 'ios' })).toBe(
        'panel-capable',
      );
    }
  });

  it('is panel-capable on any Android tablet regardless of the dp long side', () => {
    // No iPad-points floor on Android: the live width budget (resolveWallSurface)
    // decides column/strip/none, so even a small tablet is panel-capable here and
    // gets a strip (not a column) when the width is tight.
    for (const screenLongSide of [960, 1024, 1280, 1600]) {
      expect(resolveWallDeviceClass({ screenLongSide, isPad: false, isTablet: true, platformOS: 'android' })).toBe(
        'panel-capable',
      );
    }
  });

  it('is panel-capable on a qualifying web screen', () => {
    expect(resolveWallDeviceClass({ screenLongSide: 900, isPad: false, isTablet: true, platformOS: 'web' })).toBe(
      'panel-capable',
    );
  });
});

describe('resolveEffectiveWallSurface', () => {
  it('collapses the wall to none on a sheet-only device, at any width', () => {
    // A small iPad in landscape would otherwise get a column; the device floor
    // forces the sheet + "On the Wall" tab instead.
    for (const width of [834, 1194, 1366]) {
      expect(
        resolveEffectiveWallSurface({
          width,
          widthClass: 'regular',
          wallDeviceClass: 'sheet-only',
          sidebarWidth: SIDEBAR_WIDTH,
        }),
      ).toBe('none');
    }
  });

  it('defers to the live width logic on a panel-capable device', () => {
    const capable = { wallDeviceClass: 'panel-capable' as const, sidebarWidth: SIDEBAR_WIDTH };
    expect(resolveEffectiveWallSurface({ width: 1366, widthClass: 'regular', ...capable })).toBe('column');
    expect(resolveEffectiveWallSurface({ width: 834, widthClass: 'regular', ...capable })).toBe('strip');
    expect(resolveEffectiveWallSurface({ width: 932, widthClass: 'compact', ...capable })).toBe('none');
  });
});

describe('resolveDetailPaneWidth', () => {
  it('splits content and detail evenly when the wall column is visible', () => {
    expect(resolveDetailPaneWidth({ width: 1366, sidebarWidth: SIDEBAR_WIDTH, wallColumnVisible: true })).toBe(485);
    expect(resolveDetailPaneWidth({ width: 1194, sidebarWidth: SIDEBAR_WIDTH, wallColumnVisible: true })).toBe(399);
  });

  it('uses the standalone detail-pane clamp when the wall column is hidden', () => {
    expect(resolveDetailPaneWidth({ width: 744, sidebarWidth: SIDEBAR_WIDTH, wallColumnVisible: false })).toBe(320);
    expect(resolveDetailPaneWidth({ width: 1024, sidebarWidth: SIDEBAR_WIDTH, wallColumnVisible: false })).toBe(348);
    expect(resolveDetailPaneWidth({ width: 1366, sidebarWidth: SIDEBAR_WIDTH, wallColumnVisible: false })).toBe(400);
  });
});

describe('resolveDetailPaneSurface', () => {
  it('uses the compact sheet outside regular iPad width', () => {
    expect(resolveDetailPaneSurface({ width: 932, widthClass: 'compact', sidebarWidth: SIDEBAR_WIDTH })).toBe('sheet');
  });

  it('suppresses the pane when the browse list would fall below the readable floor', () => {
    expect(resolveDetailPaneSurface({ width: 744, widthClass: 'regular', sidebarWidth: SIDEBAR_WIDTH })).toBe('sheet');
    expect(resolveDetailPaneSurface({ width: 815, widthClass: 'regular', sidebarWidth: SIDEBAR_WIDTH })).toBe('sheet');
  });

  it('mounts the pane once the browse list clears the readable floor', () => {
    expect(resolveDetailPaneSurface({ width: 816, widthClass: 'regular', sidebarWidth: SIDEBAR_WIDTH })).toBe('pane');
    expect(resolveDetailPaneSurface({ width: 834, widthClass: 'regular', sidebarWidth: SIDEBAR_WIDTH })).toBe('pane');
  });
});
