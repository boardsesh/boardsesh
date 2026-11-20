import { describe, expect, it } from 'vitest';
import {
  bindLedPositionsToHoles,
  buildSprayLedMapping,
  clearHoldLedLink,
  clearTnutLedLink,
  createWiring,
  DEFAULT_TNUT_CORNERS,
  expandLedGrid,
  generateLedPositions,
  generateTnutGrid,
  keepLedLinksFromOlderApp,
  migrateHoldLedLinksToTnuts,
  moveTnutLedLinks,
  pruneTnutLedLinks,
  readTnutLayout,
  setHoldLedLink,
  setTnutLedLink,
  type TnutLayout,
} from '../index';

const frame = { width: 1000, height: 600 };
const hold = { id: 1, cx: 500, cy: 300, r: 35 };
function layout(size = 3): TnutLayout {
  const configured: TnutLayout = {
    version: 1,
    pattern: 'grid',
    rows: size,
    columns: size,
    firstRowOffset: false,
    corners: DEFAULT_TNUT_CORNERS,
    columnConvention: 'all',
    holes: [],
    ledPlacement: 'center',
    photoKey: 'photo',
  };
  configured.holes = generateTnutGrid({ ...configured, pattern: 'grid' });
  configured.ledPositions = generateLedPositions(configured);
  configured.wiring = createWiring(configured.ledPositions, 'horizontal', 'tl', configured);
  return configured;
}
const idAt = (configured: TnutLayout, index: number) => configured.ledPositions![index].id;
const mapped = (configured: TnutLayout, holdId = 1) =>
  buildSprayLedMapping(configured, frame, [{ ...hold, id: holdId }]);

