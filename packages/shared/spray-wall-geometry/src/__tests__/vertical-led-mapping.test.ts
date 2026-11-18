import { describe, expect, it } from 'vitest';
import {
  assignLedIndices,
  bindLedPositionsToHoles,
  buildSprayLedMapping,
  createWiring,
  generateLedPositions,
  generateTnutGrid,
  homographyFromAnchors,
  mapPoint,
  readTnutLayout,
  setHoldLedLink,
  type TnutCorners,
  type TnutLayout,
} from '../index';

const frame = { width: 700, height: 1300 };
const corners: TnutCorners = {
  topLeft: { x: 0, y: 0 },
  topRight: { x: 1, y: 0 },
  bottomLeft: { x: 0, y: 1 },
  bottomRight: { x: 1, y: 1 },
};

function layout(ledPlacement: 'below' | 'alternating', overrides: Partial<TnutLayout> = {}): TnutLayout {
  const configured: TnutLayout = {
    version: 1,
    pattern: ledPlacement === 'alternating' ? 'offset' : 'grid',
    rows: 5,
    columns: 5,
    firstRowOffset: false,
    columnConvention: 'all',
    corners,
    holes: [],
    photoKey: 'photo',
    ledPlacement,
    ...overrides,
  };
  configured.holes = generateTnutGrid({ ...configured, pattern: configured.pattern === 'offset' ? 'offset' : 'grid' });
  configured.ledPositions = generateLedPositions(configured);
  configured.wiring = createWiring(configured.ledPositions, 'horizontal', 'tl', configured);
  return configured;
}

function toGrid(configured: TnutLayout, point: { x: number; y: number }) {
  const { topLeft, topRight, bottomRight, bottomLeft } = configured.corners;
  const matrix = homographyFromAnchors(
    [topLeft, topRight, bottomRight, bottomLeft].map(({ x, y }) => [x, y]),
    { width: 1, height: 1 },
  );
  return mapPoint(matrix, point.x, point.y);
}

