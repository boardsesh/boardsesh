import { describe, it, expect } from 'vite-plus/test';
import type { HoleMm, PanelRectMm } from '../configurator/placement-editor/geometry';
import {
  initialPlacementState,
  placementReducer,
  type PlacementContext,
  type PlacementState,
  type PlacementValue,
} from '../configurator/placement-editor/placement-reducer';

/**
 * The drag state machine, exercised as sequences rather than single actions.
 *
 * A drag is only correct as a whole: down, several moves, up. Testing one
 * action at a time would miss the two things that actually go wrong — a gesture
 * that drifts because it measures from the last frame instead of the first, and
 * a second finger that steers somebody else's drag.
 */

const PANELS: PanelRectMm[] = [
  { index: 0, xMm: 0, yMm: 0, widthMm: 1000, heightMm: 500 },
  { index: 1, xMm: 1000, yMm: 0, widthMm: 1000, heightMm: 500 },
];

const HOLES: HoleMm[] = [{ id: 'tnut-0', xMm: 500, yMm: 250, keepoutRadiusMm: 20 }];

const CONTEXT: PlacementContext = {
  panels: PANELS,
  holes: HOLES,
  seams: [],
  panelEdgeMarginMm: 15,
  keepoutScale: 1,
  aspect: 2,
  minWidthMm: 40,
  maxWidthMm: 1200,
};

const START: PlacementValue = { panelIndex: 0, xMm: 200, yMm: 100, widthMm: 100, rotationDeg: 0 };

function start(placement: PlacementValue = START): PlacementState {
  return initialPlacementState(placement, CONTEXT);
}

describe('moving a label', () => {
  it('follows the pointer and lands on the 10 mm grid', () => {
    let state = start();
    state = placementReducer(state, {
      type: 'pointerDown',
      kind: 'move',
      pointerId: 1,
      pointerMm: { xMm: 200, yMm: 100 },
    });
    state = placementReducer(state, {
      type: 'pointerMove',
      pointerId: 1,
      pointerMm: { xMm: 237, yMm: 100 },
      snap: false,
    });
    expect(state.placement.xMm).toBe(240);

    // Measured from where the gesture STARTED, so a second move is absolute
    // rather than cumulative.
    state = placementReducer(state, {
      type: 'pointerMove',
      pointerId: 1,
      pointerMm: { xMm: 264, yMm: 134 },
      snap: false,
    });
    expect(state.placement).toMatchObject({ xMm: 260, yMm: 130 });
  });

  it('ignores a second pointer while one is already dragging', () => {
    let state = start();
    state = placementReducer(state, {
      type: 'pointerDown',
      kind: 'move',
      pointerId: 1,
      pointerMm: { xMm: 200, yMm: 100 },
    });
    state = placementReducer(state, {
      type: 'pointerMove',
      pointerId: 2,
      pointerMm: { xMm: 900, yMm: 400 },
      snap: false,
    });
    expect(state.placement).toMatchObject({ xMm: 200, yMm: 100 });
  });

  it('stops following once the pointer is up', () => {
    let state = start();
    state = placementReducer(state, {
      type: 'pointerDown',
      kind: 'move',
      pointerId: 1,
      pointerMm: { xMm: 200, yMm: 100 },
    });
    state = placementReducer(state, { type: 'pointerUp', pointerId: 1 });
    expect(state.drag).toBeNull();
    state = placementReducer(state, {
      type: 'pointerMove',
      pointerId: 1,
      pointerMm: { xMm: 400, yMm: 100 },
      snap: false,
    });
    expect(state.placement.xMm).toBe(200);
  });

  it('will not let a drag leave the panel', () => {
    let state = start();
    state = placementReducer(state, {
      type: 'pointerDown',
      kind: 'move',
      pointerId: 1,
      pointerMm: { xMm: 200, yMm: 100 },
    });
    state = placementReducer(state, {
      type: 'pointerMove',
      pointerId: 1,
      pointerMm: { xMm: -900, yMm: 100 },
      snap: false,
    });
    // 15 mm margin plus half of a 100 mm label.
    expect(state.placement.xMm).toBe(65);
    expect(state.collisions.offPanel).toBe(false);
  });
});

