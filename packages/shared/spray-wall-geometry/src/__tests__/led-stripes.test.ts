import { describe, expect, it } from 'vitest';
import {
  addLedStripe,
  addLedStripeLed,
  buildSprayLedMapping,
  createLedStripes,
  DEFAULT_TNUT_CORNERS,
  generateTnutGrid,
  MAX_TNUT_LAYOUT_BYTES,
  MAX_LED_STRIPES,
  moveLedStripeEndpoint,
  readTnutLayout,
  removeLedStripe,
  removeLedStripeLed,
  setLedStripeCount,
  setTnutLedLink,
  stripeCableUnits,
  type TnutLayout,
} from '../index';

const frame = { width: 1000, height: 600 };
function base(overrides: Partial<TnutLayout> = {}): TnutLayout {
  const configured: TnutLayout = {
    version: 1,
    pattern: 'grid',
    rows: 3,
    columns: 3,
    firstRowOffset: false,
    corners: DEFAULT_TNUT_CORNERS,
    photoKey: 'photo',
    holes: [],
    columnConvention: 'all',
    ...overrides,
  };
  configured.holes = generateTnutGrid({ ...configured, pattern: configured.pattern === 'offset' ? 'offset' : 'grid' });
  return configured;
}
function stripes(
  overrides: Partial<TnutLayout> = {},
  count = 9,
  orientation: 'horizontal' | 'vertical' = 'vertical',
): TnutLayout {
  const created = createLedStripes(base(overrides), orientation, count);
  if (created === 'capacity') throw new Error('Expected valid stripes');
  return created;
}
function wire(layout: TnutLayout): TnutLayout {
  return {
    ...layout,
    wiring: {
      direction: 'custom',
      startCorner: 'tl',
      paths: [stripeCableUnits(layout).flatMap((unit, index) => (index % 2 ? [...unit].reverse() : [...unit]))],
      skips: [],
      initialSkip: 3,
    },
  };
}

