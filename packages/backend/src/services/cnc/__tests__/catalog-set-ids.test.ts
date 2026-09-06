import { describe, expect, it } from 'vite-plus/test';
import { findCatalogEntry, validateSetIds, type CncCatalogEntry } from '../catalog';

/**
 * `parseSetIds` only says a segment is well-formed. `validateSetIds` is what
 * says it describes THIS wall — which is the check standing between a buyer and
 * a pack drilled for holes their board does not have.
 */

function entryFor(sizeId: number): CncCatalogEntry {
  const entry = findCatalogEntry({ boardName: 'kilter', layoutId: 8, sizeId });
  if (!entry) throw new Error(`no catalogue entry for size ${sizeId}`);
  return entry;
}

// 10x12 has kicker sets and 7x10 does not, so between them they cover both
// branches of every rule below.
const TEN_BY_TWELVE = () => entryFor(25);
const SEVEN_BY_TEN = () => entryFor(17);

describe('validateSetIds', () => {
  it("accepts the entry's own full set list", () => {
    expect(validateSetIds(TEN_BY_TWELVE(), [26, 27, 28, 29])).toEqual({ ok: true, setIds: [26, 27, 28, 29] });
    expect(validateSetIds(SEVEN_BY_TEN(), [26, 27])).toEqual({ ok: true, setIds: [26, 27] });
  });

  it('lets a 12 ft wall drop its kicker', () => {
    expect(validateSetIds(TEN_BY_TWELVE(), [26, 27])).toMatchObject({ ok: true });
  });

  it('rejects a set that belongs to another wall', () => {
    const result = validateSetIds(SEVEN_BY_TEN(), [26, 27, 28]);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('expected a rejection');
    expect(result.errors.join(' ')).toContain('28');
  });

  it('rejects dropping a mandatory set, kicker or not', () => {
    // Auxiliary is not optional on any wall — half the holes would be missing.
    expect(validateSetIds(TEN_BY_TWELVE(), [26, 28, 29])).toMatchObject({ ok: false });
    expect(validateSetIds(SEVEN_BY_TEN(), [26])).toMatchObject({ ok: false });
  });

  it('rejects half a kicker', () => {
    const result = validateSetIds(TEN_BY_TWELVE(), [26, 27, 28]);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('expected a rejection');
    expect(result.errors.join(' ')).toContain('both of its sets');
  });

  it('rejects an empty list rather than reading it as "no kicker"', () => {
    expect(validateSetIds(TEN_BY_TWELVE(), [])).toMatchObject({ ok: false });
  });

  it('accepts the sets in a different order and hands back a sorted list', () => {
    // The order row stores the normalised segment so two buyers who picked
    // the same sets in a different order produce the same config hash.
    expect(validateSetIds(TEN_BY_TWELVE(), [29, 28, 27, 26])).toEqual({ ok: true, setIds: [26, 27, 28, 29] });
  });
});
