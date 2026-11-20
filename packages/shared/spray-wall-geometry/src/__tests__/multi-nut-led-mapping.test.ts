import { describe, expect, it } from 'vitest';
import {
  buildSprayLedMapping,
  clearSprayHoldLedSelection,
  clearTnutLedLink,
  createLedStripes,
  createWiring,
  DEFAULT_TNUT_CORNERS,
  generateLedPositions,
  generateTnutGrid,
  migrateHoldLedLinksToTnuts,
  prepareSprayNutLedEdit,
  readTnutLayout,
  setHoldLedLink,
  setSprayHoldLedSelection,
  setTnutLedLink,
  type CanonicalSprayHold,
  type TnutLayout,
} from '../index';

const frame = { width: 1000, height: 600 };
const grip: CanonicalSprayHold = { id: 1, cx: 500, cy: 240, r: 130, outline: [-0.1, -1, 0.1, -1, 0.1, 1, -0.1, 1] };
function wall(): TnutLayout {
  const configured: TnutLayout = {
    version: 1,
    pattern: 'custom',
    rows: 5,
    columns: 1,
    firstRowOffset: false,
    corners: DEFAULT_TNUT_CORNERS,
    holes: [0.1, 0.3, 0.5, 0.7, 0.9].map((y) => ({ x: 0.5, y })),
    photoKey: 'photo',
    ledPlacement: 'below',
  };
  configured.ledPositions = generateLedPositions(configured);
  configured.wiring = createWiring(configured.ledPositions, 'horizontal', 'tl', configured);
  return configured;
}
const at = (layout: TnutLayout, index: number) => layout.ledPositions![index].id;

