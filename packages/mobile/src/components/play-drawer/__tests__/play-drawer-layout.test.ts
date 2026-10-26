import { describe, expect, it } from 'vitest';
import {
  CAROUSEL_LAYER_Z,
  computeContainedBoardSize,
  computeFirstScreenHeight,
  computeDrawerFirstScreenHeight,
  computeFirstSectionScrollTarget,
  computeFitToHeightFirstScreenHeight,
  initialDrawerPreviewItem,
  PLAYER_SIDE_PANEL_WIDTH,
  resolvePlayerArrangement,
  shouldShowPanePlaceholder,
} from '../play-drawer-layout';

describe('resolvePlayerArrangement', () => {
  const ipads = [
    { name: 'iPad mini', portrait: { width: 744, height: 1133 } },
    { name: 'iPad 11-inch', portrait: { width: 834, height: 1210 } },
    { name: 'iPad 13-inch', portrait: { width: 1032, height: 1376 } },
  ];

  it.each(ipads)('$name puts the board beside the panel in landscape', ({ portrait }) => {
    const landscape = { width: portrait.height, height: portrait.width };
    expect(resolvePlayerArrangement({ ...landscape, isTablet: true })).toBe('sideBySide');
    // The board column keeps at least 600pt beside the 400pt panel.
    expect(landscape.width - PLAYER_SIDE_PANEL_WIDTH).toBeGreaterThanOrEqual(600);
  });

  it.each(ipads)('$name keeps the board on top in portrait', ({ portrait }) => {
    expect(resolvePlayerArrangement({ ...portrait, isTablet: true })).toBe('stacked');
  });

  it('keeps every phone stacked, landscape and the iPhone Duo split included', () => {
    for (const phone of [
      { width: 402, height: 874 },
      { width: 874, height: 402 },
      { width: 440, height: 956 },
      { width: 956, height: 440 },
      // The Duo opened flat: a wide window, still a phone.
      { width: 1338, height: 669 },
    ]) {
      expect(resolvePlayerArrangement({ ...phone, isTablet: false })).toBe('stacked');
    }
  });

  it('keeps a wide but small Stage Manager window stacked', () => {
    expect(resolvePlayerArrangement({ width: 980, height: 700, isTablet: true })).toBe('stacked');
    expect(resolvePlayerArrangement({ width: 1000, height: 700, isTablet: true })).toBe('sideBySide');
  });

  it('stays stacked in a square window', () => {
    expect(resolvePlayerArrangement({ width: 1032, height: 1032, isTablet: true })).toBe('stacked');
  });
});

describe('computeFitToHeightFirstScreenHeight', () => {
  // The iPhone Duo's split pane: 669pt tall, a 21pt home-indicator inset, and the
  // 64pt favourite/share row.
  const pane = { viewport: 669, bottomInset: 21, belowFoldRowHeight: 64 };

  it('fills the pane down to the tick row and puts the next row just below the fold', () => {
    const firstScreen = computeFitToHeightFirstScreenHeight(pane);
    expect(firstScreen).toBe(712);
    expect(firstScreen - pane.belowFoldRowHeight).toBe(pane.viewport - pane.bottomInset);
  });

  it('gives the board far more room than the usual first screen on the same pane', () => {
    const usual = computeDrawerFirstScreenHeight({
      viewport: pane.viewport,
      bottomInset: pane.bottomInset,
      firstSectionHeaderHeight: 52,
      sectionTopPadding: 12,
      sectionMargin: 8,
    });
    // Both first screens hold the same header, tick row and favourite/share row.
    // The usual one ends above the Logbook peek (72pt reserved); the fit one ends
    // with that row hanging just below the fold. The board gets the difference:
    // 64 + 72 - 21 = 115pt more height.
    const usualBoardRoom = usual - pane.belowFoldRowHeight;
    const fitBoardRoom = computeFitToHeightFirstScreenHeight(pane) - pane.belowFoldRowHeight;
    expect(fitBoardRoom - usualBoardRoom).toBe(115);
  });

  it('never goes negative before the viewport is measured', () => {
    expect(computeFitToHeightFirstScreenHeight({ viewport: 0, bottomInset: 21, belowFoldRowHeight: 64 })).toBe(64);
  });
});

describe('computeContainedBoardSize', () => {
  it('height-bounds a tall board on a wide box (horizontal letterbox)', () => {
    // box 400x800, board aspect 0.4 → full height, width 320 < 400.
    expect(computeContainedBoardSize(400, 800, 0.4)).toEqual({ width: 320, height: 800 });
  });

  it('width-bounds a wide board (vertical letterbox)', () => {
    // box 400x800, board aspect 2 → full width, height 200 < 800.
    expect(computeContainedBoardSize(400, 800, 2)).toEqual({ width: 400, height: 200 });
  });

  it('width-bounds a square board in a tall box', () => {
    expect(computeContainedBoardSize(400, 800, 1)).toEqual({ width: 400, height: 400 });
  });

  it('height-bounds a square board in a wide box', () => {
    expect(computeContainedBoardSize(800, 400, 1)).toEqual({ width: 400, height: 400 });
  });

  it('treats an exact fit as height-bound (boundary)', () => {
    // box 300x400, aspect 0.75 → widthAtFullHeight === boxWidth (300).
    expect(computeContainedBoardSize(300, 400, 0.75)).toEqual({ width: 300, height: 400 });
  });

  it('never exceeds the box on either axis', () => {
    const box = computeContainedBoardSize(360, 500, 0.73);
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(360);
    expect(box!.height).toBeLessThanOrEqual(500);
  });

  it('returns null for a not-yet-measured or invalid box', () => {
    expect(computeContainedBoardSize(0, 800, 0.7)).toBeNull();
    expect(computeContainedBoardSize(400, 0, 0.7)).toBeNull();
    expect(computeContainedBoardSize(400, 800, 0)).toBeNull();
    expect(computeContainedBoardSize(-1, 800, 0.7)).toBeNull();
  });
});

