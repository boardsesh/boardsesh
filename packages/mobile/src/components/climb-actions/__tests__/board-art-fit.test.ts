import { describe, it, expect } from 'vitest';
import {
  fitBoardArt,
  fitBoardMaxSize,
  computeReactionBoardMaxSize,
  fitReactionListViewport,
  reactionListWindowHeight,
} from '../board-art-fit';

describe('fitBoardArt', () => {
  it('portrait: height is the max edge, width scales down by aspect', () => {
    // 1:2 board, maxSize 200 → height 200, width 100.
    expect(fitBoardArt(100, 200, 200)).toEqual({ width: 100, height: 200 });
  });

  it('landscape: width is the max edge, height scales down by aspect', () => {
    // 2:1 board, maxSize 200 → width 200, height 100.
    expect(fitBoardArt(200, 100, 200)).toEqual({ width: 200, height: 100 });
  });

  it('square: both edges equal maxSize', () => {
    expect(fitBoardArt(120, 120, 150)).toEqual({ width: 150, height: 150 });
  });

  it('degenerate dims fall back to a square', () => {
    expect(fitBoardArt(100, 0, 180)).toEqual({ width: 180, height: 180 });
    expect(fitBoardArt(-10, 100, 180)).toEqual({ width: 180, height: 180 });
    expect(fitBoardArt(Number.NaN, 100, 180)).toEqual({ width: 180, height: 180 });
  });
});

describe('fitBoardMaxSize', () => {
  it('portrait bounded by height when the box is tall enough for the derived width', () => {
    // aspect 0.5, box 400×300 → height-bound 300, width would be 150 ≤ 400.
    expect(fitBoardMaxSize(0.5, 400, 300)).toBe(300);
    // feeding it back yields a box-fitting size.
    expect(fitBoardArt(1, 2, 300)).toEqual({ width: 150, height: 300 });
  });

  it('portrait bounded by width when the box is too narrow for full height', () => {
    // aspect 0.5, box 100×300 → width caps it: maxSize = 100 / 0.5 = 200 (< 300).
    expect(fitBoardMaxSize(0.5, 100, 300)).toBe(200);
    expect(fitBoardArt(1, 2, 200)).toEqual({ width: 100, height: 200 });
  });

  it('landscape bounded by width when the box is short enough', () => {
    // aspect 2, box 300×400 → width-bound 300, derived height 150 ≤ 400.
    expect(fitBoardMaxSize(2, 300, 400)).toBe(300);
  });

  it('landscape bounded by height when the box is too short for full width', () => {
    // aspect 2, box 300×100 → height caps it: maxSize = 100 * 2 = 200 (< 300).
    expect(fitBoardMaxSize(2, 300, 100)).toBe(200);
    expect(fitBoardArt(2, 1, 200)).toEqual({ width: 200, height: 100 });
  });

  it('square fills the smaller box dimension', () => {
    expect(fitBoardMaxSize(1, 320, 460)).toBe(320);
    expect(fitBoardMaxSize(1, 460, 320)).toBe(320);
  });

  it('degenerate aspect falls back to the smaller box edge', () => {
    expect(fitBoardMaxSize(Number.POSITIVE_INFINITY, 320, 460)).toBe(320);
    expect(fitBoardMaxSize(0, 320, 460)).toBe(320);
    expect(fitBoardMaxSize(-1, 460, 320)).toBe(320);
    expect(fitBoardMaxSize(Number.NaN, 200, 500)).toBe(200);
  });
});

describe('reactionListWindowHeight', () => {
  it('reserves the whole list, padding on both edges, up to four rows', () => {
    expect(reactionListWindowHeight(0, 46, 4)).toBe(8);
    expect(reactionListWindowHeight(4, 46, 4)).toBe(4 * 46 + 8);
  });

  it('caps a longer list at four rows and half of the fifth', () => {
    expect(reactionListWindowHeight(5, 46, 4)).toBe(4 + 4.5 * 46);
    expect(reactionListWindowHeight(11, 46, 4)).toBe(4 + 4.5 * 46);
  });

  it('takes a smaller row cap for the minimum window', () => {
    expect(reactionListWindowHeight(2, 46, 4, 2)).toBe(2 * 46 + 8);
    expect(reactionListWindowHeight(3, 46, 4, 2)).toBe(4 + 2.5 * 46);
  });
});