describe('durable T-nut LED roles', () => {
  it('changes a mounted hold and a new detection ID through its nut, preserving independent multi-LED roles', () => {
    const configured = layout();
    const primary = [idAt(configured, 0), idAt(configured, 1)];
    const above = [idAt(configured, 0), idAt(configured, 3)];
    const linked = setTnutLedLink(setTnutLedLink(configured, 4, primary), 4, above, 'above');
    for (const holdId of [1, 900]) {
      const mapping = mapped(linked, holdId);
      expect(mapping.holes[4].ledIds).toEqual(primary);
      expect(mapping.holes[4].aboveLedIds).toEqual(above);
      expect(mapping.holds[0]).toMatchObject({
        ledIds: primary,
        aboveLedIds: above,
        indices: [0, 1],
        aboveIndices: [0, 5],
      });
    }
    expect(linked.holdLeds).toBeUndefined();
    expect(readTnutLayout(JSON.parse(JSON.stringify(linked)))).toEqual(linked);
  });

  it('keeps each omitted layer automatic and each empty layer deliberately unlit', () => {
    const configured = layout();
    const upper = [idAt(configured, 0)];
    const upperOnly = setTnutLedLink(configured, 4, upper, 'above');
    expect(mapped(upperOnly).holds[0]).toMatchObject({ indices: [4], aboveIndices: [0] });
    const noPrimary = setTnutLedLink(upperOnly, 4, []);
    expect(mapped(noPrimary).holds[0]).toMatchObject({ indices: [], aboveIndices: [0] });
    const resetPrimary = clearTnutLedLink(noPrimary, 4);
    expect(resetPrimary.tnutLeds).toEqual([{ hole: configured.holes[4], aboveLedIds: upper }]);
    expect(mapped(resetPrimary).holds[0]).toMatchObject({ indices: [4], aboveIndices: [0] });
    const resetBoth = clearTnutLedLink(resetPrimary, 4, 'above');
    expect(resetBoth.tnutLeds).toEqual([]);
    expect(mapped(resetBoth).holds[0]).toMatchObject({ indices: [4], aboveIndices: [] });
  });

  it('gives durable nut choices precedence over legacy hold overrides on each layer', () => {
    const configured = layout();
    const old = setHoldLedLink(setHoldLedLink(configured, 1, [idAt(configured, 8)]), 1, [idAt(configured, 7)], 'above');
    const linked = setTnutLedLink(setTnutLedLink(old, 4, [idAt(configured, 0)]), 4, [], 'above');
    expect(mapped(linked).holds[0]).toMatchObject({ indices: [0], aboveIndices: [] });
    expect(mapped(old).holds[0]).toMatchObject({ indices: [8], aboveIndices: [7] });
    expect(clearHoldLedLink(old, 1, 'above').holdLeds).toEqual(old.holdLeds);
  });

  it('takes same-role LEDs from automatic and legacy owners while allowing another role to share them', () => {
    const configured = layout();
    const selected = idAt(configured, 0);
    const linked = setTnutLedLink(
      setHoldLedLink(setHoldLedLink(configured, 2, [selected]), 2, [selected], 'above'),
      4,
      [selected],
    );
    const mapping = buildSprayLedMapping(linked, frame, [hold, { id: 2, cx: 100, cy: 60, r: 35 }]);
    expect(mapping.holds[0].ledIds).toEqual([selected]);
    expect(mapping.holds[1].ledIds).toEqual([]);
    expect(mapping.holds[1].aboveLedIds).toEqual([selected]);
    expect(mapping.holes[0].ledIds).toEqual([]);
  });

  it('survives hole reordering and moves only with an explicit marker move', () => {
    const configured = setTnutLedLink(layout(), 4, [idAt(layout(), 0)]);
    const reversed = { ...configured, holes: [...configured.holes].reverse() };
    expect(mapped(reversed).holds[0].indices).toEqual([0]);
    const destination = { x: 0.52, y: 0.5 };
    const moved = moveTnutLedLinks(configured, configured.holes[4], destination);
    const next = { ...moved, holes: moved.holes.map((hole, index) => (index === 4 ? destination : hole)) };
    expect(buildSprayLedMapping(next, frame, [{ ...hold, cx: 520 }]).holds[0].indices).toEqual([0]);
    expect(next.tnutLeds![0].hole).toEqual(destination);
    expect(configured.tnutLeds![0].hole).toEqual({ x: 0.5, y: 0.5 });
  });

  it.each(['center', 'sides', 'below', 'alternating'] as const)(
    'keeps %s automatic mounting anchors and physical cable intact after a marker move',
    (placement) => {
      const configured = layout();
      configured.ledPlacement = placement;
      if (placement === 'alternating') {
        configured.pattern = 'offset';
        configured.holes = generateTnutGrid({ ...configured, pattern: 'offset' });
      }
      configured.ledPositions = generateLedPositions(configured);
      configured.ledPositions = bindLedPositionsToHoles(configured, frame);
      configured.wiring = createWiring(configured.ledPositions, 'horizontal', 'tl', configured);
      const holeIndex = configured.holes.findIndex((hole) => hole.x === 0.5 && hole.y === 0.5);
      const before = mapped(configured).holds[0];
      expect(before.ledIds.length).toBeGreaterThan(0);
      const destination = { x: 0.52, y: 0.5 };
      const moved = moveTnutLedLinks(configured, configured.holes[holeIndex], destination);
      moved.holes = configured.holes.map((hole, index) => (index === holeIndex ? destination : hole));
      const restored = readTnutLayout(JSON.parse(JSON.stringify(moved)))!;
      const after = buildSprayLedMapping(restored, frame, [{ ...hold, cx: 520 }]).holds[0];
      expect(after.ledIds).toEqual(before.ledIds);
      expect(after.indices).toEqual(before.indices);
      expect(restored.wiring).toEqual(configured.wiring);
      const physical = (configuredLayout: TnutLayout) =>
        configuredLayout.ledPositions!.map(({ id, x, y, origin }) => ({ id, x, y, origin }));
      expect(physical(restored)).toEqual(physical(configured));
      for (const led of restored.ledPositions!)
        if (before.ledIds.includes(led.id)) expect(led.hole).toEqual(destination);
    },
  );

  it('prunes removed nuts and LEDs before their coordinates or IDs can be reused, and supports snapshot undo', () => {
    const configured = setTnutLedLink(
      setHoldLedLink(setHoldLedLink(layout(), 99, [idAt(layout(), 0)]), 99, [idAt(layout(), 0)], 'above'),
      4,
      [idAt(layout(), 0)],
    );
    const withoutLed = pruneTnutLedLinks({ ...configured, ledPositions: configured.ledPositions!.slice(1) });
    expect(withoutLed.tnutLeds![0].ledIds).toEqual([]);
    expect(withoutLed.holdLeds![0].ledIds).toEqual([]);
    expect(withoutLed.holdAboveLeds![0].ledIds).toEqual([]);
    const reused = { ...withoutLed, ledPositions: configured.ledPositions };
    expect(mapped(reused).holds[0].indices).toEqual([]);
    const withoutNut = pruneTnutLedLinks({ ...configured, holes: configured.holes.filter((_, index) => index !== 4) });
    expect(withoutNut.tnutLeds).toEqual([]);
    expect(mapped({ ...withoutNut, holes: configured.holes }).holds[0].indices).toEqual([4]);
    expect(mapped(configured).holds[0].indices).toEqual([0]);
  });

  it('preserves manual role LEDs and coordinates through expansion', () => {
    const configured = setTnutLedLink(
      setTnutLedLink(layout(), 4, [idAt(layout(), 0)]),
      4,
      [idAt(layout(), 1)],
      'above',
    );
    const result = expandLedGrid(configured, {
      ...layout(5),
      tnutLeds: configured.tnutLeds,
      ledPositions: configured.ledPositions,
      wiring: configured.wiring,
    });
    if (!result || result === 'capacity') throw new Error('Expected expansion');
    expect(result.layout.tnutLeds).toEqual(configured.tnutLeds);
    expect(mapped(result.layout, 100).holds[0]).toMatchObject({
      ledIds: [idAt(configured, 0)],
      aboveLedIds: [idAt(configured, 1)],
    });
  });

  it('migrates only confirmed unambiguous manual roles and removes their old hold-ID source', () => {
    const configured = setHoldLedLink(setHoldLedLink(layout(), 1, [idAt(layout(), 0)]), 1, [], 'above');
    const migrated = migrateHoldLedLinksToTnuts(configured, frame, [hold]);
    expect(configured.tnutLeds).toBeUndefined();
    expect(migrated.tnutLeds).toEqual([{ hole: { x: 0.5, y: 0.5 }, ledIds: [idAt(configured, 0)], aboveLedIds: [] }]);
    expect(migrated.holdLeds).toEqual([]);
    expect(migrated.holdAboveLeds).toEqual([]);
    expect(mapped(migrated, 900).holds[0]).toMatchObject({ indices: [0], aboveIndices: [] });
    expect(migrateHoldLedLinksToTnuts(layout(), frame, [hold]).tnutLeds).toBeUndefined();
    const movedSameId = buildSprayLedMapping(migrated, frame, [{ ...hold, cx: 900, cy: 540 }]).holds[0];
    expect(movedSameId.indices).toEqual([8]);
    expect(migrateHoldLedLinksToTnuts(migrated, frame, [hold])).toBe(migrated);
  });

  it('leaves conflicts, missing mounts and existing nut overrides unchanged during migration', () => {
    const configured = setHoldLedLink(setHoldLedLink(layout(), 1, [idAt(layout(), 0)]), 99, [idAt(layout(), 0)]);
    expect(migrateHoldLedLinksToTnuts(configured, frame, [hold]).tnutLeds).toBeUndefined();
    const noMount = { ...hold, cx: 250, cy: 150, r: 5 };
    expect(migrateHoldLedLinksToTnuts(configured, frame, [noMount]).tnutLeds).toBeUndefined();
    const sole = setHoldLedLink(layout(), 1, [idAt(layout(), 0)]);
    expect(migrateHoldLedLinksToTnuts(sole, frame, [hold, { ...hold, id: 2 }]).tnutLeds).toBeUndefined();
    const existing = setTnutLedLink(sole, 4, []);
    expect(migrateHoldLedLinksToTnuts(existing, frame, [hold]).tnutLeds).toEqual(existing.tnutLeds);
    expect(migrateHoldLedLinksToTnuts(existing, frame, [hold]).holdLeds).toEqual(existing.holdLeds);
    const equivalent = setTnutLedLink(sole, 4, [idAt(sole, 0)]);
    expect(migrateHoldLedLinksToTnuts(equivalent, frame, [hold]).holdLeds).toEqual([]);
    const anotherNut = setTnutLedLink(sole, 0, [idAt(sole, 0)]);
    expect(migrateHoldLedLinksToTnuts(anotherNut, frame, [hold]).tnutLeds).toEqual(anotherNut.tnutLeds);
  });

  it('leaves exactly tied LED distributions unmigrated regardless of hole order', () => {
    const configured = setHoldLedLink(layout(), 1, [idAt(layout(), 4)]);
    for (const holes of [
      [
        { x: 0.45, y: 0.5 },
        { x: 0.55, y: 0.5 },
      ],
      [
        { x: 0.55, y: 0.5 },
        { x: 0.45, y: 0.5 },
      ],
    ]) {
      const ambiguous = { ...configured, holes };
      expect(migrateHoldLedLinksToTnuts(ambiguous, frame, [{ ...hold, r: 100 }])).toBe(ambiguous);
    }
  });

  it.each([
    {},
    { hole: { x: 2, y: 0.5 }, ledIds: [] },
    { hole: { x: 0.5, y: 0.5 }, ledIds: null },
    { hole: { x: 0.5, y: 0.5 }, aboveLedIds: [1] },
    { hole: { x: NaN, y: 0.5 }, ledIds: [] },
  ])('rejects malformed persisted nut links %j', (link) => {
    expect(readTnutLayout({ ...layout(), tnutLeds: [link] })).toBeNull();
  });
});

