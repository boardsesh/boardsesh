import { describe, it, expect } from 'vite-plus/test';
import { computeCncConfigHash, orderConfigHash, type CncHashableConfig } from '../config-hash';

/**
 * The dedupe key.
 *
 * Two properties matter and they pull against each other: the same wall must
 * hash the same however the client happened to serialise it, and any change the
 * buyer can see in the preview must hash differently. Everything below is one
 * of those two.
 */

const BASE: CncHashableConfig = {
  boardName: 'kilter',
  layoutId: 8,
  sizeId: 25,
  setIds: '26,27,28,29',
  options: { sheetStock: '2440x1220', panelThicknessMm: 18, engraveHoldIds: true },
  artwork: null,
};

const PLACEMENT = { panelIndex: 0, xMm: 600, yMm: 400, widthMm: 300, rotationDeg: 0 };

describe('computeCncConfigHash', () => {
  it('is 64 lowercase hex characters', () => {
    expect(computeCncConfigHash(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on the order the option keys were written in', () => {
    const reordered = {
      ...BASE,
      options: { engraveHoldIds: true, panelThicknessMm: 18, sheetStock: '2440x1220' },
    };
    expect(computeCncConfigHash(reordered)).toBe(computeCncConfigHash(BASE));
  });

  it('treats no artwork and an empty artwork list as the same wall', () => {
    expect(computeCncConfigHash({ ...BASE, artwork: [] })).toBe(computeCncConfigHash(BASE));
  });

  it.each<[string, Partial<CncHashableConfig>]>([
    ['a different board', { boardName: 'tension' }],
    ['a different layout', { layoutId: 9 }],
    ['a different size', { sizeId: 26 }],
    ['a kicker left off', { setIds: '26,27' }],
    ['a changed option', { options: { ...BASE.options, panelThicknessMm: 21 } }],
  ])('changes for %s', (_label, override) => {
    expect(computeCncConfigHash({ ...BASE, ...override })).not.toBe(computeCncConfigHash(BASE));
  });

  it('changes when a piece of artwork moves by a millimetre', () => {
    const placed = { ...BASE, artwork: [{ assetId: 'asset-1', mode: 'engrave', placement: PLACEMENT }] };
    const moved = {
      ...BASE,
      artwork: [{ assetId: 'asset-1', mode: 'engrave', placement: { ...PLACEMENT, xMm: 601 } }],
    };
    expect(computeCncConfigHash(moved)).not.toBe(computeCncConfigHash(placed));
  });

  it('ignores the asset key and mime, which are looked up rather than chosen', () => {
    // Re-uploading the identical file gets a new key. That is not a different
    // wall, and treating it as one would make every re-upload cost a preview.
    const withKey = {
      ...BASE,
      artwork: [
        { assetId: 'asset-1', assetKey: 'cnc-art/user-1/asset-1.svg', mime: 'image/svg+xml', placement: PLACEMENT },
      ],
    };
    const withOtherKey = {
      ...BASE,
      artwork: [
        { assetId: 'asset-1', assetKey: 'cnc-art/user-1/asset-9.svg', mime: 'image/svg+xml', placement: PLACEMENT },
      ],
    };
    expect(computeCncConfigHash(withOtherKey)).toBe(computeCncConfigHash(withKey));
  });

  it('changes when the artwork items are swapped, because the gallery order changes with them', () => {
    const first = { text: 'Send it', mode: 'engrave', placement: PLACEMENT };
    const second = { text: 'Crimp', mode: 'engrave', placement: { ...PLACEMENT, panelIndex: 1 } };
    expect(computeCncConfigHash({ ...BASE, artwork: [second, first] })).not.toBe(
      computeCncConfigHash({ ...BASE, artwork: [first, second] }),
    );
  });
});

describe('orderConfigHash', () => {
  it('uses the stored hash when the row has one', () => {
    expect(orderConfigHash({ ...BASE, configHash: 'stored' })).toBe('stored');
  });

  it('computes one for a row written before the column existed', () => {
    // This is what lets `CncOrder.configHash` stay non-null for orders bought
    // before previews, rather than leaving a hole in the middle of the list.
    expect(orderConfigHash({ ...BASE, configHash: null })).toBe(computeCncConfigHash(BASE));
  });
});