describe('resizing a label', () => {
  it('grows from the dragged corner with the aspect locked', () => {
    let state = start();
    state = placementReducer(state, {
      type: 'pointerDown',
      kind: 'resize',
      handle: 'bottomRight',
      pointerId: 1,
      pointerMm: { xMm: 250, yMm: 75 },
    });
    state = placementReducer(state, {
      type: 'pointerMove',
      pointerId: 1,
      pointerMm: { xMm: 300, yMm: 75 },
      snap: false,
    });
    expect(state.placement).toMatchObject({ widthMm: 150, xMm: 230, yMm: 90 });
  });
});

describe('rotating a label', () => {
  it('turns to wherever the handle was dragged', () => {
    let state = start();
    state = placementReducer(state, {
      type: 'pointerDown',
      kind: 'rotate',
      pointerId: 1,
      pointerMm: { xMm: 200, yMm: 180 },
    });
    state = placementReducer(state, {
      type: 'pointerMove',
      pointerId: 1,
      pointerMm: { xMm: 300, yMm: 100 },
      snap: false,
    });
    expect(state.placement.rotationDeg).toBe(-90);
  });

  it('snaps to 15 degrees while shift is held', () => {
    let state = start();
    state = placementReducer(state, {
      type: 'pointerDown',
      kind: 'rotate',
      pointerId: 1,
      pointerMm: { xMm: 200, yMm: 180 },
    });
    state = placementReducer(state, {
      type: 'pointerMove',
      pointerId: 1,
      pointerMm: { xMm: 210, yMm: 200 },
      snap: true,
    });
    expect(state.placement.rotationDeg % 15).toBe(0);
  });
});

describe('the fields and the keyboard', () => {
  it('nudges by the exact amount asked for, grid or no grid', () => {
    const state = placementReducer(start(), { type: 'nudge', dxMm: 1, dyMm: -1 });
    expect(state.placement).toMatchObject({ xMm: 201, yMm: 99 });
  });

  it('takes a typed width without rounding it to the grid', () => {
    expect(placementReducer(start(), { type: 'setWidth', widthMm: 45 }).placement.widthMm).toBe(45);
  });

  it('holds a typed width inside the catalogue bounds', () => {
    expect(placementReducer(start(), { type: 'setWidth', widthMm: 5 }).placement.widthMm).toBe(40);
    expect(placementReducer(start(), { type: 'setWidth', widthMm: 9000 }).placement.widthMm).toBe(1200);
  });

  it('refuses a field that is not a number at all', () => {
    expect(placementReducer(start(), { type: 'setRotation', rotationDeg: Number.NaN }).placement.rotationDeg).toBe(0);
  });

  it('folds a rotation back into the range the backend accepts', () => {
    expect(placementReducer(start(), { type: 'setRotation', rotationDeg: 270 }).placement.rotationDeg).toBe(-90);
  });

  it('drops the label in the middle of a panel it is moved to', () => {
    const state = placementReducer(start(), { type: 'setPanel', panelIndex: 1 });
    expect(state.placement).toMatchObject({ panelIndex: 1, xMm: 1500, yMm: 250 });
  });
});

describe('collisions', () => {
  it('names the hole a label has been dragged onto', () => {
    let state = start();
    state = placementReducer(state, {
      type: 'pointerDown',
      kind: 'move',
      pointerId: 1,
      pointerMm: { xMm: 200, yMm: 100 },
    });
    state = placementReducer(state, {
      type: 'pointerMove',
      pointerId: 1,
      pointerMm: { xMm: 500, yMm: 250 },
      snap: false,
    });
    expect(state.placement).toMatchObject({ xMm: 500, yMm: 250 });
    expect(state.collisions.holes).toEqual(['tnut-0']);
  });

  it('clears the collision once it is dragged off again', () => {
    let state = start({ ...START, xMm: 500, yMm: 250 });
    expect(state.collisions.holes).toEqual(['tnut-0']);
    state = placementReducer(state, { type: 'nudge', dxMm: -300, dyMm: 0 });
    expect(state.collisions.holes).toEqual([]);
  });

  it('re-checks against the new clearance when the context changes', () => {
    const state = start({ ...START, xMm: 545, yMm: 250, widthMm: 40 });
    expect(state.collisions.holes).toEqual([]);
    const stricter = placementReducer(state, {
      type: 'reset',
      placement: state.placement,
      context: { ...CONTEXT, keepoutScale: 1.5 },
    });
    expect(stricter.collisions.holes).toEqual(['tnut-0']);
  });
});
