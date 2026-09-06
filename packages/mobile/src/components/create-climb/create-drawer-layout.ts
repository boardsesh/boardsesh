// The create drawer's vertical budget, extracted so the arithmetic can be
// asserted rather than eyeballed on a device.
//
// It is worth pinning: the board is the surface, and every dp reserved here is
// a dp of climb the setter cannot see. Both constants below were wrong before
// #5189 — one under-counted what it reserved, the other over-counted by a sixth
// of the board on a small phone — and neither error was visible from the code.

/**
 * Space the header, action bar, draft-status line, sheet handle and safe areas
 * need, so the board is sized to leave them on screen at the peek.
 *
 * Derived from the peek formula rather than guessed: handle reserve (24) +
 * ScrollView top padding (8) + header row (68) + action bar (70 brush row + 56
 * action row + 32 status line = 158) + the peek's own 12dp reveal = 278. The
 * remaining 12 absorbs a taller locale or one Dynamic Type step.
 *
 * This was 324 — 46dp of unclaimed slack taken straight off the board on every
 * screen, in every state. Erring high is cheap but it is not free.
 */
export const ABOVE_FOLD_CHROME = 290;

/**
 * The route transport card, which carries the whole route control set: marginTop
 * 8 + paddingVertical 12 x 2 + the 44dp frame-strip row + an 8dp row gap + the
 * 44dp transport row.
 *
 * A contract with `PlaybackControls`' strip mode — if the rendered card and this
 * number disagree, the peek drifts against the real content height.
 *
 * The strip row is 44 rather than the 32 its chips occupy so the "+ Add frame"
 * button in it clears the touch floor: `Button` sizes itself from `minHeight`
 * and exposes no `hitSlop`, so unlike the frame chips it cannot borrow the extra
 * 12dp. Paying 12dp of board for the strip's primary action to be tappable is
 * the right trade on a screen this issue exists to fix the touch targets of.
 *
 * It still replaces more than it costs: an 84dp card plus a detached 52dp button
 * row (136 total). Delete moved into the header's overflow menu and add became a
 * chip pinned inside the strip, so one card now does the work of two rows.
 */
export const PLAYBACK_TRANSPORT_RESERVE = 128;

/**
 * Floor on the board's height. A board this small is already unusable, so
 * reaching it means the reserves above are lying about what fits — the sheet
 * then wants a taller peek than `MAX_PEEK_FRACTION` allows and clamps, dropping
 * real controls below the fold. Pinned by a test at the smallest phone we
 * support so it stays unreachable.
 */
export const MIN_BOARD_HEIGHT = 200;

export type BoardBudget = {
  windowHeight: number;
  /** Top safe-area inset. */
  insetTop: number;
  /** Bottom safe-area inset, as the sheet sees it. */
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
