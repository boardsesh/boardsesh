import { describe, expect, it } from 'vitest';
import {
  bindLedPositionsToHoles,
  buildSprayLedMapping,
  createWiring,
  DEFAULT_TNUT_CORNERS,
  generateLedPositions,
  generateTnutGrid,
  findSprayHoldAtPoint,
  readTnutLayout,
  setWiringInitialSkip,
  setWiringSkip,
  type CanonicalSprayHold,
  type TnutLayout,
} from '../index';

const frame = { width: 1000, height: 600 };
function layout(overrides: Partial<TnutLayout> = {}): TnutLayout {
  const configured: TnutLayout = {
    version: 1,
    pattern: 'grid',
    rows: 3,
    columns: 3,
    firstRowOffset: false,
    columnConvention: 'all',
    corners: DEFAULT_TNUT_CORNERS,
    holes: generateTnutGrid({
      pattern: 'grid',
      rows: 3,
      columns: 3,
      firstRowOffset: false,
      corners: DEFAULT_TNUT_CORNERS,
    }),
    ledPlacement: 'center',
    photoKey: 'canonical-photo',
    ...overrides,
  };
  configured.ledPositions = generateLedPositions(configured);
  configured.wiring = createWiring(configured.ledPositions, 'horizontal', 'tl', configured);
  return configured;
}

function hold(overrides: Partial<CanonicalSprayHold> = {}): CanonicalSprayHold {
  return { id: 1, cx: 500, cy: 300, r: 35, ...overrides };
}

