import { describe, it, expect } from 'vite-plus/test';
import type { CncCatalog } from '@boardsesh/shared-schema';
import { orderStatusChipColor, wallLabel } from '../order-display';

function catalogEntry(sizeId: number, label: string) {
  return {
    boardName: 'kilter',
    layoutId: 8,
    sizeId,
    setIds: '26,27,28,29',
    label,
    kickerOptional: true,
    manufacturingOptions: [],
    tiers: [],
  };
}

const CATALOG: CncCatalog = {
  version: '2026-09-06.1',
  entries: [catalogEntry(25, '10x12'), catalogEntry(23, '8x12')],
  artworkFonts: ['liberation-sans'],
  artworkRules: { maxItems: 4, minWidthMm: 40, maxWidthMm: 1200, maxTextChars: 40 },
};

const ORDER_10X12 = { boardName: 'kilter', layoutId: 8, sizeId: 25 };

describe('wallLabel', () => {
  it('uses the catalogue label when the entry is still on sale', () => {
    expect(wallLabel(CATALOG, ORDER_10X12)).toBe('10x12');
  });

  it('falls back to the size id when the entry has been retired', () => {
    // A licence outlives the catalogue. Blanking the wall on an order somebody
    // paid for would be the worst possible answer to a retired entry, and "25"
    // is still enough for a buyer to recognise their own.
    expect(wallLabel(CATALOG, { ...ORDER_10X12, sizeId: 17 })).toBe('17');
  });

  it('falls back when the catalogue could not be fetched at all', () => {
    expect(wallLabel(null, ORDER_10X12)).toBe('25');
  });

  it('matches on the whole tuple, not the size id alone', () => {
    // Size ids are per-board, so a Tension 25 is not a Kilter 25 and must not
    // borrow its label.
    expect(wallLabel(CATALOG, { ...ORDER_10X12, boardName: 'tension' })).toBe('25');
    expect(wallLabel(CATALOG, { ...ORDER_10X12, layoutId: 1 })).toBe('25');
  });
});

describe('orderStatusChipColor', () => {
  it('reads each status as a verdict rather than a stage', () => {
    expect(orderStatusChipColor('ready')).toBe('success');
    expect(orderStatusChipColor('queued')).toBe('info');
    expect(orderStatusChipColor('generating')).toBe('info');
    expect(orderStatusChipColor('failed')).toBe('error');
    // Nothing broke — the download is simply switched off.
    expect(orderStatusChipColor('refunded')).toBe('warning');
    // Nobody was charged, so a lapsed checkout is not a problem at all.
    expect(orderStatusChipColor('cancelled')).toBe('default');
    expect(orderStatusChipColor('pending_payment')).toBe('default');
  });
});
