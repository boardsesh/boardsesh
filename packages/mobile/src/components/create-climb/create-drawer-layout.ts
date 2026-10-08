// The New climb editor's vertical budget, extracted so the arithmetic can be
// asserted rather than eyeballed on a device.
//
// It is worth pinning: the board is the surface, and every dp reserved here is
// a dp of climb the setter cannot see. Both constants below were wrong before
// #5189 — one under-counted what it reserved, the other over-counted by a sixth
// of the board on a small phone — and neither error was visible from the code.

/**
 * Space the top bar, action bar, draft-status line and safe areas need, so the
 * board leaves the tools on screen without scrolling.
 *
 * Every term, with where it comes from, so the sum can be re-checked without a
 * device. It was derived for the old bottom-sheet drawer's peek; the editor is
 * a full-height modal now, and the sheet-only terms carry over as the iOS
 * pageSheet's own top gap and slack:
 *
 * - 24 — the gap an iOS pageSheet leaves above itself (was the drawer's grabber)
 * - 8  — slack (was the drawer scroll's paddingTop)
 * - 68 — the top bar (12 padding x 2 + a 44dp control, `minHeight: 56` floor)
 * - 8  — `boardSection`'s marginTop, above the board itself
 * - 158 — the action bar: 70 brush row + 56 action row + 32 status line
 * - 12 — a hint of the form below the tools (was the peek's reveal)
 * - 12 — deliberate slack, absorbing a taller locale or one Dynamic Type step
 *
 * = 290. Six measured terms and one buffer; the buffer is listed so the column
 * adds up to the constant rather than to 278 and reading as an error.
 *
 * This was 324 — 46dp of unclaimed slack taken straight off the board on every
 * screen, in every state. Erring high is cheap but it is not free.
 */
export const ABOVE_FOLD_CHROME = 290;

/**
 * The route transport card, which carries the whole route control set: marginTop
 * 8 + paddingVertical 12 x 2 + the 32dp frame-strip row + an 8dp row gap + the
 * 44dp transport row.
 *
 * A contract with `PlaybackControls`' strip mode — if the rendered card and this
 * number disagree, the board is sized against the wrong content height.
 *
 * The strip row is exactly one chip tall. It was 44 while a labelled "+ Add
 * frame" `Button` sat in it: `Button` sizes itself from `minHeight` and exposes
 * no `hitSlop`, so unlike the frame chips it could not borrow the missing 12dp.
 * Add and remove are now one icon capsule in the transport row's left slot — the
 * empty space beside prev/play/next — which meets the touch floor there and
 * hands the 12dp back to the board.
 *
 * It replaces far more than it costs: an 84dp card plus a detached 52dp button
 * row (136 total) before #5189, and 128 in that PR's first cut.
 */
export const PLAYBACK_TRANSPORT_RESERVE = 116;

/**
 * Floor on the board's height. A board this small is already unusable, so
 * reaching it means the reserves above are lying about what fits, and real
 * controls get pushed below the fold. Pinned by a test at the smallest phone we
 * support so it stays unreachable.
 */
export const MIN_BOARD_HEIGHT = 200;

export type BoardBudget = {
  windowHeight: number;
  /** Top safe-area inset. */
  insetTop: number;
  /** Bottom safe-area inset, as the modal sees it. */
  insetBottom: number;
  /** Whether the route transport is on screen — a boulder pays nothing for it. */
  showRouteTransport: boolean;
};

/** Height budget left for the board once the drawer's fixed chrome is reserved. */
export function computeBoardMaxHeight(budget: BoardBudget): number {
  const routeSlotReserve = budget.showRouteTransport ? PLAYBACK_TRANSPORT_RESERVE : 0;
  return Math.max(
    MIN_BOARD_HEIGHT,
    budget.windowHeight - budget.insetTop - budget.insetBottom - ABOVE_FOLD_CHROME - routeSlotReserve,
  );
}
