import { describe, it, expect } from 'vite-plus/test';
import { getSetsForLayoutAndSize } from '@boardsesh/board-constants';
import {
  CNC_CATALOG,
  CNC_CATALOG_VERSION,
  findCatalogEntry,
  parseSetIds,
  validateCatalogOptions,
  validateSetIds,
} from '../catalog';

// The catalogue is the gate between a URL tuple and a purchasable pack, so
// these tests care about two things: that nothing outside it can be bought, and
// that an order's stored options are always the complete, catalogue-owned set
// rather than whatever the client happened to send.

const KILTER_HOMEWALL_10X12 = { boardName: 'kilter', layoutId: 8, sizeId: 25 };

function entryFor(sizeId: number) {
  const entry = findCatalogEntry({ boardName: 'kilter', layoutId: 8, sizeId });
  if (!entry) throw new Error(`no catalogue entry for size ${sizeId}`);
  return entry;
}

describe('CNC catalogue', () => {
  it('sells exactly the four canonical Kilter Homewall sizes', () => {
    expect(CNC_CATALOG.map((entry) => entry.sizeId)).toEqual([17, 21, 23, 25]);
    expect(CNC_CATALOG.map((entry) => entry.label)).toEqual(['7x10', '10x10', '8x12', '10x12']);
    expect(CNC_CATALOG.every((entry) => entry.boardName === 'kilter' && entry.layoutId === 8)).toBe(true);
  });

  it('has a version string orders can be pinned to', () => {
    expect(CNC_CATALOG_VERSION).toBe('2026-09-06.1');
  });

  it('takes its default set ids from board-constants rather than a second hardcoded list', () => {
    for (const entry of CNC_CATALOG) {
      const expected = getSetsForLayoutAndSize('kilter', 8, entry.sizeId)
        .map((set) => set.id)
        .join(',');
      expect(entry.setIds).toBe(expected);
    }
    expect(entryFor(17).setIds).toBe('26,27');
    expect(entryFor(25).setIds).toBe('26,27,28,29');
  });

  it('marks a kicker optional only on the 12 ft walls that have one', () => {
    expect(entryFor(17).kickerOptional).toBe(false);
    expect(entryFor(21).kickerOptional).toBe(false);
    expect(entryFor(23).kickerOptional).toBe(true);
    expect(entryFor(25).kickerOptional).toBe(true);
  });

  it('prices both tiers in AUD against their Stripe price env vars', () => {
    const tiers = entryFor(25).tiers;
    expect(tiers).toEqual([
      { tier: 'personal', priceCents: 14900, currency: 'AUD', stripePriceEnv: 'STRIPE_PRICE_CNC_PERSONAL' },
      {
        tier: 'commercial_single',
        priceCents: 75000,
        currency: 'AUD',
        stripePriceEnv: 'STRIPE_PRICE_CNC_COMMERCIAL',
      },
    ]);
  });
});

describe('findCatalogEntry', () => {
  it('resolves a canonical size id', () => {
    expect(findCatalogEntry(KILTER_HOMEWALL_10X12)?.label).toBe('10x12');
  });

  it.each([
    [18, '7x10'],
    [19, '7x10'],
    [22, '10x10'],
    [29, '10x10'],
    [24, '8x12'],
    [26, '10x12'],
  ])('resolves LED-kit size %i onto the %s wall', (sizeId, label) => {
    const entry = findCatalogEntry({ boardName: 'kilter', layoutId: 8, sizeId });
    expect(entry?.label).toBe(label);
    // The entry keeps its canonical id: the alias is an input, never stored.
    expect(entry?.sizeAliases).toContain(sizeId);
  });

  it('returns null for a board, layout or size that is not on sale', () => {
    expect(findCatalogEntry({ boardName: 'tension', layoutId: 8, sizeId: 25 })).toBeNull();
    expect(findCatalogEntry({ boardName: 'kilter', layoutId: 1, sizeId: 25 })).toBeNull();
    expect(findCatalogEntry({ boardName: 'kilter', layoutId: 8, sizeId: 999 })).toBeNull();
  });
});

