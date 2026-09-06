import {
  PLACEMENT_GRID_MM,
  clampCentreToPanel,
  findCollisions,
  normaliseRotationDeg,
  resizeKeepingAspect,
  rotateFromPointer,
  snapToGrid,
  type ArtRectMm,
  type HoleMm,
  type PanelRectMm,
  type PlacementCollisions,
  type PointMm,
  type ResizeHandle,
  type SeamLineMm,
} from './geometry';

/**
 * One label's placement while somebody is dragging it.
 *
 * A reducer rather than a pile of `useState` because a drag is a state machine
 * with a memory: where the pointer went down, what the placement was at that
 * moment, and which of three gestures is running. Deriving the new placement
 * from the START of the gesture instead of from the previous frame is what
 * stops a drag from drifting — every frame is an absolute answer to "where has
 * the pointer moved to since it went down", so a skipped or coalesced move
 * event costs nothing.
 *
 * Snapping and the local collision check live here, not in the component, for
 * the same reason the geometry lives in its own module: they decide what gets
 * sold, so they are testable without a DOM.
 */

/** The placement fields, exactly as the artwork draft and the mutation carry them. */
export type PlacementValue = {
  panelIndex: number;
  xMm: number;
  yMm: number;
  widthMm: number;
  rotationDeg: number;
};

/** What the reducer needs to know about the wall to snap and check against it. */
export type PlacementContext = {
  panels: readonly PanelRectMm[];
  /** Only the holes on the selected panel; the rest cannot be reached anyway. */
  holes: readonly HoleMm[];
  seams: readonly SeamLineMm[];
  panelEdgeMarginMm: number;
  /** The cut-through multiplier, or 1 for a mode that only marks the surface. */
  keepoutScale: number;
  /** Drawn width over drawn height, measured from the label itself. */
  aspect: number;
  minWidthMm: number;
  maxWidthMm: number;
};

export type PlacementDrag = {
  kind: 'move' | 'resize' | 'rotate';
  pointerId: number;
  handle?: ResizeHandle;
  startPointerMm: PointMm;
  startPlacement: PlacementValue;
};

export type PlacementState = {
  placement: PlacementValue;
  drag: PlacementDrag | null;
  collisions: PlacementCollisions;
  context: PlacementContext;
};

export type PlacementAction =
  | {
      type: 'pointerDown';
      kind: 'move' | 'resize' | 'rotate';
      pointerId: number;
      handle?: ResizeHandle;
      pointerMm: PointMm;
    }
  | { type: 'pointerMove'; pointerId: number; pointerMm: PointMm; snap: boolean }
  | { type: 'pointerUp'; pointerId: number }
  | { type: 'setPanel'; panelIndex: number }
  | { type: 'nudge'; dxMm: number; dyMm: number }
  | { type: 'setWidth'; widthMm: number }
  | { type: 'setRotation'; rotationDeg: number }
  | { type: 'reset'; placement: PlacementValue; context: PlacementContext };

function findPanel(context: PlacementContext, panelIndex: number): PanelRectMm | null {
  return context.panels.find((panel) => panel.index === panelIndex) ?? null;
}

/** The placement as the rectangle the geometry works on: height comes from the aspect. */
export function placementRect(placement: PlacementValue, aspect: number): ArtRectMm {
  return {
    xMm: placement.xMm,
    yMm: placement.yMm,
    widthMm: placement.widthMm,
    heightMm: aspect > 0 ? placement.widthMm / aspect : placement.widthMm,
    rotationDeg: placement.rotationDeg,
  };
}

/** What is in the way of a placement right now. Exported so the editor can label it. */
export function collisionsFor(placement: PlacementValue, context: PlacementContext): PlacementCollisions {
  return findCollisions(
    placementRect(placement, context.aspect),
    findPanel(context, placement.panelIndex),
    context.holes,
    context.seams,
    { panelEdgeMarginMm: context.panelEdgeMarginMm, keepoutScale: context.keepoutScale },
  );
}

/**
 * Settle a placement: bounds, then the grid, then back inside the panel.
 *
 * Order matters. Snapping after clamping can push a corner back out over the
 * panel edge by up to half a grid step, so the clamp goes last and is the one
 * guarantee that holds.
 *
 * Only a POINTER gesture snaps. A 1 mm nudge from shift-arrow and a width typed
 * into the field beside the canvas are somebody asking for that exact number,
 * and rounding them to the 10 mm grid would quietly throw the request away —
 * which is the whole point of having a keyboard and a number field at all.
 */