describe('computeFirstScreenHeight', () => {
  it('subtracts the reserve from the window when above the floor', () => {
    expect(computeFirstScreenHeight(800, 100)).toBe(700);
  });

  it('floors at half the window when the reserve is too large', () => {
    expect(computeFirstScreenHeight(800, 500)).toBe(400);
  });

  it('honours a custom floor fraction', () => {
    expect(computeFirstScreenHeight(1000, 900, 0.6)).toBe(600);
  });
});

describe('shouldShowPanePlaceholder', () => {
  it('shows only for an empty persistent pane', () => {
    expect(shouldShowPanePlaceholder(true, false)).toBe(true);
    expect(shouldShowPanePlaceholder(true, true)).toBe(false);
    expect(shouldShowPanePlaceholder(false, false)).toBe(false);
  });
});

describe('computeFirstSectionScrollTarget', () => {
  // firstScreenHeight 700, topPadding 12 → the section starts at content y 712.
  const base = {
    firstScreenHeight: 700,
    topPadding: 12,
    viewport: 800,
    topInset: 60,
    bottomInset: 34,
    margin: 8,
  };

  it('lands a short section bottom just above the home indicator (board stays partly visible)', () => {
    // section 200 tall: bottom-into-view = 712 + 200 - 800 + 34 + 8 = 154;
    // header-to-top = 712 - 60 - 8 = 644 → min picks the gentler 154.
    expect(computeFirstSectionScrollTarget({ ...base, sectionHeight: 200 })).toBe(154);
  });

  it('caps a tall section so its header stops under the top inset instead of scrolling its top away', () => {
    // section 900 tall: bottom-into-view = 712 + 900 - 800 + 34 + 8 = 854;
    // header-to-top = 644 → min caps at 644 so the header stays visible.
    expect(computeFirstSectionScrollTarget({ ...base, sectionHeight: 900 })).toBe(644);
  });

  it('never returns a negative offset when the section already fits below the fold', () => {
    expect(computeFirstSectionScrollTarget({ ...base, firstScreenHeight: 100, sectionHeight: 40, viewport: 800 })).toBe(
      0,
    );
  });
});

describe('CAROUSEL_LAYER_Z', () => {
  // These are hit-test ranks, not decoration. The pan-while-zoomed overlay is a
  // SIBLING of the board, so burying it under the board means a drag that starts on
  // the board never reaches the pan — that's #4191, where zooming a climb in the
  // player left you unable to move around it (the create board, which has no zIndex
  // at all, kept working). Raising the board for the card-stack paint order is what
  // buried it, so keep the whole order asserted here. The boards themselves share one
  // level: see swipe-board-carousel-layout.test.tsx for why it must not vary.
  it('puts the zoom-pan overlay above the board so a drag on the board can pan it', () => {
    expect(CAROUSEL_LAYER_Z.zoomPan).toBeGreaterThan(CAROUSEL_LAYER_Z.board);
  });

  it('keeps the reset-zoom button tappable above the pan overlay', () => {
    expect(CAROUSEL_LAYER_Z.resetZoom).toBeGreaterThan(CAROUSEL_LAYER_Z.zoomPan);
  });
});

// The open target is applied by an effect, which runs after the first commit —
// so without this seed a pane that already has its climb paints one frame of the
// "Pick a climb / Tap a climb to see it here" placeholder first. True on the
// iPad, where the pane really is waiting on a list selection; a lie on the
// anonymous climb view, where there is no list to tap and the visitor followed a
// link to one specific climb.
describe('initialDrawerPreviewItem', () => {
  const previewQueueItem = { uuid: 'queue-item', climb: { uuid: 'climb-1' } } as never;

  it('seeds a preview open so the pane placeholder never paints', () => {
    expect(initialDrawerPreviewItem({ options: { previewQueueItem } })).toBe(previewQueueItem);
  });

  // A commit open carries queue side effects (`setCurrentClimb`) that belong in
  // the effect, not in a state initialiser — so it seeds nothing.
  it('seeds nothing for a commit open, or no target at all', () => {
    expect(initialDrawerPreviewItem({ options: { previewQueueItem: null } })).toBeNull();
    expect(initialDrawerPreviewItem({ options: {} })).toBeNull();
    expect(initialDrawerPreviewItem({})).toBeNull();
    expect(initialDrawerPreviewItem(null)).toBeNull();
    expect(initialDrawerPreviewItem(undefined)).toBeNull();
  });
});

describe('computeDrawerFirstScreenHeight', () => {
  it.each([
    { viewport: 844, bottomInset: 34 },
    { viewport: 568, bottomInset: 0 },
    { viewport: 320, bottomInset: 24 },
  ])('fits board-only content exactly in $viewport points including safe area', ({ viewport, bottomInset }) => {
    const height = computeDrawerFirstScreenHeight({
      viewport,
      bottomInset,
      firstSectionHeaderHeight: null,
      sectionTopPadding: 12,
      sectionMargin: 8,
    });
    expect(height + bottomInset).toBe(viewport);
  });
  it('reserves the measured first enabled header instead of a hidden Logbook', () => {
    expect(
      computeDrawerFirstScreenHeight({
        viewport: 844,
        bottomInset: 34,
        firstSectionHeaderHeight: 70,
        sectionTopPadding: 12,
        sectionMargin: 8,
      }),
    ).toBe(754);
  });
});