describe('validateCatalogOptions', () => {
  const entry = entryFor(25);

  it('fills every missing option with its default', () => {
    const result = validateCatalogOptions(entry, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options).toEqual({
      sheetStock: '2440x1220',
      panelThicknessMm: 18,
      tnutHoleDiameterMm: 12.5,
      ledHoleDiameterMm: 12.5,
      kickerMatClearanceMm: 50,
      studClearanceOffsetMm: 60,
      gridPitchMm: 100,
      dxfFlavour: 'R12_circles',
      paper: 'A3',
      engraveHoldIds: false,
      engraveAngleTicks: false,
    });
  });

  it('keeps chosen values and still returns the complete set', () => {
    const result = validateCatalogOptions(entry, { panelThicknessMm: 21, dxfFlavour: 'R2010_polylines' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options.panelThicknessMm).toBe(21);
    expect(result.options.dxfFlavour).toBe('R2010_polylines');
    expect(Object.keys(result.options)).toHaveLength(entry.manufacturingOptions.length);
  });

  it('normalises transport-flattened values onto the catalogue value', () => {
    const result = validateCatalogOptions(entry, { panelThicknessMm: '15', engraveHoldIds: 'true' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options.panelThicknessMm).toBe(15);
    expect(result.options.engraveHoldIds).toBe(true);
  });

  it('rejects a value outside the allowed set instead of clamping it', () => {
    const result = validateCatalogOptions(entry, { tnutHoleDiameterMm: 14 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      {
        key: 'tnutHoleDiameterMm',
        code: 'invalid_value',
        message: '"tnutHoleDiameterMm" must be one of: 11.1, 12, 12.5, 13.',
      },
    ]);
  });

  it('rejects an unknown option rather than silently dropping it', () => {
    const result = validateCatalogOptions(entry, { wallColour: 'purple' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ key: 'wallColour', code: 'unknown_option' });
  });

  it('collects every error in one pass', () => {
    const result = validateCatalogOptions(entry, { wallColour: 'purple', paper: 'A0', gridPitchMm: 42 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.key).sort()).toEqual(['gridPitchMm', 'paper', 'wallColour']);
  });

  it.each([['not an object'], [42], [null], [['a']]])('rejects a non-object payload (%p)', (options) => {
    const result = validateCatalogOptions(entry, options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('not_an_object');
  });
});

describe('validateSetIds', () => {
  it('rejects a set id that is not part of the size (7x10 has no kicker at all)', () => {
    const result = validateSetIds(entryFor(17), [26, 27, 28]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(["Set 28 is not part of this size's catalogue entry."]);
  });

  it('allows the 10x12 kicker sets to be left off since the kicker is optional there', () => {
    const result = validateSetIds(entryFor(25), [26, 27]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.setIds).toEqual([26, 27]);
  });

  it('accepts the 8x12 wall with every one of its sets, including the kicker', () => {
    const result = validateSetIds(entryFor(23), [26, 27, 28, 29]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.setIds).toEqual([26, 27, 28, 29]);
  });

  it('rejects a duplicated set id', () => {
    const result = validateSetIds(entryFor(25), [26, 26, 27]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(['Set 26 was submitted more than once.']);
  });

  it('rejects a mainline set left off a wall where it is not optional', () => {
    const result = validateSetIds(entryFor(17), [26]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(['Set 27 is required for this size.']);
  });

  it('sorts the result regardless of submission order', () => {
    const result = validateSetIds(entryFor(25), [27, 26]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.setIds).toEqual([26, 27]);
  });
});

describe('parseSetIds', () => {
  it('parses a comma-joined URL segment in order', () => {
    expect(parseSetIds('26,27')).toEqual([26, 27]);
    expect(parseSetIds('26,27,28,29')).toEqual([26, 27, 28, 29]);
    expect(parseSetIds('27')).toEqual([27]);
  });

  it('tolerates whitespace around the ids', () => {
    expect(parseSetIds(' 26 , 27 ')).toEqual([26, 27]);
  });

  it.each([[''], ['26,'], ['26,,27'], ['26,abc'], ['-26'], ['26.5'], ['26,26']])(
    'returns null for the malformed segment %p',
    (segment) => {
      expect(parseSetIds(segment)).toBeNull();
    },
  );
});
