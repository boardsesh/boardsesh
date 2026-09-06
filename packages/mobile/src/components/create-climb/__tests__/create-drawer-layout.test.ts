import { describe, it, expect } from 'vitest';
import {
  ABOVE_FOLD_CHROME,
  MIN_BOARD_HEIGHT,
  PLAYBACK_TRANSPORT_RESERVE,
  computeBoardMaxHeight,
} from '../create-drawer-layout';

// The board is the surface: every dp reserved by the drawer's chrome is a dp of
// climb the setter cannot see. Both constants were wrong before #5189 and the
// code gave no sign of it — the strip reserved 52dp while rendering 69, and the
// chrome constant over-reserved by 46. Neither is visible without doing the
// arithmetic, so the arithmetic is pinned here.

/** iPhone SE 3 — the smallest phone we support, and the one that binds. */
const SE = { windowHeight: 667, insetTop: 20, insetBottom: 0 };

/** The board budget as it stood before #4761 added a permanent route strip. */
const BOULDER_BUDGET_BEFORE_ROUTE_STRIP = 323;

describe('create drawer board budget', () => {
  it('gives a boulder more board than it had before the route strip landed', () => {
    // The issue's own acceptance gate. #4761 charged every boulder 52dp for a
    // strip advertising routes, taking the SE from 323 to 271 — a sixth of the
    // board, permanently, for a feature most setters never use.
    const boulder = computeBoardMaxHeight({ ...SE, showRouteTransport: false });

    expect(boulder).toBe(357);
    expect(boulder).toBeGreaterThanOrEqual(BOULDER_BUDGET_BEFORE_ROUTE_STRIP);
  });

  it('charges a route exactly one transport card and nothing else', () => {
    const boulder = computeBoardMaxHeight({ ...SE, showRouteTransport: false });
    const route = computeBoardMaxHeight({ ...SE, showRouteTransport: true });

    expect(boulder - route).toBe(PLAYBACK_TRANSPORT_RESERVE);
    // Pinned as a number too, not only as the difference: the difference is
    // computed FROM the reserve, so on its own it stays green no matter what the
    // reserve becomes. This is the assertion that notices the card changing
    // height. 667 - 20 - 290 - 116.
    expect(route).toBe(241);
  });

  it('keeps the smallest phone off the board-height floor in both states', () => {
    // Reaching the floor means the reserves are lying about what fits: the sheet
    // then wants a taller peek than MAX_PEEK_FRACTION allows and clamps, which
    // drops the draft-status line and part of the Save row below the fold. A
    // route on an SE did exactly that before this change (it computed 187).
    for (const showRouteTransport of [false, true]) {
      expect(computeBoardMaxHeight({ ...SE, showRouteTransport })).toBeGreaterThan(MIN_BOARD_HEIGHT);
    }
  });

  it('still floors the board on a window small enough to run out of room', () => {
    expect(computeBoardMaxHeight({ windowHeight: 300, insetTop: 44, insetBottom: 34, showRouteTransport: true })).toBe(
      MIN_BOARD_HEIGHT,
    );
  });

  it('subtracts both safe-area insets', () => {
    const withInsets = computeBoardMaxHeight({
      windowHeight: 874,
      insetTop: 59,
      insetBottom: 34,
      showRouteTransport: false,
    });
    expect(withInsets).toBe(874 - 59 - 34 - ABOVE_FOLD_CHROME);
  });
});
