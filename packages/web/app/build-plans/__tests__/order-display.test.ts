import { describe, it, expect } from 'vite-plus/test';
import type { CncCatalog, CncOrderStatus } from '@boardsesh/shared-schema';
import {
  finaliseHref,
  isPreviewStatus,
  newestPreviewReadyLicenceId,
  previewImageLabel,
  tierLabel,
  wallLabel,
} from '../order-display';

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
  artworkRules: { maxItems: 4, minWidthMm: 40, maxWidthMm: 1200, maxTextChars: 40, allowedKinds: ['text', 'svg'] },
};

const ORDER_10X12 = { boardName: 'kilter', layoutId: 8, sizeId: 25 };

/** Stands in for `t`: returns the key so the assertion names the catalog entry. */
const translateToKey = (key: string) => key;

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

describe('tierLabel', () => {
  it('calls a bought order by its licence', () => {
    expect(tierLabel('personal', translateToKey)).toBe('tiers.personal.name');
    expect(tierLabel('commercial_single', translateToKey)).toBe('tiers.commercial.name');
  });

  it('calls an unbought order a preview rather than a commercial licence', () => {
    // The whole free half of the lifecycle has a null tier. The old ternary
    // read `tier === 'personal' ? personal : commercial`, which labelled every
    // free preview "Commercial, single build".
    expect(tierLabel(null, translateToKey)).toBe('orders.previewTier');
  });
});

describe('isPreviewStatus', () => {
  it('separates the free half of the lifecycle from the sale', () => {
    for (const status of [
      'preview_queued',
      'preview_generating',
      'preview_ready',
      'preview_failed',
    ] satisfies CncOrderStatus[]) {
      expect({ status, preview: isPreviewStatus(status) }).toEqual({ status, preview: true });
    }
    for (const status of [
      'pending_payment',
      'queued',
      'generating',
      'ready',
      'failed',
      'cancelled',
      'refunded',
    ] satisfies CncOrderStatus[]) {
      expect({ status, preview: isPreviewStatus(status) }).toEqual({ status, preview: false });
    }
  });
});

describe('newestPreviewReadyLicenceId', () => {
  function previewOrder(licenceId: string, createdAt: string, status: CncOrderStatus = 'preview_ready') {
    return { licenceId, status, createdAt };
  }

  it('picks the newest preview waiting to be bought', () => {
    // A buyer who previewed the same wall four times wants to finalise the last
    // one, and a list where every second row shouts is a list where nothing does.
    const licenceId = newestPreviewReadyLicenceId([
      previewOrder('BS-CNC-NEWEST', '2026-09-05T10:00:00.000Z'),
      previewOrder('BS-CNC-OLDER1', '2026-09-01T10:00:00.000Z'),
      previewOrder('BS-CNC-OLDER2', '2026-08-20T10:00:00.000Z'),
    ]);

    expect(licenceId).toBe('BS-CNC-NEWEST');
  });

  it('goes by the date, not by the position in the list', () => {
    // "Newest first" is the server's promise; this decision is too load-bearing
    // to inherit it.
    const licenceId = newestPreviewReadyLicenceId([
      previewOrder('BS-CNC-OLDER1', '2026-09-01T10:00:00.000Z'),
      previewOrder('BS-CNC-NEWEST', '2026-09-05T10:00:00.000Z'),
    ]);

    expect(licenceId).toBe('BS-CNC-NEWEST');
  });

  it('ignores every status that is not waiting on a finalise', () => {
    expect(
      newestPreviewReadyLicenceId([
        previewOrder('BS-CNC-READY0', '2026-09-06T10:00:00.000Z', 'ready'),
        previewOrder('BS-CNC-DRAWIN', '2026-09-06T09:00:00.000Z', 'preview_generating'),
        previewOrder('BS-CNC-BROKEN', '2026-09-06T08:00:00.000Z', 'preview_failed'),
        previewOrder('BS-CNC-WAITIN', '2026-09-02T10:00:00.000Z'),
      ]),
    ).toBe('BS-CNC-WAITIN');
  });

  it('answers null when nothing is waiting', () => {
    expect(newestPreviewReadyLicenceId([])).toBeNull();
    expect(
      newestPreviewReadyLicenceId([previewOrder('BS-CNC-READY0', '2026-09-06T10:00:00.000Z', 'ready')]),
    ).toBeNull();
  });

  it('skips a row whose date will not parse rather than crowning it', () => {
    expect(
      newestPreviewReadyLicenceId([
        previewOrder('BS-CNC-JUNKDT', 'not a date'),
        previewOrder('BS-CNC-GOODDT', '2026-09-02T10:00:00.000Z'),
      ]),
    ).toBe('BS-CNC-GOODDT');
  });
});

describe('finaliseHref', () => {
  it('sends the buyer to the configurator with the order to resume', () => {
    expect(finaliseHref('BS-CNC-K7QM3T')).toBe('/build-plans?order=BS-CNC-K7QM3T');
  });

  it('encodes anything that would break out of the query string', () => {
    expect(finaliseHref('BS CNC&x=1')).toBe('/build-plans?order=BS%20CNC%26x%3D1');
  });
});

describe('previewImageLabel', () => {
  it('captions the sheets rather than printing their filenames', () => {
    expect(previewImageLabel('panel1.png', (key, options) => `${key}:${String(options?.number)}`)).toBe(
      'order.preview.panel:1',
    );
    expect(previewImageLabel('assembly.png', (key) => key)).toBe('order.preview.assembly');
  });

  it('falls back to the basename for a sheet it has no name for', () => {
    // A sheet the generator starts writing under a new name still has to be
    // captioned; disappearing would be the worse answer.
    expect(previewImageLabel('kicker_detail.png', (key) => key)).toBe('kicker_detail');
  });
});