describe('one lower LED and one optional upper LED per mounting hole', () => {
  it.each(['below', 'alternating'] as const)('%s has no side/above fallback at missing slots or edges', (placement) => {
    const configured = layout(placement);
    const original = buildSprayLedMapping(configured, frame, []);
    const gap = placement === 'below' ? 0.125 : 0.25;
    const byId = new Map(configured.ledPositions!.map((led) => [led.id, led]));
    for (const mapped of original.holes) {
      const hole = configured.holes[mapped.holeIndex];
      expect(mapped.ledIds.length).toBeLessThanOrEqual(1);
      expect(mapped.aboveLedIds.length).toBeLessThanOrEqual(1);
      for (const id of mapped.ledIds) {
        expect(byId.get(id)!.x).toBeCloseTo(hole.x);
        expect(byId.get(id)!.y - hole.y).toBeCloseTo(gap);
      }
      for (const id of mapped.aboveLedIds) {
        expect(byId.get(id)!.x).toBeCloseTo(hole.x);
        expect(hole.y - byId.get(id)!.y).toBeCloseTo(gap);
      }
      if (hole.y === 1) expect(mapped.ledIds).toEqual([]);
      if (hole.y === 0) expect(mapped.aboveLedIds).toEqual([]);
    }
    const middle = original.holes.find((mapped) => configured.holes[mapped.holeIndex].y === 0.5)!;
    expect(middle.ledIds).toHaveLength(1);
    expect(middle.aboveLedIds).toHaveLength(1);
    configured.ledPositions = configured.ledPositions!.filter((led) => led.id !== middle.ledIds[0]);
    const missing = buildSprayLedMapping(configured, frame, []).holes[middle.holeIndex];
    expect(missing.ledIds).toEqual([]);
    expect(missing.aboveLedIds).toEqual(middle.aboveLedIds);
  });

  it.each(['below', 'alternating'] as const)('%s follows perspective grid axes on a non-square image', (placement) => {
    for (const firstRowOffset of [false, true]) {
      const configured = layout(placement, {
        firstRowOffset,
        corners: {
          topLeft: { x: 0.12, y: 0.8 },
          topRight: { x: 0.15, y: 0.15 },
          bottomLeft: { x: 0.88, y: 0.9 },
          bottomRight: { x: 0.7, y: 0.1 },
        },
      });
      const mapping = buildSprayLedMapping(configured, frame, []);
      const byId = new Map(configured.ledPositions!.map((led) => [led.id, led]));
      const gap = placement === 'below' ? 0.125 : 0.25;
      const middle = mapping.holes.filter((mapped) => {
        const [, row] = toGrid(configured, configured.holes[mapped.holeIndex]);
        return row > 0.2 && row < 0.8;
      });
      expect(middle.length).toBeGreaterThan(0);
      for (const mapped of middle) {
        expect(mapped.ledIds).toHaveLength(1);
        expect(mapped.aboveLedIds).toHaveLength(1);
        const [column, row] = toGrid(configured, configured.holes[mapped.holeIndex]);
        const [lowerColumn, lowerRow] = toGrid(configured, byId.get(mapped.ledIds[0])!);
        const [upperColumn, upperRow] = toGrid(configured, byId.get(mapped.aboveLedIds[0])!);
        expect(lowerColumn).toBeCloseTo(column);
        expect(lowerRow - row).toBeCloseTo(gap);
        expect(upperColumn).toBeCloseTo(column);
        expect(row - upperRow).toBeCloseTo(gap);
      }
    }
  });

  it('rejects manually placed side and distant lower slots when the expected slot is absent', () => {
    const configured = layout('alternating');
    const holeIndex = configured.holes.findIndex((hole) => hole.x === 0.5 && hole.y === 0.5);
    configured.ledPositions = [
      { id: 'side', x: 0.75, y: 0.5 },
      { id: 'far-below', x: 0.5, y: 1 },
      { id: 'upper', x: 0.5, y: 0.25 },
    ];
    const mapped = buildSprayLedMapping(configured, frame, []).holes[holeIndex];
    expect(mapped.ledIds).toEqual([]);
    expect(mapped.aboveLedIds).toEqual(['upper']);
  });

  it('finds the upper LED across staggered below rows for both phases and a single column', () => {
    for (const firstRowOffset of [false, true]) {
      for (const columns of [1, 5]) {
        const configured = layout('below', {
          pattern: 'offset',
          firstRowOffset,
          columns,
          corners: {
            topLeft: { x: 0.12, y: 0.8 },
            topRight: { x: 0.15, y: 0.15 },
            bottomLeft: { x: 0.88, y: 0.9 },
            bottomRight: { x: 0.7, y: 0.1 },
          },
        });
        const mapping = buildSprayLedMapping(configured, frame, []);
        const byId = new Map(configured.ledPositions!.map((led) => [led.id, led]));
        const interior = mapping.holes.filter((mapped) => {
          const [, row] = toGrid(configured, configured.holes[mapped.holeIndex]);
          return row > 0.4 && row < 0.8;
        });
        expect(interior.length).toBeGreaterThan(0);
        for (const mapped of interior) {
          const [column, row] = toGrid(configured, configured.holes[mapped.holeIndex]);
          expect(mapped.ledIds).toHaveLength(1);
          expect(mapped.aboveLedIds).toHaveLength(1);
          const [upperColumn, upperRow] = toGrid(configured, byId.get(mapped.aboveLedIds[0])!);
          expect(upperColumn).toBeCloseTo(column);
          if (columns === 1) {
            // One-axis holes interpolate along the active edge, while LED
            // offsets follow the complete saved perspective calibration.
            const previousHole = configured.holes[mapped.holeIndex - 1];
            const expected = configured.ledPositions!.find(
              (led) => led.hole?.x === previousHole.x && led.hole.y === previousHole.y,
            );
            expect(mapped.aboveLedIds).toEqual([expected!.id]);
          } else expect(row - upperRow).toBeCloseTo(0.375);
        }
        const selected = interior[0];
        const above = selected.aboveLedIds[0];
        const withoutUpper = {
          ...configured,
          ledPositions: configured.ledPositions!.filter((led) => led.id !== above),
        };
        expect(buildSprayLedMapping(withoutUpper, frame, []).holes[selected.holeIndex].aboveLedIds).toEqual([]);
      }
    }
  });

  it.each(['below', 'alternating'] as const)(
    '%s follows unequal single-column row gaps under perspective',
    (placement) => {
      const configured = layout(placement, {
        pattern: 'offset',
        columns: 1,
        corners: {
          topLeft: { x: 0, y: 0 },
          topRight: { x: 1, y: 0 },
          bottomLeft: { x: 0, y: 1 },
          bottomRight: { x: 0.5, y: 1 },
        },
      });
      const mapping = buildSprayLedMapping(configured, frame, []);
      const previousHole = configured.holes[1];
      const expected =
        placement === 'below'
          ? configured.ledPositions!.find((led) => led.hole?.x === previousHole.x && led.hole.y === previousHole.y)
          : configured.ledPositions!.find((led) => led.x === previousHole.x && led.y === previousHole.y);
      expect(mapping.holes[2].aboveLedIds).toEqual([expected!.id]);
      expect(mapping.holes[2].ledIds).toHaveLength(1);
      configured.ledPositions = configured.ledPositions!.filter((led) => led.id !== expected!.id);
      expect(buildSprayLedMapping(configured, frame, []).holes[2].aboveLedIds).toEqual([]);
    },
  );

  it('resolves nearby edited holes by slot distance instead of hole array order', () => {
    const configured = layout('below');
    const closer = { x: 0.5, y: 0.5 };
    const farther = { x: 0.51, y: 0.51 };
    configured.ledPositions = [{ id: 'shared-slot', x: 0.5, y: 0.625 }];
    for (const holes of [
      [closer, farther],
      [farther, closer],
    ]) {
      const mapping = buildSprayLedMapping({ ...configured, holes }, frame, []);
      expect(mapping.holes.find((mapped) => holes[mapped.holeIndex] === closer)!.ledIds).toEqual(['shared-slot']);
      expect(mapping.holes.find((mapped) => holes[mapped.holeIndex] === farther)!.ledIds).toEqual([]);
    }
  });

  it.each(['below', 'alternating'] as const)(
    '%s keeps both references through moves and saves without renumbering',
    (placement) => {
      const configured = layout(placement);
      configured.ledPositions = bindLedPositionsToHoles(configured, frame);
      const before = buildSprayLedMapping(configured, frame, []);
      const cable = assignLedIndices(configured.wiring!);
      configured.ledPositions = configured.ledPositions.map((led) => ({ ...led, x: 0.99, y: 0.99 }));
      const restored = readTnutLayout(JSON.parse(JSON.stringify(configured)))!;
      expect(restored).toEqual(configured);
      expect(buildSprayLedMapping(restored, frame, [])).toEqual(before);
      expect(assignLedIndices(restored.wiring!)).toEqual(cable);
    },
  );

  it('binds an upper-only manual slot and recovers it when an older save strips aboveHole', () => {
    const configured = layout('alternating');
    const first = configured.ledPositions![0];
    configured.ledPositions = [{ id: 'manual-upper', x: first.x, y: first.y }];
    configured.wiring = createWiring(configured.ledPositions, 'horizontal', 'tl');
    configured.ledPositions = bindLedPositionsToHoles(configured, frame);
    expect(configured.ledPositions[0]).toMatchObject({ origin: { x: first.x, y: first.y } });
    expect(configured.ledPositions[0].aboveHole).toBeDefined();
    expect(configured.ledPositions[0].hole).toBeUndefined();
    const before = buildSprayLedMapping(configured, frame, []);
    configured.ledPositions = configured.ledPositions.map(({ aboveHole: _aboveHole, ...led }) => ({
      ...led,
      x: 0.99,
      y: 0.99,
    }));
    expect(buildSprayLedMapping(readTnutLayout(configured)!, frame, [])).toEqual(before);
  });

  it('does not reassign a persisted upper reference whose mounting hole was removed', () => {
    const configured = layout('alternating');
    configured.ledPositions = bindLedPositionsToHoles(configured, frame);
    const selected = configured.ledPositions.find((led) => led.aboveHole)!;
    configured.holes = configured.holes.filter(
      (hole) => hole.x !== selected.aboveHole!.x || hole.y !== selected.aboveHole!.y,
    );
    expect(buildSprayLedMapping(configured, frame, []).holes.flatMap((mapped) => mapped.aboveLedIds)).not.toContain(
      selected.id,
    );
  });

  it('recomputes upper references from origins when a closer manual marker is added', () => {
    const configured = layout('below');
    configured.ledPositions = [{ id: 'original-upper', x: 0.51, y: 0.375 }];
    configured.wiring = undefined;
    configured.ledPositions = bindLedPositionsToHoles(configured, frame).map((led) => ({ ...led, x: 0.99, y: 0.99 }));
    expect(configured.ledPositions[0].aboveHole).toEqual({ x: 0.5, y: 0.5 });
    configured.ledPositions.push({ id: 'closer-upper', x: 0.5, y: 0.375 });
    const holeIndex = configured.holes.findIndex((hole) => hole.x === 0.5 && hole.y === 0.5);
    const mapping = buildSprayLedMapping(configured, frame, []);
    expect(mapping.holes[holeIndex].aboveLedIds).toEqual(['closer-upper']);
    const olderSave = readTnutLayout({
      ...configured,
      ledPositions: configured.ledPositions.map(({ aboveHole: _aboveHole, ...led }) => led),
    })!;
    expect(buildSprayLedMapping(olderSave, frame, [])).toEqual(mapping);
    const rebound = bindLedPositionsToHoles(configured, frame);
    expect(rebound[0].aboveHole).toBeUndefined();
    expect(rebound[1].aboveHole).toEqual({ x: 0.5, y: 0.5 });
  });

  it('uses one mounting nut for a large hold while retaining multiple hand-made primary links', () => {
    const configured = layout('below');
    const hold = { id: 1, cx: 350, cy: 650, r: 400 };
    const automatic = buildSprayLedMapping(configured, frame, [hold]).holds[0];
    expect(automatic.holeIndices).toHaveLength(1);
    expect(automatic.ledIds).toHaveLength(1);
    expect(automatic.aboveLedIds).toHaveLength(1);
    const chosen = configured.ledPositions!.slice(0, 3).map((led) => led.id);
    const manual = buildSprayLedMapping(setHoldLedLink(configured, 1, chosen), frame, [hold]).holds[0];
    expect(manual.ledIds).toEqual(chosen);
    expect(manual.indices).toHaveLength(3);
    expect(manual.aboveLedIds).toEqual(automatic.aboveLedIds);
  });

  it('retains unwired upper IDs without inventing physical indices', () => {
    const configured = layout('below');
    configured.wiring = { direction: 'custom', startCorner: 'tl', paths: [], skips: [] };
    const mapping = buildSprayLedMapping(configured, frame, []);
    expect(mapping.holes.some((mapped) => mapped.aboveLedIds.length)).toBe(true);
    expect(mapping.holes.every((mapped) => mapped.aboveIndices.length === 0)).toBe(true);
  });

  it('keeps upper references independent of manual primary links to the same LED', () => {
    const configured = layout('below');
    const holds = [
      { id: 1, cx: 350, cy: 650, r: 60 },
      { id: 2, cx: 350, cy: 325, r: 60 },
    ];
    const automatic = buildSprayLedMapping(configured, frame, holds);
    const upper = automatic.holds[0].aboveLedIds[0];
    expect(upper).toBeDefined();
    const linked = buildSprayLedMapping(setHoldLedLink(configured, 2, [upper]), frame, holds);
    expect(linked.holds[0].aboveLedIds).toEqual([upper]);
    expect(linked.holds[0].aboveIndices).toEqual(automatic.holds[0].aboveIndices);
    expect(linked.holds[1].ledIds).toEqual([upper]);
  });

  it.each([null, {}, { x: 0.5 }, { x: 0.5, y: Infinity }, { x: -0.1, y: 0.5 }])(
    'rejects invalid persisted upper association %j',
    (aboveHole) => {
      const configured = layout('below');
      expect(
        readTnutLayout({ ...configured, wiring: undefined, ledPositions: [{ id: 'bad', x: 0.5, y: 0.5, aboveHole }] }),
      ).toBeNull();
    },
  );
});