describe('hold areas covering multiple mounting nuts', () => {
  it('uses only the lowest primary and highest upper nut in a covered vertical chain', () => {
    const configured = wall();
    const mapping = buildSprayLedMapping(configured, frame, [grip]);
    expect(mapping.holds[0]).toMatchObject({
      holeIndices: [1, 2],
      ledIds: [at(configured, 2)],
      aboveLedIds: [at(configured, 0)],
    });
    // The selected lower slot is valid even if the grip's contour extends beyond it.
    expect(configured.ledPositions![2].y * frame.height).toBeLessThan(grip.cy + grip.r);
    expect(mapping.holes[1].ledIds).toEqual([at(configured, 1)]);
    const missing = {
      ...configured,
      ledPositions: configured.ledPositions!.filter((led) => led.id !== at(configured, 2)),
    };
    expect(buildSprayLedMapping(missing, frame, [grip]).holds[0].ledIds).toEqual([]);
    const manuallyInside = setTnutLedLink(configured, 1, [at(configured, 1)]);
    expect(buildSprayLedMapping(manuallyInside, frame, [grip]).holds[0].ledIds).toEqual([
      at(configured, 1),
      at(configured, 2),
    ]);
  });

  it('retains a different hold’s main LED as the same physical optional upper LED', () => {
    const configured = wall();
    const mapping = buildSprayLedMapping(configured, frame, [{ id: 2, cx: 500, cy: 60, r: 20 }, grip]);
    expect(mapping.holds[0].ledIds).toEqual([at(configured, 0)]);
    expect(mapping.holds[1].aboveLedIds).toEqual([at(configured, 0)]);
  });

  it('keeps one lower and one upper LED in every covered column', () => {
    const configured = wall();
    configured.holes = [0.3, 0.7].flatMap((x) => [0.1, 0.3, 0.5, 0.7, 0.9].map((y) => ({ x, y })));
    configured.ledPositions = generateLedPositions(configured);
    const wide = { ...grip, r: 300, outline: [-0.8, -0.43, 0.8, -0.43, 0.8, 0.43, -0.8, 0.43] };
    const mapped = buildSprayLedMapping(configured, frame, [wide]).holds[0];
    expect(mapped.holeIndices).toEqual([1, 2, 6, 7]);
    expect(mapped.ledIds).toEqual([at(configured, 2), at(configured, 7)]);
    expect(mapped.aboveLedIds).toEqual([at(configured, 0), at(configured, 5)]);
  });

  it('leaves equal-fit automatic LED ownership unassigned rather than sharing it', () => {
    const configured = wall();
    configured.pattern = 'grid';
    configured.rows = 3;
    configured.columns = 3;
    configured.ledPositions = [{ id: 'equidistant', x: 0.5, y: 0.7 }];
    for (const holes of [
      [
        { x: 0.49, y: 0.5 },
        { x: 0.51, y: 0.5 },
      ],
      [
        { x: 0.51, y: 0.5 },
        { x: 0.49, y: 0.5 },
      ],
    ]) {
      const mapping = buildSprayLedMapping({ ...configured, holes }, frame, []);
      expect(mapping.holes.flatMap((entry) => entry.ledIds)).toEqual([]);
    }
  });

  it('distributes a whole-grip choice once per LED so later small holds inherit only their nut', () => {
    const configured = wall();
    const selected = [at(configured, 1), at(configured, 2)];
    const linked = setSprayHoldLedSelection(configured, frame, [grip], 1, selected);
    expect(linked.tnutLeds).toEqual([
      { hole: configured.holes[1], ledIds: [selected[0]] },
      { hole: configured.holes[2], ledIds: [selected[1]] },
    ]);
    const children = [
      { id: 100, cx: 500, cy: 180, r: 20 },
      { id: 200, cx: 500, cy: 300, r: 20 },
    ];
    expect(buildSprayLedMapping(linked, frame, children).holds.map((hold) => hold.ledIds)).toEqual([
      [selected[0]],
      [selected[1]],
    ]);
    expect(clearSprayHoldLedSelection(linked, frame, [grip], 1).tnutLeds).toEqual([]);
    expect(readTnutLayout(JSON.parse(JSON.stringify(linked)))).toEqual(linked);
  });

  it('preserves a chosen nut association for retained LEDs and removes choices from all covered roles', () => {
    const configured = setTnutLedLink(wall(), 2, [at(wall(), 0)]);
    const selected = [at(configured, 0), at(configured, 1)];
    const linked = setSprayHoldLedSelection(configured, frame, [grip], 1, selected);
    expect(linked.tnutLeds!.find((entry) => entry.hole.y === 0.5)!.ledIds).toEqual([selected[0]]);
    const removed = setSprayHoldLedSelection(linked, frame, [grip], 1, [selected[1]]);
    expect(removed.tnutLeds!.find((entry) => entry.hole.y === 0.5)!.ledIds).toEqual([]);
    const upper = setTnutLedLink(removed, 1, [at(configured, 0)], 'above');
    const reset = clearSprayHoldLedSelection(upper, frame, [grip], 1);
    expect(reset.tnutLeds).toEqual([{ hole: configured.holes[1], aboveLedIds: [at(configured, 0)] }]);
  });

  it('preserves effective siblings, including empty and externally claimed legacy roles, before one nut edit', () => {
    const configured = wall();
    const hidden = at(configured, 0);
    const legacy = setHoldLedLink(setTnutLedLink(configured, 4, [hidden]), 1, [hidden, at(configured, 2)]);
    const before = buildSprayLedMapping(legacy, frame, [grip]);
    expect(before.holes[1].ledIds).toEqual([]);
    const prepared = prepareSprayNutLedEdit(legacy, frame, [grip], 2);
    const edited = setTnutLedLink(prepared, 2, []);
    const after = buildSprayLedMapping(edited, frame, [grip]);
    expect(after.holes[1].ledIds).toEqual(before.holes[1].ledIds);
    expect(after.holes[4].ledIds).toEqual([hidden]);
    expect(prepared.holdLeds).toEqual([]);
    const explicitSibling = setTnutLedLink(legacy, 1, []);
    expect(
      prepareSprayNutLedEdit(explicitSibling, frame, [grip], 2).tnutLeds!.find((entry) => entry.hole.y === 0.3)!.ledIds,
    ).toEqual([]);
    expect(clearTnutLedLink(prepared, 2).tnutLeds!.find((entry) => entry.hole.y === 0.3)!.ledIds).toEqual([]);
  });

  it('migrates unambiguous legacy multi-nut provenance without changing the selected union', () => {
    const configured = setHoldLedLink(wall(), 1, [at(wall(), 1), at(wall(), 2)]);
    const before = buildSprayLedMapping(configured, frame, [grip]).holds[0].ledIds;
    const migrated = migrateHoldLedLinksToTnuts(configured, frame, [grip]);
    expect(migrated.holdLeds).toEqual([]);
    expect(migrated.tnutLeds).toHaveLength(2);
    expect(buildSprayLedMapping(migrated, frame, [{ ...grip, id: 900 }]).holds[0].ledIds).toEqual(before);
    const conflicted = setTnutLedLink(configured, 1, []);
    expect(migrateHoldLedLinksToTnuts(conflicted, frame, [grip])).toBe(conflicted);
  });

  it('keeps all6000 selected stripe LEDs across multiple nuts without truncating the choice', () => {
    const basis: TnutLayout = { ...wall(), pattern: 'grid', columns: 1, rows: 3, corners: DEFAULT_TNUT_CORNERS };
    basis.holes = generateTnutGrid({ ...basis, pattern: 'grid' });
    const striped = createLedStripes(basis, 'vertical', 6000);
    if (striped === 'capacity') throw new Error('Expected stripe');
    const large = { id: 20, cx: 100, cy: 300, r: 260 };
    const selected = striped.ledPositions!.map((led) => led.id);
    const linked = setSprayHoldLedSelection(striped, frame, [large], 20, selected);
    const assignments = linked.tnutLeds!.flatMap((entry) => entry.ledIds ?? []);
    expect(assignments).toHaveLength(6000);
    expect(new Set(assignments).size).toBe(6000);
    expect(buildSprayLedMapping(linked, frame, [large]).holds[0].ledIds).toHaveLength(6000);
    expect(readTnutLayout(linked)).toEqual(linked);
  });
});
