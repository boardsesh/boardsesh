import { describe, expect, it } from 'vitest';
import {
  buildSprayLedMapping,
  clearHoldLedLink,
  createWiring,
  DEFAULT_TNUT_CORNERS,
  generateLedPositions,
  generateTnutGrid,
  readTnutLayout,
  setHoldLedLink,
  type CanonicalSprayHold,
  type TnutLayout,
} from '../index';

const frame = { width: 1000, height: 600 };
function layout(): TnutLayout {
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
  };
  configured.ledPositions = generateLedPositions(configured);
  configured.wiring = createWiring(configured.ledPositions, 'horizontal', 'tl', configured);
  return configured;
}
// Hold 1 covers the centre hole (LED 4); hold 2 the top-left hole (LED 0).
const holds: CanonicalSprayHold[] = [
  { id: 1, cx: 500, cy: 300, r: 35 },
  { id: 2, cx: 100, cy: 60, r: 35 },
];
const ledAt = (configured: TnutLayout, index: number) => configured.ledPositions![index].id;

describe('hand-made hold to LED links', () => {
  it('give a hold exactly its chosen LEDs and take them from the hold the geometry picked', () => {
    const configured = layout();
    const auto = buildSprayLedMapping(configured, frame, holds);
    expect(auto.holds.map((hold) => hold.indices)).toEqual([[4], [0]]);
    const linked = setHoldLedLink(configured, 2, [ledAt(configured, 4), ledAt(configured, 0)]);
    const mapping = buildSprayLedMapping(linked, frame, holds);
    expect(mapping.holds[1]).toMatchObject({ holdId: 2, indices: [0, 4] });
    expect(mapping.holds[0]).toMatchObject({ holdId: 1, indices: [], ledIds: [] });
    // Holes keep their geometric LEDs: the Holes test view is about mounting holes.
    expect(mapping.holes[4].indices).toEqual([4]);
  });

  it('can mark a hold as having no LED, and give it back to the automatic mapping', () => {
    const configured = layout();
    const none = setHoldLedLink(configured, 1, []);
    expect(buildSprayLedMapping(none, frame, holds).holds[0].indices).toEqual([]);
    const restored = clearHoldLedLink(none, 1);
    expect(restored.holdLeds).toBeUndefined();
    expect(buildSprayLedMapping(restored, frame, holds).holds[0].indices).toEqual([4]);
  });

  it('replaces an earlier link for the same hold and ignores links to holds the wall no longer has', () => {
    const configured = layout();
    const twice = setHoldLedLink(setHoldLedLink(configured, 1, [ledAt(configured, 1)]), 1, [ledAt(configured, 2)]);
    expect(twice.holdLeds).toEqual([{ holdId: 1, ledIds: [ledAt(configured, 2)] }]);
    const stale = setHoldLedLink(configured, 99, [ledAt(configured, 4)]);
    expect(buildSprayLedMapping(stale, frame, holds).holds[0].indices).toEqual([4]);
  });

  it('survive a save and load, dropping LEDs that no longer exist', () => {
    const configured = setHoldLedLink(layout(), 1, [ledAt(layout(), 3)]);
    const stored = JSON.parse(
      JSON.stringify({
        ...configured,
        holdLeds: [
          { holdId: 1, ledIds: [ledAt(configured, 3), 'removed-led'] },
          { holdId: 2, ledIds: [] },
        ],
      }),
    );
    expect(readTnutLayout(stored)?.holdLeds).toEqual([
      { holdId: 1, ledIds: [ledAt(configured, 3)] },
      { holdId: 2, ledIds: [] },
    ]);
    expect(readTnutLayout({ ...stored, holdLeds: [{ holdId: 'one', ledIds: [] }] })).toBeNull();
    expect(readTnutLayout({ ...stored, holdLeds: [{ holdId: 1, ledIds: [7] }] })).toBeNull();
    expect(readTnutLayout({ ...stored, holdLeds: {} })).toBeNull();
    expect(readTnutLayout({ ...stored, holdLeds: [] })?.holdLeds).toBeUndefined();
  });
});
