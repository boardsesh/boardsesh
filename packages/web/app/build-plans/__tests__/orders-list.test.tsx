import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import type { CncOrder, CncOrderStatus } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog('cnc', key, options),
    locale: 'en-US',
  })),
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const OrdersList = (await import('../orders/orders-list')).default;

function order(overrides: Partial<CncOrder> = {}): CncOrder {
  return {
    id: '1',
    licenceId: 'BS-CNC-K7QM3T',
    tier: 'personal',
    status: 'ready',
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27,28,29',
    options: {},
    artwork: [],
    licenseeName: 'Sam Bouldering',
    customerSiteName: null,
    amountCents: 14900,
    currency: 'AUD',
    createdAt: '2026-09-01T02:14:11.402Z',
    paidAt: '2026-09-01T02:15:00.000Z',
    generatedAt: '2026-09-01T02:17:00.000Z',
    zipSizeBytes: 4_200_000,
    downloadCount: 0,
    lastDownloadedAt: null,
    errorMessage: null,
    hasPreview: true,
    previewGeneratedAt: '2026-09-01T02:14:40.000Z',
    previewImages: [],
    configHash: 'a1b2c3',
    ...overrides,
  };
}

function preview(licenceId: string, createdAt: string, status: CncOrderStatus = 'preview_ready'): CncOrder {
  return order({ licenceId, createdAt, status, tier: null, paidAt: null, zipSizeBytes: null, amountCents: null });
}

async function renderList(orders: readonly CncOrder[]) {
  return render(await OrdersList({ orders, catalog: null, locale: 'en-US' }));
}

describe('OrdersList', () => {
  it('invites the buyer to configure a wall instead of showing an empty box', async () => {
    await renderList([]);

    expect(screen.getByText('No walls here yet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Configure a wall' }).getAttribute('href')).toBe('/build-plans');
  });

  it('offers Finalise on the newest preview and Open on everything else', async () => {
    // The accent rule and the Finalise link are the same decision in the row —
    // `isFinalisable` drives both — so the single Finalise link IS the assertion
    // that exactly one row is accented, and which one.
    await renderList([
      preview('BS-CNC-NEWEST', '2026-09-05T10:00:00.000Z'),
      preview('BS-CNC-OLDER1', '2026-09-01T10:00:00.000Z'),
      order({ licenceId: 'BS-CNC-PAID01', status: 'ready' }),
    ]);

    const finalise = screen.getAllByRole('link', { name: 'Finalise' });
    expect(finalise).toHaveLength(1);
    expect(finalise[0].getAttribute('href')).toBe('/build-plans?order=BS-CNC-NEWEST');

    // The older preview is still reachable, it just does not shout.
    expect(screen.getByRole('link', { name: 'Open build plan BS-CNC-OLDER1' }).getAttribute('href')).toBe(
      '/build-plans/orders/BS-CNC-OLDER1',
    );
    expect(screen.getByRole('link', { name: 'Open build plan BS-CNC-PAID01' })).toBeTruthy();
  });

  it('shouts on nothing when no preview is waiting to be bought', async () => {
    await renderList([
      order({ licenceId: 'BS-CNC-PAID01', status: 'ready' }),
      preview('BS-CNC-DRAWIN', '2026-09-05T10:00:00.000Z', 'preview_generating'),
    ]);

    expect(screen.queryByRole('link', { name: 'Finalise' })).toBeNull();
  });

  it('calls a preview a preview rather than a commercial licence', async () => {
    // A null tier is the whole free half of the lifecycle. The old ternary
    // labelled every one of these "Commercial, single build".
    await renderList([preview('BS-CNC-NEWEST', '2026-09-05T10:00:00.000Z')]);

    expect(screen.getByText('Kilter 25 · Preview')).toBeTruthy();
    expect(screen.queryByText(/Commercial/)).toBeNull();
  });

  it('dates a preview by when it was drawn and a purchase by when it was ordered', async () => {
    await renderList([
      preview('BS-CNC-NEWEST', '2026-09-05T10:00:00.000Z'),
      order({ licenceId: 'BS-CNC-PAID01', createdAt: '2026-08-14T10:00:00.000Z' }),
    ]);

    expect(screen.getByText('Previewed Sep 5, 2026')).toBeTruthy();
    expect(screen.getByText('Ordered Aug 14, 2026')).toBeTruthy();
  });

  it('shows every status as a chip, preview states included', async () => {
    await renderList([
      preview('BS-CNC-DRAWIN', '2026-09-05T10:00:00.000Z', 'preview_generating'),
      order({ licenceId: 'BS-CNC-PAID01', status: 'ready' }),
    ]);

    expect(screen.getByText('Drawing the preview')).toBeTruthy();
    expect(screen.getByText('Ready to download')).toBeTruthy();
  });
});
