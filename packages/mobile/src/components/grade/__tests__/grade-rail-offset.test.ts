import { describe, expect, it } from 'vitest';
import { railRestOffset, railSnapOffsets, type RailChipLayout } from '../grade-rail-offset';

// A rail of eight 52pt chips with an 8pt gap behind a 16pt lead-in, laid out the
// way the ScrollView measures them: x is the chip's start inside the content.
const LEAD_IN = 16;
const CHIP_WIDTH = 52;
const CHIP_GAP = 8;
const CHIP_COUNT = 8;
const RAIL_WIDTH = 200;

function buildLayouts(count = CHIP_COUNT): Record<number, RailChipLayout> {
  const layouts: Record<number, RailChipLayout> = {};
  for (let index = 0; index < count; index += 1) {
    layouts[index] = { x: LEAD_IN + index * (CHIP_WIDTH + CHIP_GAP), width: CHIP_WIDTH };
  }
  return layouts;
}

// Trailing inset included, matching the content container's paddingRight.
const CONTENT_WIDTH = LEAD_IN + CHIP_COUNT * (CHIP_WIDTH + CHIP_GAP) - CHIP_GAP + 24;

describe('railSnapOffsets', () => {
  it('returns each chip start pulled back by the lead-in, ascending', () => {
    expect(railSnapOffsets(buildLayouts(3), LEAD_IN)).toEqual([0, 60, 120]);
  });

  it('never returns a negative offset when a chip starts inside the lead-in', () => {
    const offsets = railSnapOffsets({ 0: { x: 4, width: CHIP_WIDTH } }, LEAD_IN);
    expect(offsets.every((offset) => offset >= 0)).toBe(true);
  });

  it('is empty with nothing measured', () => {
    expect(railSnapOffsets({}, LEAD_IN)).toEqual([]);
  });
});

describe('railRestOffset', () => {
  const baseArgs = {
    layouts: buildLayouts(),
    railWidth: RAIL_WIDTH,
    contentWidth: CONTENT_WIDTH,
    leadIn: LEAD_IN,
  };

  it('rests at 0 on the first chip rather than scrolling negative', () => {
    expect(railRestOffset({ ...baseArgs, focusId: 0 })).toBe(0);
  });

  it('rests at the end of the scrollable range on the last chip, snapped to a chip start', () => {
    const offset = railRestOffset({ ...baseArgs, focusId: CHIP_COUNT - 1 });
    const maxOffset = CONTENT_WIDTH - RAIL_WIDTH;
    expect(offset).not.toBeNull();
    expect(offset).toBeLessThanOrEqual(maxOffset);
    // The greatest chip start at or before the end of the range — this is the
    // case that used to slice the selected chip flat against x=0.
    expect(offset).toBe(
      railSnapOffsets(baseArgs.layouts, LEAD_IN)
        .filter((candidate) => candidate <= maxOffset)
        .at(-1),
    );
  });

  it('never rests mid-chip: every offset is a chip start', () => {
    const snaps = railSnapOffsets(baseArgs.layouts, LEAD_IN);
    for (let focusId = 0; focusId < CHIP_COUNT; focusId += 1) {
      const offset = railRestOffset({ ...baseArgs, focusId });
      expect(offset).not.toBeNull();
      expect(snaps).toContain(offset);
    }
  });

  it('never returns a negative offset for any focus chip', () => {
    for (let focusId = 0; focusId < CHIP_COUNT; focusId += 1) {
      expect(railRestOffset({ ...baseArgs, focusId })).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns null when the focus chip has not been measured', () => {
    expect(railRestOffset({ ...baseArgs, focusId: 99 })).toBeNull();
  });

  it('returns null when there is no focus chip', () => {
    expect(railRestOffset({ ...baseArgs, focusId: undefined })).toBeNull();
  });

  it('returns null before the rail has been laid out', () => {
    expect(railRestOffset({ ...baseArgs, focusId: 3, railWidth: 0 })).toBeNull();
  });

  it('rests at 0 when the content is shorter than the rail', () => {
    expect(railRestOffset({ ...baseArgs, focusId: CHIP_COUNT - 1, contentWidth: RAIL_WIDTH - 40 })).toBe(0);
  });
});