function settle(placement: PlacementValue, context: PlacementContext, snap: boolean): PlacementValue {
  const widthMm = snap ? snapToGrid(placement.widthMm, PLACEMENT_GRID_MM) : placement.widthMm;
  const bounded: PlacementValue = {
    ...placement,
    widthMm: Math.min(Math.max(widthMm, context.minWidthMm), context.maxWidthMm),
    rotationDeg: normaliseRotationDeg(placement.rotationDeg),
    xMm: snap ? snapToGrid(placement.xMm) : placement.xMm,
    yMm: snap ? snapToGrid(placement.yMm) : placement.yMm,
  };
  const panel = findPanel(context, bounded.panelIndex);
  if (!panel) return bounded;
  const centre = clampCentreToPanel(placementRect(bounded, context.aspect), panel, context.panelEdgeMarginMm);
  return { ...bounded, xMm: centre.xMm, yMm: centre.yMm };
}

/** A settled placement plus the collision list that goes with it. */
function commit(state: PlacementState, placement: PlacementValue, snap: boolean): PlacementState {
  const settled = settle(placement, state.context, snap);
  return { ...state, placement: settled, collisions: collisionsFor(settled, state.context) };
}

/** The state a fresh editor starts in. Snapped, because a stored placement is a dragged one. */
export function initialPlacementState(placement: PlacementValue, context: PlacementContext): PlacementState {
  const settled = settle(placement, context, true);
  return { placement: settled, drag: null, collisions: collisionsFor(settled, context), context };
}

export function placementReducer(state: PlacementState, action: PlacementAction): PlacementState {
  switch (action.type) {
    case 'pointerDown':
      return {
        ...state,
        drag: {
          kind: action.kind,
          pointerId: action.pointerId,
          handle: action.handle,
          startPointerMm: action.pointerMm,
          startPlacement: state.placement,
        },
      };

    case 'pointerMove': {
      const { drag, context } = state;
      // A second finger, or a move that arrived after the gesture ended, must
      // not steer the placement the first one is still holding.
      if (!drag || drag.pointerId !== action.pointerId) return state;

      if (drag.kind === 'move') {
        return commit(
          state,
          {
            ...drag.startPlacement,
            xMm: drag.startPlacement.xMm + (action.pointerMm.xMm - drag.startPointerMm.xMm),
            yMm: drag.startPlacement.yMm + (action.pointerMm.yMm - drag.startPointerMm.yMm),
          },
          true,
        );
      }

      if (drag.kind === 'rotate') {
        return commit(
          state,
          {
            ...drag.startPlacement,
            rotationDeg: rotateFromPointer(
              { xMm: drag.startPlacement.xMm, yMm: drag.startPlacement.yMm },
              action.pointerMm,
              action.snap,
            ),
          },
          true,
        );
      }

      if (!drag.handle) return state;
      const resized = resizeKeepingAspect(
        drag.handle,
        action.pointerMm,
        placementRect(drag.startPlacement, context.aspect),
        context.aspect,
        context.minWidthMm,
        context.maxWidthMm,
      );
      return commit(state, { ...drag.startPlacement, ...resized }, true);
    }

    case 'pointerUp':
      if (!state.drag || state.drag.pointerId !== action.pointerId) return state;
      return { ...state, drag: null };

    case 'setPanel': {
      const panel = findPanel(state.context, action.panelIndex);
      // Land in the middle of the new panel. Keeping the old wall coordinates
      // would drop the label somewhere off the panel it was just moved to, and
      // the clamp would then park it in a corner for no stated reason.
      const placement: PlacementValue = panel
        ? {
            ...state.placement,
            panelIndex: action.panelIndex,
            xMm: panel.xMm + panel.widthMm / 2,
            yMm: panel.yMm + panel.heightMm / 2,
          }
        : { ...state.placement, panelIndex: action.panelIndex };
      return commit(state, placement, true);
    }

    case 'nudge':
      return commit(
        state,
        {
          ...state.placement,
          xMm: state.placement.xMm + action.dxMm,
          yMm: state.placement.yMm + action.dyMm,
        },
        false,
      );

    case 'setWidth':
      if (!Number.isFinite(action.widthMm)) return state;
      return commit(state, { ...state.placement, widthMm: action.widthMm }, false);

    case 'setRotation':
      if (!Number.isFinite(action.rotationDeg)) return state;
      return commit(state, { ...state.placement, rotationDeg: action.rotationDeg }, false);

    case 'reset':
      return initialPlacementState(action.placement, action.context);

    default:
      return state;
  }
}