describe('manual role preservation across older clients', () => {
  const sentNothing = { tnutLeds: false, holdAboveLeds: false };
  function stored() {
    return setHoldLedLink(setTnutLedLink(layout(), 4, [idAt(layout(), 0)], 'above'), 1, [idAt(layout(), 1)], 'above');
  }

  it('preserves absent modern keys but respects current-client empty lists', () => {
    const previous = stored();
    const merged = keepLedLinksFromOlderApp(layout(), sentNothing, previous);
    expect(merged.tnutLeds).toEqual(previous.tnutLeds);
    expect(merged.holdAboveLeds).toEqual(previous.holdAboveLeds);
    const cleared = { ...layout(), tnutLeds: [], holdAboveLeds: [] };
    expect(keepLedLinksFromOlderApp(cleared, { tnutLeds: true, holdAboveLeds: true }, previous)).toEqual(cleared);
    expect(keepLedLinksFromOlderApp(layout(), sentNothing, cleared).tnutLeds).toEqual([]);
  });

  it('prunes gone nuts and LEDs and ignores reorder-only changes', () => {
    const previous = stored();
    const reordered = {
      ...layout(),
      holes: [...previous.holes].reverse(),
      ledPositions: [...previous.ledPositions!].reverse(),
    };
    expect(keepLedLinksFromOlderApp(reordered, sentNothing, previous).tnutLeds).toEqual(previous.tnutLeds);
    const removed = { ...layout(), ledPositions: previous.ledPositions!.slice(1) };
    expect(keepLedLinksFromOlderApp(removed, sentNothing, previous).tnutLeds![0].aboveLedIds).toEqual([]);
    const noNut = { ...layout(), holes: previous.holes.filter((_, index) => index !== 4) };
    expect(keepLedLinksFromOlderApp(noNut, sentNothing, previous).tnutLeds).toEqual([]);
  });

  it('does not attach saved links to a replacement photo or rebuilt reused LED IDs', () => {
    const previous = stored();
    expect(
      keepLedLinksFromOlderApp({ ...layout(), photoKey: 'replacement' }, sentNothing, previous).tnutLeds,
    ).toBeUndefined();
    const rebuilt = layout(5);
    rebuilt.ledPositions = previous.ledPositions!.map((led) => ({ ...led, x: led.x + 0.01 }));
    expect(keepLedLinksFromOlderApp(rebuilt, sentNothing, previous).tnutLeds).toBeUndefined();
    expect(keepLedLinksFromOlderApp(rebuilt, sentNothing, previous).holdAboveLeds).toBeUndefined();
  });
});
