import { describe, expect, it } from 'vitest';
import {
  createLedStripes,
  DEFAULT_TNUT_CORNERS,
  generateTnutGrid,
  type TnutLayout,
} from '@boardsesh/spray-wall-geometry';
import { expandCableUnits, mapCableUnitsById } from '../spray-led-units';

function fixture(): TnutLayout {
  const basis: TnutLayout = {
    version: 1,
    pattern: 'grid',
    rows: 2,
    columns: 2,
    firstRowOffset: false,
    corners: DEFAULT_TNUT_CORNERS,
    holes: [],
    photoKey: 'photo',
  };
  basis.holes = generateTnutGrid({ ...basis, pattern: 'grid' });
  const result = createLedStripes(basis, 'vertical', 3);
  if (result === 'capacity') throw new Error('Fixture exceeds capacity');
  return result;
}

describe('indivisible cable units', () => {
  it('expands either end or an interior marker into the whole ordered stripe', () => {
    const layout = fixture();
    const unit = layout.ledStripes!.stripes[0].ledIds;
    const units = mapCableUnitsById(layout);
    const protectedIds = new Set(unit);
    expect(expandCableUnits([unit[0], unit[1]], units, new Set(), protectedIds)).toEqual(unit);
    expect(expandCableUnits([unit[2]], units, new Set(), protectedIds)).toEqual([...unit].reverse());
  });

  it('never fills only the unwired half of a corrupted stripe', () => {
    const layout = fixture();
    const unit = layout.ledStripes!.stripes[0].ledIds;
    expect(expandCableUnits(unit, mapCableUnitsById(layout), new Set([unit[0]]), new Set(unit))).toEqual([]);
  });

  it('keeps singles and older partly wired pairs available without splitting stripes', () => {
    const pairs = new Map([
      ['a', ['a', 'b']],
      ['b', ['a', 'b']],
    ]);
    expect(expandCableUnits(['a', 'c'], pairs, new Set(['a']), new Set())).toEqual(['b', 'c']);
  });

  it('handles a drag over all 6000 members as one complete stripe', () => {
    const ids = Array.from({ length: 6000 }, (_, index) => `led-${index}`);
    const units = new Map(ids.map((id) => [id, ids]));
    expect(expandCableUnits(ids, units, new Set(), new Set(ids))).toEqual(ids);
  });
});
