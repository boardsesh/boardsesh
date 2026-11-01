// Pure aspect-ratio math for the reaction-menu board preview. Extracted from
// ClimbReactionMenu so it unit-tests without pulling in React Native / Reanimated.

export type FittedSize = { width: number; height: number };

// Fit a board of the given native dimensions into a square of side `maxSize`,
// preserving aspect. `maxSize` is the larger rendered edge (width for landscape,
// height for portrait). Degenerate dims fall back to a square.
export function fitBoardArt(boardWidth: number, boardHeight: number, maxSize: number): FittedSize {
  const aspect = boardWidth / boardHeight;
  if (!Number.isFinite(aspect) || aspect <= 0) return { width: maxSize, height: maxSize };
  return aspect >= 1 ? { width: maxSize, height: maxSize / aspect } : { width: maxSize * aspect, height: maxSize };
}

// The `maxSize` to feed `fitBoardArt` so the render fills a (maxWidth × maxHeight)
// box rather than a square — lets a portrait board grow tall instead of being pinned
// by screen width. Landscape is bounded by width (and the derived height), portrait by
// height (and the derived width).
export function fitBoardMaxSize(aspect: number, maxWidth: number, maxHeight: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return Math.min(maxWidth, maxHeight);
  return aspect >= 1 ? Math.min(maxWidth, maxHeight * aspect) : Math.min(maxHeight, maxWidth / aspect);
}

// The menu is a quick peek at the climb, so the board is sized against a window of
// this many action rows rather than the whole list; the rest scroll.
export const REACTION_LIST_VISIBLE_ROWS = 4;
// The fewest full rows a short screen keeps above the fold before the board yields.
export const REACTION_LIST_MIN_ROWS = 2;
// The slice of the next row left showing whenever the list scrolls. A list that ends
// flush on a row boundary reads as finished; a row cut through the middle reads as
// "more below", and the bottom fade sits over it.
export const REACTION_LIST_PEEK_ROWS = 0.5;

// Height of the action list's window: the whole list when it has `maxRows` rows or
// fewer, else `maxRows` full rows plus the peeking slice. `padding` is the list's
// vertical padding on ONE edge; a window that cuts a row only shows the top one.
export function reactionListWindowHeight(
  rowCount: number,
  rowHeight: number,
  padding: number,
  maxRows: number = REACTION_LIST_VISIBLE_ROWS,
): number {
  if (rowCount <= maxRows) return rowCount * rowHeight + padding * 2;
  return padding + (maxRows + REACTION_LIST_PEEK_ROWS) * rowHeight;
}

export type ReactionListViewport = { maxHeight: number; scrollable: boolean };

// Fit the action list into the height left under the board. The whole list when its
// rows fit (its bottom padding may spill into the gap below the card rather than cost a
// row); otherwise the most full rows that fit plus the peeking slice, so the cut lands
// mid-row. A board that stops short of its height budget (a wide board pinned by the
// screen width, an iPad) leaves more room, and that room shows more rows rather than
// blank space under a list that is still hiding some. Past the point where not even one
// row and a peek fit, the list takes what room there is. The half-point tolerance
// absorbs float error: an exact 4.5-row budget must not floor to 3.5.
export function fitReactionListViewport(
  rowCount: number,
  rowHeight: number,
  padding: number,
  available: number,
): ReactionListViewport {
  const contentHeight = rowCount * rowHeight + padding * 2;
  if (contentHeight - padding <= available + 0.5) {
    return { maxHeight: Math.max(available, contentHeight), scrollable: false };
  }
  const fullRows = Math.floor((available - padding + 0.5) / rowHeight - REACTION_LIST_PEEK_ROWS);
  if (fullRows < 1) return { maxHeight: Math.max(rowHeight, available), scrollable: true };
  return { maxHeight: padding + (fullRows + REACTION_LIST_PEEK_ROWS) * rowHeight, scrollable: true };
}

export type ReactionBoardLayoutInput = {
  windowWidth: number;
  windowHeight: number;
  /** Safe-area insets. */
  insetTop: number;
  insetBottom: number;
  /** Breathing room below the top safe area before the title. */
  contentTopOffset: number;
  /** Gap token stacked between the title, board and card (spacing[5]). */
  sectionGap: number;
  /** Horizontal content padding on ONE side (spacing[6]). */
  sideMargin: number;
  /** Ceiling on the preview/card width (PREVIEW_MAX_WIDTH). */
  previewMaxWidth: number;
  /** Board aspect ratio, width / height. */
  aspect: number;
  /** Reserved heights of the fixed sections the board shares the screen with. */
  primaryRowHeight: number;
  textReserve: number;
  /** Number of rows in the action list, and one row's height. */
  listRowCount: number;
  rowHeight: number;
  /** The action list's vertical padding on ONE edge. */
  listPadding: number;
  /** Smallest board the layout aims for before it lets the list scroll instead. */
  boardFloor?: number;
  /** Hard ceiling on the board as a fraction of the window height. */
  heightFraction?: number;
};

// Size the reaction-menu board the way the play drawer sizes its board: contain-fit the
// climb into the space that's left once the title, the quick-action button row and the
// action list's window (four rows and a peek, see reactionListWindowHeight) are
// reserved. Reserving the window rather than the whole list is what makes the climb the
// hero: every extra action scrolls instead of shrinking the board. Bounded three ways —
// the preview width, a window-height fraction, and a ceiling that keeps the button row +
// two and a half list rows on screen wherever the screen has room for them — and
// floored so the board stays visible until a very small screen genuinely has no room
// (past that the list shows fewer rows). Pure so it's unit-tested across the install base's screen sizes,
// mirroring `play-drawer-layout.ts`.
export function computeReactionBoardMaxSize(input: ReactionBoardLayoutInput): number {
  const {
    windowWidth,
    windowHeight,
    insetTop,
    insetBottom,
    contentTopOffset,
    sectionGap,
    sideMargin,
    previewMaxWidth,
    aspect,
    primaryRowHeight,
    textReserve,
    listRowCount,
    rowHeight,
    listPadding,
    boardFloor = 140,
    heightFraction = 0.55,
  } = input;
  const topReserve = insetTop + contentTopOffset;
  const bottomReserve = insetBottom + sectionGap;
  // Everything stacked around the board except the list: two section gaps — the
  // board→card gap (explicit) and the bottom padding gap (inside bottomReserve). The
  // smaller title→board gap is deliberately NOT counted here: textReserve reserves more
  // than the title actually needs, and that slack absorbs it.
  const fixedChrome = topReserve + sectionGap + primaryRowHeight + bottomReserve + textReserve;
  // Space the board fills once the list's window is reserved.
  const heroHeightBudget = windowHeight - fixedChrome - reactionListWindowHeight(listRowCount, rowHeight, listPadding);
  // The most the board may take while still leaving the button row + the minimum list
  // window on screen. Only binds when the floor below would otherwise push the list
  // under that minimum on a short screen.
  const boardCeiling = Math.max(
    0,
    windowHeight - fixedChrome - reactionListWindowHeight(listRowCount, rowHeight, listPadding, REACTION_LIST_MIN_ROWS),
  );
  const minSize = Math.min(boardFloor, boardCeiling);
  const maxWidth = Math.min(previewMaxWidth, windowWidth - sideMargin * 2);
  const maxHeight = Math.min(windowHeight * heightFraction, boardCeiling, Math.max(minSize, heroHeightBudget));
  return fitBoardMaxSize(aspect, maxWidth, maxHeight);
}