describe('editable ordered LED stripes', () => {
  it.each(['vertical', 'horizontal'] as const)(
    'defaults to one %s stripe per calibrated grid axis with wall-edge endpoints',
    (orientation) => {
      const configured = stripes({}, 9, orientation);
      expect(configured.ledStripes!.stripes).toHaveLength(3);
      expect(configured.ledPositions).toHaveLength(27);
      for (const stripe of configured.ledStripes!.stripes) {
        expect(orientation === 'vertical' ? stripe.start.y : stripe.start.x).toBe(0);
        expect(orientation === 'vertical' ? stripe.end.y : stripe.end.x).toBe(1);
      }
      expect(readTnutLayout(JSON.parse(JSON.stringify(wire(configured))))).toEqual(wire(configured));
    },
  );

  it('uses actual single-axis anchors and ignores degenerate hidden corners', () => {
    const row = base({
      rows: 1,
      columns: 3,
      corners: {
        topLeft: { x: 0.2, y: 0.1 },
        topRight: { x: 0.8, y: 0.1 },
        bottomLeft: { x: 0.2, y: 0.1 },
        bottomRight: { x: 0.8, y: 0.1 },
      },
    });
    const horizontal = createLedStripes(row, 'horizontal', 1);
    if (horizontal === 'capacity') throw new Error('Expected row stripe');
    expect(horizontal.ledStripes!.stripes[0]).toMatchObject({ start: { x: 0, y: 0.1 }, end: { x: 1, y: 0.1 } });
    expect(horizontal.ledPositions![0]).toMatchObject({ x: 0.5, y: 0.1 });
    const vertical = createLedStripes(row, 'vertical', 1);
    if (vertical === 'capacity') throw new Error('Expected crossing stripes');
    expect(vertical.ledStripes!.stripes.map((stripe) => stripe.start.x)).toEqual([0.2, 0.5, 0.8]);
    const column = base({
      columns: 1,
      rows: 3,
      corners: {
        topLeft: { x: 0.2, y: 0.1 },
        bottomLeft: { x: 0.2, y: 0.9 },
        topRight: { x: 0.2, y: 0.1 },
        bottomRight: { x: 0.2, y: 0.9 },
      },
    });
    const crossed = createLedStripes(column, 'horizontal', 1);
    if (crossed === 'capacity') throw new Error('Expected column crossings');
    expect(crossed.ledStripes!.stripes.map((stripe) => stripe.start.y)).toEqual([0.1, 0.5, 0.9]);
    const one = stripes({ rows: 1, columns: 1 }, 1);
    expect(one.ledPositions![0]).toMatchObject({ x: 0.1, y: 0.5 });
  });

  it('retains physical IDs and complete wiring through a nonlast endpoint edit', () => {
    const configured = wire(stripes());
    const stripe = configured.ledStripes!.stripes[0];
    const [first, second] = configured.ledStripes!.stripes;
    configured.wiring!.skips = [{ from: first.ledIds.at(-1)!, to: second.ledIds.at(-1)!, count: 5 }];
    const moved = moveLedStripeEndpoint(configured, stripe.id, 'end', { x: 0.15, y: 1 });
    expect(moved.ledPositions!.map((led) => led.id)).toEqual(configured.ledPositions!.map((led) => led.id));
    expect(moved.wiring).toEqual(configured.wiring);
    expect(readTnutLayout(moved)).toEqual(moved);
    expect(moveLedStripeEndpoint(configured, stripe.id, 'end', stripe.start)).toBe(configured);
  });

  it('never reuses deleted stripe/LED IDs and clears topology wiring and stale manual links', () => {
    let configured = wire(stripes());
    const first = configured.ledStripes!.stripes[0];
    configured = setTnutLedLink(configured, 0, [first.ledIds.at(-1)!]);
    const smaller = setLedStripeCount(configured, first.id, 2);
    if (smaller === 'capacity') throw new Error('Expected smaller stripe');
    expect(smaller.wiring).toBeUndefined();
    expect(smaller.tnutLeds![0].ledIds).toEqual([]);
    const bigger = setLedStripeCount(smaller, first.id, 9);
    if (bigger === 'capacity') throw new Error('Expected resized stripe');
    expect(bigger.ledStripes!.stripes[0].ledIds.slice(0, 2)).toEqual(first.ledIds.slice(0, 2));
    expect(bigger.ledStripes!.stripes[0].ledIds.slice(2).every((id) => !first.ledIds.includes(id))).toBe(true);
    const removed = removeLedStripe(bigger, first.id);
    const added = addLedStripe(removed, first.start, first.end, 2);
    if (added === 'capacity') throw new Error('Expected added stripe');
    expect(added.ledStripes!.stripes.at(-1)!.id).not.toBe(first.id);
    expect(readTnutLayout(added)).toEqual(added);
  });

  it('adds/removes individual LEDs without moving surviving markers or reusing IDs', () => {
    const configured = stripes({}, 2);
    const stripe = configured.ledStripes!.stripes[0];
    const added = addLedStripeLed(configured, stripe.id, { x: 0.1, y: 0.4 });
    if (added === 'capacity') throw new Error('Expected added LED');
    expect(added.ledPositions).toEqual(expect.arrayContaining(configured.ledPositions!));
    const newId = added.ledStripes!.stripes[0].ledIds[1];
    expect(newId).not.toBe(stripe.ledIds[1]);
    const removed = removeLedStripeLed(added, stripe.id, newId);
    expect(removed.ledPositions).toEqual(configured.ledPositions);
    const last = setLedStripeCount(removed, stripe.id, 1);
    if (last === 'capacity') throw new Error('Expected singleton');
    expect(removeLedStripeLed(last, stripe.id, last.ledStripes!.stripes[0].ledIds[0]).ledStripes!.stripes).toHaveLength(
      2,
    );
  });

  it('rejects capacity overflow atomically and saves the largest plain layout within the payload guard', () => {
    const configured = stripes({ rows: 50, columns: 50 }, 120);
    const snapshot = JSON.stringify(configured);
    expect(setLedStripeCount(configured, configured.ledStripes!.stripes[0].id, 121)).toBe('capacity');
    expect(addLedStripeLed(configured, configured.ledStripes!.stripes[0].id)).toBe('capacity');
    expect(createLedStripes(base({ columns: 50 }), 'vertical', 121)).toBe('capacity');
    expect(JSON.stringify(configured)).toBe(snapshot);
    const largest = wire(configured);
    expect(Buffer.byteLength(JSON.stringify(largest))).toBeLessThanOrEqual(MAX_TNUT_LAYOUT_BYTES);
    expect(readTnutLayout(largest)).toEqual(largest);
  });

  it('bounds simultaneous stripes while allowing monotonic IDs beyond the live-stripe limit', () => {
    let configured = stripes({ columns: 50 }, 1);
    while (configured.ledStripes!.stripes.length < MAX_LED_STRIPES) {
      const added = addLedStripe(configured, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, 1);
      if (added === 'capacity') throw new Error('Expected room below stripe cap');
      configured = added;
    }
    expect(readTnutLayout(configured)).toEqual(configured);
    expect(addLedStripe(configured, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, 1)).toBe('capacity');
    const removed = removeLedStripe(configured, configured.ledStripes!.stripes[0].id);
    const replaced = addLedStripe(removed, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, 1);
    if (replaced === 'capacity') throw new Error('Expected removed stripe room');
    expect(replaced.ledStripes!.nextStripeId).toBeGreaterThan(MAX_LED_STRIPES);
    expect(readTnutLayout(replaced)).toEqual(replaced);
  });

  it('rejects malformed membership, counters, endpoints and partial/reordered/gapped cable units', () => {
    const configured = wire(stripes({}, 3));
    const model = configured.ledStripes!;
    const first = model.stripes[0];
    for (const patch of [
      { orientation: 'diagonal' },
      { nextLedId: 0 },
      { stripes: [{ ...first, start: { x: NaN, y: 0 } }] },
      { stripes: [{ ...first, end: first.start }] },
      { stripes: [{ ...first, ledIds: [first.ledIds[0], first.ledIds[0]] }] },
      { stripes: [{ ...first, ledIds: ['missing'] }] },
    ])
      expect(readTnutLayout({ ...configured, ledStripes: { ...model, ...patch } })).toBeNull();
    for (const wiring of [
      { direction: 'custom', startCorner: 'tl', paths: [[first.ledIds[0]]], skips: [] },
      {
        direction: 'custom',
        startCorner: 'tl',
        paths: [[first.ledIds[0], first.ledIds[2], first.ledIds[1]]],
        skips: [],
      },
      { ...configured.wiring, skips: [{ from: first.ledIds[0], to: first.ledIds[1], count: 1 }] },
    ])
      expect(readTnutLayout({ ...configured, wiring })).toBeNull();
    expect(readTnutLayout({ ...configured, ledStripes: null })).toBeNull();
    const ordinary = base();
    expect(readTnutLayout({ ...ordinary, ledStripes: null })).toEqual(ordinary);
  });
});

