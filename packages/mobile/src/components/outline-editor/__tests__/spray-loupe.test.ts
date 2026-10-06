import { describe, expect, it } from 'vitest';
import {
  boardToScreen,
  LOUPE_DELAY_MS,
  LOUPE_MAX_MAGNIFICATION,
  LOUPE_OFFSET_PT,
  LOUPE_RETURN_MARGIN_PT,
  LOUPE_SIZE_PT,
  LOUPE_SLOP_PT,
  loupeGateOpen,
  loupeInnerTransform,
  loupeMagnification,
  loupePlacement,
  screenToBoard,
  type LoupeSide,
} from '../spray-gesture-math';

/** A 375 pt phone's editor area. */
const PHONE_WIDTH = 375;
const PHONE_HEIGHT = 600;
const TOP_SAFE = 8;
const HALF = LOUPE_SIZE_PT / 2;

function place(touchX: number, touchY: number, prevSide: LoupeSide = 'above') {
  return loupePlacement(touchX, touchY, PHONE_WIDTH, PHONE_HEIGHT, LOUPE_SIZE_PT, TOP_SAFE, prevSide);
}

/** Where a render point lands inside the loupe: RN scales about the view's centre, then translates. */
function landInLoupe(
  renderX: number,
  renderY: number,
  magnification: number,
  renderWidth: number,
  renderHeight: number,
): { x: number; y: number } {
  const transform = loupeInnerTransform(renderX, renderY, magnification, LOUPE_SIZE_PT, renderWidth, renderHeight);
  const centreX = renderWidth / 2;
  const centreY = renderHeight / 2;
  return {
    x: centreX + transform.translateX + (renderX - centreX) * magnification,
    y: centreY + transform.translateY + (renderY - centreY) * magnification,
  };
}

describe('loupePlacement', () => {
  it('sits straight above the touch when there is room', () => {
    expect(place(200, 300)).toEqual({ x: 200, y: 300 - LOUPE_OFFSET_PT, side: 'above' });
  });

  it('never covers the finger: its lower edge clears the touch', () => {
    const placement = place(200, 300);
    expect(placement.y + HALF).toBeLessThan(300);
  });

  it('is clamped inside the host near a side edge, still above', () => {
    expect(place(10, 300)).toEqual({ x: HALF, y: 300 - LOUPE_OFFSET_PT, side: 'above' });
    expect(place(PHONE_WIDTH - 5, 300)).toEqual({ x: PHONE_WIDTH - HALF, y: 300 - LOUPE_OFFSET_PT, side: 'above' });
  });

  it('moves to the left, level with the touch, when there is no room above', () => {
    const placement = place(250, 60);
    expect(placement.side).toBe('left');
    expect(placement.x).toBe(250 - LOUPE_OFFSET_PT);
    // Level with the touch, clamped to stay below the safe top.
    expect(placement.y).toBe(TOP_SAFE + HALF);
  });

  it('flips to the right when the left would leave the host', () => {
    const placement = place(60, 60);
    expect(placement.side).toBe('right');
    expect(placement.x).toBe(60 + LOUPE_OFFSET_PT);
  });

  it('keeps the right side while it fits, rather than jumping across the finger', () => {
    // Slid right from the left edge: the left now fits too, and the loupe stays put.
    const placement = place(200, 60, 'right');
    expect(placement.side).toBe('right');
    expect(placement.x).toBe(200 + LOUPE_OFFSET_PT);
  });

  it('leaves the right side once it no longer fits', () => {
    const placement = place(PHONE_WIDTH - 40, 60, 'right');
    expect(placement.side).toBe('left');
  });

  it('only comes back above with a margin to spare', () => {
    // Exactly enough room for a bare fit.
    const bareFitY = TOP_SAFE + HALF + LOUPE_OFFSET_PT;
    expect(place(200, bareFitY, 'above').side).toBe('above');
    expect(place(200, bareFitY, 'left').side).toBe('left');
    expect(place(200, bareFitY + LOUPE_RETURN_MARGIN_PT, 'left').side).toBe('above');
  });

  it('stays inside a host narrower than both sides', () => {
    const placement = loupePlacement(100, 20, 200, 300, LOUPE_SIZE_PT, 0, 'above');
    expect(placement.x - HALF).toBeGreaterThanOrEqual(0);
    expect(placement.x + HALF).toBeLessThanOrEqual(200);
    expect(placement.y - HALF).toBeGreaterThanOrEqual(0);
  });

  it('is clamped above the bottom edge on a side', () => {
    // A short landscape board: no room above, and a touch near the bottom.
    const placement = loupePlacement(250, 140, 375, 150, LOUPE_SIZE_PT, 0, 'above');
    expect(placement.side).toBe('left');
    expect(placement.y + HALF).toBeLessThanOrEqual(150);
  });
});

describe('loupeInnerTransform', () => {
  it.each([
    [0, 0, 2],
    [195, 260, 2],
    [390, 520, 12],
    [12.5, 401.25, 7.3],
  ])('puts render point (%d, %d) at the loupe centre at %dx', (renderX, renderY, magnification) => {
    const landed = landInLoupe(renderX, renderY, magnification, 390, 520);
    expect(landed.x).toBeCloseTo(HALF, 9);
    expect(landed.y).toBeCloseTo(HALF, 9);
  });

  it('shows a neighbour magnified: one render px off-centre lands m pt off-centre', () => {
    const transform = loupeInnerTransform(100, 100, 4, LOUPE_SIZE_PT, 390, 520);
    const centreX = 390 / 2;
    const neighbourX = centreX + transform.translateX + (101 - centreX) * 4;
    expect(neighbourX - HALF).toBeCloseTo(4, 9);
  });

  it('agrees with the board transform: the point under the finger is the one in the crosshair', () => {
    const scale = 3;
    const translateX = -120;
    const translateY = 45;
    const render = screenToBoard(150, 210, scale, translateX, translateY, 390, 520, 1);
    const back = boardToScreen(render.x, render.y, scale, translateX, translateY, 390, 520, 1);
    expect(back.x).toBeCloseTo(150, 9);
    expect(back.y).toBeCloseTo(210, 9);
    const landed = landInLoupe(render.x, render.y, loupeMagnification(scale), 390, 520);
    expect(landed.x).toBeCloseTo(HALF, 9);
    expect(landed.y).toBeCloseTo(HALF, 9);
  });
});

describe('loupeMagnification', () => {
  it('is twice the board zoom, capped', () => {
    expect(loupeMagnification(1)).toBe(2);
    expect(loupeMagnification(3)).toBe(6);
    expect(loupeMagnification(6)).toBe(LOUPE_MAX_MAGNIFICATION);
    expect(loupeMagnification(8)).toBe(LOUPE_MAX_MAGNIFICATION);
  });
});

describe('loupeGateOpen', () => {
  it('stays shut for a quick still tap', () => {
    expect(loupeGateOpen(LOUPE_DELAY_MS - 1, LOUPE_SLOP_PT - 0.5)).toBe(false);
  });

  it('opens on time or on movement, whichever comes first', () => {
    expect(loupeGateOpen(LOUPE_DELAY_MS, 0)).toBe(true);
    expect(loupeGateOpen(10, LOUPE_SLOP_PT)).toBe(true);
  });
});
