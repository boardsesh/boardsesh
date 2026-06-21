import { describe, it, expect } from 'vitest';
import { buildHoldHitTargets, inverseTransformPoint, resolveHoldAtPoint } from '../holdLayout';
import type { BoardHoldTarget } from '../../../lib/create-board-holds';

/** Forward zoom transform (center origin), the exact thing inverseTransformPoint undoes. */
function forward(
  localX: number,
  localY: number,
  scale: number,
  translateX: number,
  translateY: number,
  containerWidth: number,
  containerHeight: number,
): { x: number; y: number } {
  const cx = containerWidth / 2;
  const cy = containerHeight / 2;
  return {
    x: cx + scale * (localX - cx) + translateX,
    y: cy + scale * (localY - cy) + translateY,
  };
}

describe('inverseTransformPoint', () => {
  it('recovers the worked example (renderWidth=300, scale=2, translateX=-50, local x=200 → screen 200)', () => {
    const screen = forward(200, 400, 2, -50, 0, 300, 600);
    expect(screen.x).toBe(200);
    expect(screen.y).toBe(500);
    const local = inverseTransformPoint(screen.x, screen.y, 2, -50, 0, 300, 600);
    expect(local.x).toBeCloseTo(200, 6);
    expect(local.y).toBeCloseTo(400, 6);
  });

  it('is the exact inverse of the forward transform across scales/translations', () => {
    const cases = [
      { scale: 1, tx: 0, ty: 0 },
      { scale: 2.5, tx: -120, ty: 40 },
      { scale: 4, tx: 200, ty: -200 },
      { scale: 1.3, tx: 17, ty: -3 },
    ];
    for (const { scale, tx, ty } of cases) {
      for (const [lx, ly] of [
        [0, 0],
        [150, 300],
        [300, 600],
        [73, 412],
      ]) {
        const s = forward(lx, ly, scale, tx, ty, 300, 600);
        const back = inverseTransformPoint(s.x, s.y, scale, tx, ty, 300, 600);
        expect(back.x).toBeCloseTo(lx, 6);
        expect(back.y).toBeCloseTo(ly, 6);
      }
    }
  });

  it('returns the point unchanged at scale 1 with no translation', () => {
    expect(inverseTransformPoint(120, 240, 1, 0, 0, 300, 600)).toEqual({ x: 120, y: 240 });
  });
});

describe('buildHoldHitTargets', () => {
  const holds: BoardHoldTarget[] = [{ id: 1, cx: 500, cy: 1000, r: 50 }];

  it('places the centre in render px and uses tapDiameter/2 as the radius', () => {
    // scale 300/1000=0.3, ringDiameter=50*2*0.3=30, tapDiameter=max(48,44)=48.
    const [target] = buildHoldHitTargets(holds, 1000, 2000, 300, 600, false);
    expect(target).toEqual({ holdId: 1, x: 150, y: 300, radius: 24 });
  });

  it('mirrors the x position when mirrored', () => {
    const offset: BoardHoldTarget[] = [{ id: 2, cx: 250, cy: 500, r: 50 }];
    const [plain] = buildHoldHitTargets(offset, 1000, 2000, 300, 600, false);
    const [mirrored] = buildHoldHitTargets(offset, 1000, 2000, 300, 600, true);
    expect(plain.x).toBeCloseTo(75, 6); // cxPct 25 → 0.25*300
    expect(mirrored.x).toBeCloseTo(225, 6); // (100-25)% → 0.75*300
    expect(mirrored.y).toBe(plain.y); // y is unaffected by mirroring
  });

  it('enforces the minimum tap diameter for tiny holds', () => {
    const tiny: BoardHoldTarget[] = [{ id: 3, cx: 500, cy: 1000, r: 5 }];
    const [target] = buildHoldHitTargets(tiny, 1000, 2000, 300, 600, false);
    // ringDiameter=5*2*0.3=3, *1.6=4.8 < MIN_TAP_DIAMETER 44 → radius 22.
    expect(target.radius).toBe(22);
  });
});

describe('resolveHoldAtPoint', () => {
  const targets = [
    { holdId: 1, x: 150, y: 300, radius: 24 },
    { holdId: 2, x: 160, y: 300, radius: 24 }, // overlaps #1
  ];

  it('returns the hold whose circle contains the point', () => {
    expect(resolveHoldAtPoint(150, 300, targets)).toBe(1);
  });

  it('returns null when the point is outside every circle', () => {
    expect(resolveHoldAtPoint(400, 300, targets)).toBeNull();
  });

  it('picks the nearest centre when tap circles overlap', () => {
    expect(resolveHoldAtPoint(152, 300, targets)).toBe(1);
    expect(resolveHoldAtPoint(158, 300, targets)).toBe(2);
  });

  it('returns null for an empty hit-target list', () => {
    expect(resolveHoldAtPoint(150, 300, [])).toBeNull();
  });
});