describe('hold, hole and physical LED mapping', () => {
  it('uses the same silhouette and overlap rules for a hold tap', () => {
    const holds = [hold({ id: 20, cx: 490, r: 40 }), hold({ id: 10, cx: 510, r: 40 })];
    expect(findSprayHoldAtPoint(holds, { x: 0.5, y: 0.5 }, frame)).toBe(10);
    expect(findSprayHoldAtPoint(holds, { x: 0.9, y: 0.9 }, frame)).toBeNull();
    expect(findSprayHoldAtPoint(holds, { x: NaN, y: 0.5 }, frame)).toBeNull();
    expect(findSprayHoldAtPoint([hold({ cx: -500 })], { x: -0.5, y: 0.5 }, frame)).toBeNull();
  });

  it('uses canonical frame dimensions directly on a non-square rectified wall', () => {
    const configured = layout();
    const mapping = buildSprayLedMapping(configured, frame, [hold(), hold({ id: 2, cx: 100, cy: 60 })]);
    expect(mapping.holes[4]).toMatchObject({ holeIndex: 4, holdId: 1, indices: [4] });
    expect(mapping.holes[0]).toMatchObject({ holdId: 2, indices: [0] });
    expect(mapping.holes[1].holdId).toBeNull();
    expect(mapping.holds[0]).toMatchObject({ holdId: 1, holeIndices: [4], indices: [4] });
  });

  it('matches all holes inside a large silhouette but excludes its concave opening', () => {
    const configured = layout({
      pattern: 'custom',
      holes: [
        { x: 0.45, y: 0.5 },
        { x: 0.55, y: 0.5 },
        { x: 0.5, y: 0.6 },
      ],
    });
    const traced = hold({ r: 100, outline: [-1, -1, 1, -1, 1, 1, 0.3, 1, 0.3, 0.2, -0.3, 0.2, -0.3, 1, -1, 1] });
    expect(buildSprayLedMapping(configured, frame, [traced]).holds[0].holeIndices).toEqual([0, 1]);
  });

  it('includes an exact silhouette boundary and falls back to a circle for malformed outlines', () => {
    const configured = layout({
      holes: [
        { x: 0.55, y: 0.5 },
        { x: 0.5, y: 0.5 },
      ],
    });
    const boundary = hold({ r: 50, outline: [-1, -1, 1, -1, 1, 1, -1, 1] });
    expect(buildSprayLedMapping(configured, frame, [boundary]).holds[0].holeIndices).toEqual([0, 1]);
    expect(buildSprayLedMapping(configured, frame, [hold({ outline: [1, 2, 3] })]).holds[0].holeIndices).toEqual([1]);
  });

  it('never assigns a distant bare-wall hole to the nearest hold', () => {
    const mapping = buildSprayLedMapping(layout(), frame, [hold({ cx: 450, cy: 300, r: 20 })]);
    expect(mapping.holds[0].holeIndices).toEqual([]);
    expect(mapping.holes.every((entry) => entry.holdId === null)).toBe(true);
  });

  it('resolves overlapping silhouettes deterministically by normalized distance then hold ID', () => {
    const first = hold({ id: 20, cx: 490, r: 40 });
    const second = hold({ id: 10, cx: 510, r: 40 });
    for (const holds of [
      [first, second],
      [second, first],
    ]) {
      expect(buildSprayLedMapping(layout(), frame, holds).holes[4].holdId).toBe(10);
    }
  });

  it.each(['center', 'sides', 'below'] as const)('keeps the %s binding after moving an LED', (ledPlacement) => {
    const configured = layout({ ledPlacement });
    const original = buildSprayLedMapping(configured, frame, [hold()]).holds[0].indices;
    expect(original).toHaveLength(ledPlacement === 'sides' ? 2 : 1);
    configured.ledPositions = configured.ledPositions!.map((led) => ({ ...led, x: 0.99, y: 0.99 }));
    expect(buildSprayLedMapping(configured, frame, [hold()]).holds[0].indices).toEqual(original);
    expect(readTnutLayout(JSON.parse(JSON.stringify(configured)))).toEqual(configured);
  });

  it('recovers moved generated positions from old saves without hole metadata', () => {
    const configured = layout({ ledPlacement: 'below' });
    const before = buildSprayLedMapping(configured, frame, [hold()]).holds[0].indices;
    configured.ledPositions = configured.ledPositions!.map(({ id }) => ({ id, x: 0.01, y: 0.99 }));
    expect(buildSprayLedMapping(configured, frame, [hold()]).holds[0].indices).toEqual(before);
  });

  it('maps both older quarter-column LEDs behind the hold to the original hole', () => {
    const configured = layout({ ledPlacement: 'sides', holes: [{ x: 0.5, y: 0.5 }] });
    configured.ledPositions = [
      { id: 'led-0.40000000-0.50000000', x: 0.8, y: 0.1 },
      { id: 'led-0.60000000-0.50000000', x: 0.8, y: 0.9 },
    ];
    configured.wiring = createWiring(configured.ledPositions, 'horizontal', 'tl');
    expect(buildSprayLedMapping(configured, frame, [hold()]).holds[0].indices).toEqual([0, 1]);
  });

  it('binds a nearby manual LED once and retains that association after moving it', () => {
    const configured = layout();
    configured.ledPositions!.push({ id: 'manual-0', x: 0.515, y: 0.51 });
    configured.ledPositions!.push({ id: 'manual-1', x: 0.25, y: 0.25 });
    const bound = bindLedPositionsToHoles(configured, frame);
    expect(bound.at(-2)?.hole).toEqual({ x: 0.5, y: 0.5 });
    expect(bound.at(-1)?.hole).toBeUndefined();
    configured.ledPositions = bound.map((led) => (led.id === 'manual-0' ? { ...led, x: 0.9, y: 0.1 } : led));
    configured.wiring = createWiring(configured.ledPositions, 'horizontal', 'tl');
    const mapped = buildSprayLedMapping(configured, frame, [hold()]).holds[0];
    expect(mapped.ledIds).toContain('manual-0');
    expect(mapped.ledIds).not.toContain('manual-1');
  });

  it('does not reassign explicitly bound LEDs when their mounting hole is removed', () => {
    const configured = layout();
    const removed = configured.ledPositions![4].id;
    configured.holes = configured.holes.filter((_, index) => index !== 4);
    expect(
      buildSprayLedMapping(configured, frame, [hold({ r: 500 })]).holes.flatMap((entry) => entry.ledIds),
    ).not.toContain(removed);
  });

  it('uses physical indices including start and intermediate skips, omitting unwired positions', () => {
    const configured = layout({
      holes: [
        { x: 0.45, y: 0.5 },
        { x: 0.5, y: 0.5 },
        { x: 0.55, y: 0.5 },
      ],
    });
    const [first, second] = configured.ledPositions!;
    configured.wiring = setWiringInitialSkip(
      { direction: 'custom', startCorner: 'tl', paths: [[first.id, second.id]], skips: [] },
      5,
    );
    configured.wiring = setWiringSkip(configured.wiring, first.id, second.id, 3);
    const mapping = buildSprayLedMapping(configured, frame, [hold({ r: 100 })]);
    expect(mapping.holds[0].indices).toEqual([5, 9]);
    expect(mapping.holes[2].ledIds).toHaveLength(1);
    expect(mapping.holes[2].indices).toEqual([]);
  });

  it('maps complementary slots, shares ties and does not steal a deleted slot', () => {
    const configured = layout({ pattern: 'offset', columns: 5, ledPlacement: 'alternating' });
    configured.holes = generateTnutGrid({ ...configured, pattern: 'offset' });
    configured.ledPositions = generateLedPositions(configured);
    configured.wiring = createWiring(configured.ledPositions, 'horizontal', 'tl', configured);
    const original = buildSprayLedMapping(configured, frame, []);
    expect(original.holes[1].ledIds).toHaveLength(2);
    const removed = original.holes[0].ledIds[0];
    configured.ledPositions = configured.ledPositions.filter((led) => led.id !== removed);
    expect(buildSprayLedMapping(configured, frame, []).holes[0].ledIds).toEqual([]);
  });

  it('retains a manual complementary slot association after it is moved and saved', () => {
    const configured = layout({ pattern: 'offset', columns: 5, ledPlacement: 'alternating' });
    configured.holes = generateTnutGrid({ ...configured, pattern: 'offset' });
    const generated = generateLedPositions(configured);
    const original = generated[0];
    configured.ledPositions = [{ id: 'manual-slot', x: original.x, y: original.y }, ...generated.slice(1)];
    configured.ledPositions = bindLedPositionsToHoles(configured, frame);
    configured.wiring = createWiring(configured.ledPositions, 'horizontal', 'tl', configured);
    const before = buildSprayLedMapping(configured, frame, []);
    expect(configured.ledPositions[0].origin).toEqual({ x: original.x, y: original.y });
    expect(before.holes.some((hole) => hole.ledIds.includes('manual-slot'))).toBe(true);
    configured.ledPositions = configured.ledPositions.map((led) =>
      led.id === 'manual-slot' ? { ...led, x: 0.99, y: 0.99 } : led,
    );
    const restored = readTnutLayout(JSON.parse(JSON.stringify(configured)));
    expect(restored).toEqual(configured);
    expect(buildSprayLedMapping(restored!, frame, [])).toEqual(before);
    expect(
      readTnutLayout({ ...configured, ledPositions: [{ id: 'bad', x: 0.5, y: 0.5, origin: { x: NaN, y: 0.5 } }] }),
    ).toBeNull();
  });

  it('returns empty associations for invalid frame dimensions or hold geometry', () => {
    const configured = layout();
    expect(buildSprayLedMapping(configured, { width: 0, height: 600 }, [hold()]).holes[4].indices).toEqual([]);
    expect(
      buildSprayLedMapping(configured, frame, [hold({ cx: NaN }), hold({ id: 2, r: 0 })]).holes[4].holdId,
    ).toBeNull();
  });

  it('rejects malformed persisted hole bindings and keeps older saves readable', () => {
    const configured = layout();
    expect(
      readTnutLayout({ ...configured, ledPositions: [{ id: 'test', x: 0.5, y: 0.5, hole: { x: 2, y: 0.5 } }] }),
    ).toBeNull();
    const old = layout();
    old.ledPositions = old.ledPositions!.map(({ id, x, y }) => ({ id, x, y }));
    expect(readTnutLayout(old)).toEqual(old);
  });
});