describe('fitReactionListViewport', () => {
  it('shows a list that fits whole, without scrolling', () => {
    expect(fitReactionListViewport(4, 46, 4, 200)).toEqual({ maxHeight: 200, scrollable: false });
  });

  it('shows a list whole when only its bottom padding is short of room', () => {
    expect(fitReactionListViewport(7, 46, 4, 7 * 46 + 4)).toEqual({ maxHeight: 7 * 46 + 8, scrollable: false });
  });

  it('lands an exact four-and-a-half-row budget on four rows and a peek, through float error', () => {
    const viewport = fitReactionListViewport(7, 46, 4, 4 + 4.5 * 46 - 1e-9);
    expect(viewport.scrollable).toBe(true);
    expect(viewport.maxHeight).toBeCloseTo(4 + 4.5 * 46);
  });

  it('shows more rows, still cut mid-row, when the board left extra room', () => {
    // 6.2 rows of room: five full rows and the peek, never a flush edge.
    expect(fitReactionListViewport(10, 46, 4, 4 + 6.2 * 46)).toEqual({ maxHeight: 4 + 5.5 * 46, scrollable: true });
  });

  it('scrolls a short list too when large text leaves no room for it', () => {
    // Four rows at 60pt need 248; 200 holds two full rows and the peek.
    expect(fitReactionListViewport(4, 60, 4, 200)).toEqual({ maxHeight: 4 + 2.5 * 60, scrollable: true });
  });

  it('falls back to the room it has when not even one row and a peek fit', () => {
    expect(fitReactionListViewport(10, 46, 4, 50)).toEqual({ maxHeight: 50, scrollable: true });
    expect(fitReactionListViewport(10, 46, 4, 20)).toEqual({ maxHeight: 46, scrollable: true });
  });
});

