/**
 * Where the spray editor's chrome goes on the iPad layout, as pure functions.
 *
 * The photo has the whole screen there and the chrome floats over it on glass:
 * a tool rail down one side, and everything else kept clear of it on the other.
 * The climber picks the rail's side by dragging it across, so a left-handed
 * Pencil hand does not rest on the buttons. The app ships left-to-right
 * locales only, so "leading" is the left edge.
 *
 * Kept out of the components so the placement table and the drag's snap rule
 * are tests rather than hopes; `SprayToolRail` runs the same snap rule as a
 * worklet (it inlines `railSideAfterDrag`'s arithmetic, since a worklet cannot
 * reliably call across modules).
 */

export type SprayRailSide = 'leading' | 'trailing';

export const DEFAULT_SPRAY_RAIL_SIDE: SprayRailSide = 'leading';

/** One rail button's square, the bottom bar's 48 pt touch target. */
export const SPRAY_RAIL_BUTTON_SIZE = 48;
/** Glass around the buttons. */
export const SPRAY_RAIL_PADDING = 4;
export const SPRAY_RAIL_WIDTH = SPRAY_RAIL_BUTTON_SIZE + SPRAY_RAIL_PADDING * 2;
/** Gap between the rail and the screen edge (outside the safe area). */
export const SPRAY_RAIL_MARGIN = 16;
/** The inspector card's width. */
export const SPRAY_INSPECTOR_WIDTH = 300;
/** The widest the portrait primary cluster, the banner and the hints are drawn. */
export const SPRAY_TABLET_CONTENT_MAX_WIDTH = 520;
/** The landscape primary cluster's width, docked to the side. */
export const SPRAY_CLUSTER_SIDE_WIDTH = 420;

/** A stored value read back as a side, or the default for anything else. */
export function parseSprayRailSide(stored: unknown): SprayRailSide {
  return stored === 'leading' || stored === 'trailing' ? stored : DEFAULT_SPRAY_RAIL_SIDE;
}

type Edges = {
  windowWidth: number;
  leftInset: number;
  rightInset: number;
};

/** The rail's left edge, in window points, docked to `side`. */
export function railDockX({ side, windowWidth, leftInset, rightInset }: Edges & { side: SprayRailSide }): number {
  if (side === 'leading') return leftInset + SPRAY_RAIL_MARGIN;
  return windowWidth - rightInset - SPRAY_RAIL_MARGIN - SPRAY_RAIL_WIDTH;
}

/**
 * The side a dragged rail settles on: whichever half of the window its centre
 * was let go in. Dragging it part-way and letting go springs it home.
 */
export function railSideAfterDrag({
  side,
  translationX,
  windowWidth,
  leftInset,
  rightInset,
}: Edges & { side: SprayRailSide; translationX: number }): SprayRailSide {
  const centre = railDockX({ side, windowWidth, leftInset, rightInset }) + translationX + SPRAY_RAIL_WIDTH / 2;
  return centre < windowWidth / 2 ? 'leading' : 'trailing';
}

export type SprayTabletPlacement = {
  /** The screen edge the rail is docked to. */
  railEdge: 'left' | 'right';
  /** The other edge: the inspector, the reset-zoom control and the landscape cluster go here. */
  oppositeEdge: 'left' | 'right';
  /** Landscape: under the header. Portrait: just above the primary cluster. */
  inspector: 'top' | 'bottom';
  /** Landscape: docked to the opposite edge. Portrait: centred along the bottom. */
  cluster: 'side' | 'centre';
};

/**
 * The tablet chrome's arrangement. Everything that is not the rail stays on the
 * side away from it, so the hand on the rail and the hand on the wall never
 * reach across each other.
 *
 * Portrait has the height for the inspector to sit low, near the hand, above
 * the cluster. Landscape is short, so the inspector goes up top and the cluster
 * takes the bottom corner.
 */
export function sprayTabletPlacement({
  railSide,
  landscape,
}: {
  railSide: SprayRailSide;
  landscape: boolean;
}): SprayTabletPlacement {
  const railEdge = railSide === 'leading' ? 'left' : 'right';
  return {
    railEdge,
    oppositeEdge: railEdge === 'left' ? 'right' : 'left',
    inspector: landscape ? 'top' : 'bottom',
    cluster: landscape ? 'side' : 'centre',
  };
}