describe('stripe ownership intervals', () => {
  it.each(['vertical', 'horizontal'] as const)(
    'maps %s stripes through rotated perspective on a non-square wall',
    (orientation) => {
      const configured = stripes(
        {
          corners: {
            topLeft: { x: 0.12, y: 0.8 },
            topRight: { x: 0.15, y: 0.15 },
            bottomLeft: { x: 0.88, y: 0.9 },
            bottomRight: { x: 0.7, y: 0.1 },
          },
        },
        11,
        orientation,
      );
      const mapping = buildSprayLedMapping(configured, { width: 1800, height: 400 }, []);
      expect(mapping.holes.every((hole) => hole.ledIds.length > 0)).toBe(true);
      const assigned = mapping.holes.flatMap((hole) => hole.ledIds);
      expect(new Set(assigned).size).toBe(assigned.length);
    },
  );
  it.each(['vertical', 'horizontal'] as const)(
    'assigns whole %s interval chains and leaves midpoint ties unassigned',
    (orientation) => {
      const configured = wire(stripes({}, 11, orientation));
      const hold =
        orientation === 'vertical'
          ? { id: 1, cx: 500, cy: 180, r: 130, outline: [-0.2, -1, 0.2, -1, 0.2, 1, -0.2, 1] }
          : { id: 1, cx: 300, cy: 300, r: 220, outline: [-1, -0.1, 1, -0.1, 1, 0.1, -1, 0.1] };
      const mapping = buildSprayLedMapping(configured, frame, [hold]);
      expect(mapping.holds[0].holeIndices).toHaveLength(2);
      expect(mapping.holds[0].ledIds.length).toBeGreaterThan(5);
      expect(mapping.holds[0].aboveLedIds).toEqual([]);
      const assigned = mapping.holes.flatMap((entry) => entry.ledIds);
      expect(new Set(assigned).size).toBe(assigned.length);
      const stripe = configured.ledStripes!.stripes[1];
      const boundary = configured.ledPositions!.find((led) => led.id === stripe.ledIds[3])!;
      expect(orientation === 'vertical' ? boundary.y : boundary.x).toBeCloseTo(0.3);
      expect(assigned).not.toContain(boundary.id);
    },
  );

  it('uses segment eligibility before nearest-line choice for collinear split rails', () => {
    let configured = stripes({ columns: 1, rows: 3 }, 3);
    const first = configured.ledStripes!.stripes[0];
    configured = moveLedStripeEndpoint(configured, first.id, 'end', { x: 0.1, y: 0.4 });
    const added = addLedStripe(configured, { x: 0.1, y: 0.6 }, { x: 0.1, y: 1 }, 3);
    if (added === 'capacity') throw new Error('Expected split rail');
    const mapping = buildSprayLedMapping(added, frame, []);
    expect(mapping.holes[0].ledIds).toHaveLength(3);
    expect(mapping.holes[1].ledIds).toEqual([]);
    expect(mapping.holes[2].ledIds).toHaveLength(3);
  });

  it('keeps slightly tilted edited stripes mapped on a non-square wall without borrowing missing neighbors', () => {
    const configured = stripes({}, 9);
    const first = configured.ledStripes!.stripes[0];
    const moved = moveLedStripeEndpoint(configured, first.id, 'end', { x: 0.12, y: 1 });
    const withoutNeighbor = removeLedStripe(moved, moved.ledStripes!.stripes[1].id);
    const mapping = buildSprayLedMapping(withoutNeighbor, { width: 1800, height: 500 }, []);
    expect(mapping.holes[0].ledIds.length).toBeGreaterThan(0);
    expect(mapping.holes[3].ledIds.length).toBeGreaterThan(0);
    expect(mapping.holes[1].ledIds).toEqual([]);
    expect(mapping.holes[4].ledIds).toEqual([]);
  });

  it('uses calibrated column spacing to avoid borrowing from a compact missing neighboring stripe', () => {
    const configured = stripes(
      {
        corners: {
          topLeft: { x: 0.4, y: 0.1 },
          topRight: { x: 0.6, y: 0.1 },
          bottomLeft: { x: 0.4, y: 0.9 },
          bottomRight: { x: 0.6, y: 0.9 },
        },
      },
      11,
    );
    const withoutRight = removeLedStripe(configured, configured.ledStripes!.stripes[2].id);
    withoutRight.holes = withoutRight.holes.filter(
      (hole) => Math.abs(hole.x - 0.5) > 1e-8 || Math.abs(hole.y - 0.5) > 1e-8,
    );
    const mapping = buildSprayLedMapping(withoutRight, frame, []);
    const rightNut = withoutRight.holes.findIndex(
      (hole) => Math.abs(hole.x - 0.6) < 1e-8 && Math.abs(hole.y - 0.5) < 1e-8,
    );
    expect(rightNut).toBeGreaterThanOrEqual(0);
    expect(mapping.holes[rightNut].ledIds).toEqual([]);
    expect(mapping.holes[0].ledIds.length).toBeGreaterThan(0);
  });
});