describe('computeReactionBoardMaxSize', () => {
  // Approximate the reaction menu's reserves at fontScale 1: a 3-button row (~110),
  // a 56pt title reserve, and 48pt list rows (12pt padding around the 24pt icon) with
  // 4pt of padding at each end. Screen-size + item count vary per case.
  const ROW = 48;
  const LIST_PADDING = 4;
  const PRIMARY_ROW = 110;
  const TEXT_RESERVE = 56;
  const SECTION_GAP = 20;
  type Insets = { insetTop?: number; insetBottom?: number; aspect?: number };
  function boardFor(
    windowWidth: number,
    windowHeight: number,
    items: number,
    { insetTop = 0, insetBottom = 0, aspect = 1 }: Insets = {},
  ): number {
    return computeReactionBoardMaxSize({
      windowWidth,
      windowHeight,
      insetTop,
      insetBottom,
      contentTopOffset: Math.round(windowHeight * 0.02),
      sectionGap: SECTION_GAP,
      sideMargin: 24,
      previewMaxWidth: 400,
      aspect,
      primaryRowHeight: PRIMARY_ROW,
      textReserve: TEXT_RESERVE,
      listRowCount: items,
      rowHeight: ROW,
      listPadding: LIST_PADDING,
    });
  }
  // The height the component hands the list once a portrait board of this height is
  // placed: the same stack the sizing reserves, minus the board.
  function listRoomFor(windowHeight: number, boardHeight: number, { insetTop = 0, insetBottom = 0 }: Insets = {}) {
    const chrome =
      insetTop + Math.round(windowHeight * 0.02) + SECTION_GAP + PRIMARY_ROW + insetBottom + SECTION_GAP + TEXT_RESERVE;
    return windowHeight - chrome - boardHeight;
  }

  it('renders the climb smaller as the screen gets smaller (same list)', () => {
    const proMax = boardFor(440, 956, 4, { insetTop: 59, insetBottom: 34 });
    const pro = boardFor(393, 852, 4, { insetTop: 59, insetBottom: 34 });
    const se = boardFor(375, 667, 4, { insetTop: 20 });
    const smallest = boardFor(320, 568, 4, { insetTop: 20 });
    expect(proMax).toBeGreaterThan(pro);
    expect(pro).toBeGreaterThan(se);
    expect(se).toBeGreaterThan(smallest);
  });

  it('stays within the width cap and the window-height fraction', () => {
    const board = boardFor(393, 852, 6, { insetTop: 59, insetBottom: 34 });
    expect(board).toBeLessThanOrEqual(852 * 0.55);
    expect(board).toBeLessThanOrEqual(393 - 24 * 2); // square board bounded by width
  });

  it('holds a one-row menu to the window-height fraction', () => {
    expect(boardFor(440, 956, 1, { insetTop: 62, insetBottom: 34, aspect: 0.6 })).toBeCloseTo(956 * 0.55);
  });

  // The menu is a peek at the climb: actions past the fourth scroll instead of
  // shrinking the board, so every climb on a screen gets the same size board.
  it('keeps the board the same size however many actions sit past the fourth', () => {
    const insets = { insetTop: 59, insetBottom: 34, aspect: 0.718 };
    const five = boardFor(430, 932, 5, insets);
    expect(boardFor(430, 932, 7, insets)).toBe(five);
    expect(boardFor(430, 932, 11, insets)).toBe(five);
  });

  it('gives a list of four or fewer rows its whole height', () => {
    const insets = { insetTop: 59, insetBottom: 34, aspect: 0.6 };
    const three = boardFor(393, 852, 3, insets);
    const four = boardFor(393, 852, 4, insets);
    const five = boardFor(393, 852, 5, insets);
    expect(three - four).toBeCloseTo(ROW);
    expect(four).toBeGreaterThan(five);
  });

  it('makes the Kilter board the hero on a 932pt phone with seven actions', () => {
    // Reserving the whole seven-row list left it ~270pt tall.
    const board = boardFor(430, 932, 7, { insetTop: 59, insetBottom: 34, aspect: 0.718 });
    expect(board).toBeGreaterThanOrEqual(390);
  });

  it('leaves the list exactly four rows and a peek when the board takes its budget', () => {
    const insets = { insetTop: 59, insetBottom: 34, aspect: 0.718 };
    const board = boardFor(430, 932, 7, insets);
    const viewport = fitReactionListViewport(7, ROW, LIST_PADDING, listRoomFor(932, board, insets));
    expect(viewport.scrollable).toBe(true);
    expect(viewport.maxHeight).toBeCloseTo(LIST_PADDING + 4.5 * ROW);
  });

  it('floors the board on a very small screen and still leaves more than two rows', () => {
    const insets = { insetTop: 20 };
    const board = boardFor(320, 568, 11, insets);
    expect(board).toBe(140);
    const viewport = fitReactionListViewport(11, ROW, LIST_PADDING, listRoomFor(568, board, insets));
    expect(viewport.maxHeight).toBeGreaterThanOrEqual(LIST_PADDING + 2.5 * ROW);
  });

  it('yields below the floor on a cramped landscape viewport so two rows and a peek stay on screen', () => {
    const insets = { insetBottom: 21 };
    const board = boardFor(852, 375, 10, insets);
    expect(board).toBeGreaterThanOrEqual(0);
    expect(board).toBeLessThan(140);
    const viewport = fitReactionListViewport(10, ROW, LIST_PADDING, listRoomFor(375, board, insets));
    expect(viewport.maxHeight).toBeCloseTo(LIST_PADDING + 2.5 * ROW);
  });

  it('lets a portrait board grow taller than a square one on the same screen', () => {
    const square = boardFor(393, 852, 4, { insetTop: 59, insetBottom: 34, aspect: 1 });
    const portrait = boardFor(393, 852, 4, { insetTop: 59, insetBottom: 34, aspect: 0.6 });
    expect(portrait).toBeGreaterThanOrEqual(square);
  });
});
