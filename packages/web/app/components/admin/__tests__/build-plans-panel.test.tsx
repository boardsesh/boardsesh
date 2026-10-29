import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CncAdminOrder, CncOrder, CncOrderStatus } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import BuildPlansPanel from '../build-plans-panel';

const mockRequest = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: (namespace?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'admin-token' }),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@boardsesh/graphql/operations/cnc-packs', () => ({
  ADMIN_CNC_ORDERS: 'ADMIN_CNC_ORDERS',
  REGENERATE_CNC_PACK: 'REGENERATE_CNC_PACK',
}));

function makeOrder(overrides: Partial<CncOrder> = {}): CncOrder {
  return {
    id: '1',
    licenceId: 'BS-CNC-ABC234',
    tier: 'personal',
    status: 'ready',
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27,28,29',
    options: {},
    artwork: [],
    licenseeName: 'Marco',
    customerSiteName: null,
    amountCents: 14900,
    currency: 'AUD',
    createdAt: '2026-09-01T00:00:00.000Z',
    paidAt: '2026-09-01T00:01:00.000Z',
    generatedAt: '2026-09-01T00:04:00.000Z',
    zipSizeBytes: 4_500_000,
    downloadCount: 0,
    lastDownloadedAt: null,
    errorMessage: null,
    hasPreview: true,
    previewGeneratedAt: '2026-09-01T00:00:30.000Z',
    previewImages: [],
    configHash: 'a1b2c3',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<CncAdminOrder> = {}, orderOverrides: Partial<CncOrder> = {}): CncAdminOrder {
  return {
    order: makeOrder(orderOverrides),
    licenseeEmail: 'marco@example.com',
    attempts: 1,
    lastError: null,
    ...overrides,
  };
}

function page(orders: CncAdminOrder[], { hasMore = false, cursor = null as string | null } = {}) {
  return { adminCncOrders: { orders, hasMore, cursor } };
}

function renderPanel() {
  return render(<BuildPlansPanel catalog={null} locale="en-US" />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BuildPlansPanel', () => {
  it('shows the three fields the buyer never sees', async () => {
    mockRequest.mockResolvedValue(
      page([makeEntry({ attempts: 3, lastError: 'ezdxf: PANEL_EXCEEDS_SHEET on panel 2' }, { status: 'failed' })]),
    );

    renderPanel();

    // The whole reason the screen exists: who to write to, how much budget is
    // left, and what actually went wrong.
    expect(await screen.findByText('marco@example.com')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
    expect(screen.getByText('ezdxf: PANEL_EXCEEDS_SHEET on panel 2')).toBeDefined();
  });

  it('offers Regenerate on a failed order', async () => {
    mockRequest.mockResolvedValue(page([makeEntry({}, { status: 'failed' })]));

    renderPanel();

    expect(await screen.findByRole('button', { name: 'Regenerate' })).toBeDefined();
  });

  it.each<CncOrderStatus>(['pending_payment', 'queued', 'generating', 'cancelled', 'refunded'])(
    'offers no Regenerate on a %s order',
    async (status) => {
      // The resolver refuses these transitions anyway; the button is hidden so
      // an operator is never offered an action that can only fail.
      mockRequest.mockResolvedValue(page([makeEntry({}, { status })]));

      renderPanel();

      await screen.findByText('BS-CNC-ABC234');
      expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeNull();
    },
  );

  it('confirms by licence id before requeueing, and does nothing if you back out', async () => {
    mockRequest.mockResolvedValue(page([makeEntry({}, { status: 'failed' })]));

    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Regenerate' }));
    expect(await screen.findByText(/BS-CNC-ABC234 is rebuilt under the same licence id/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Keep it as it is' }));

    // One call: the initial list. The mutation never went out.
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
  });

  it('requeues on confirm and re-reads the queue for the row it cannot know', async () => {
    mockRequest.mockResolvedValueOnce(
      page([makeEntry({ attempts: 3, lastError: 'ezdxf: PANEL_EXCEEDS_SHEET on panel 2' }, { status: 'failed' })]),
    );

    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Regenerate' }));
    // The mutation answers with a plain order: no attempt count, no last error.
    mockRequest.mockResolvedValueOnce({ regenerateCncPack: makeOrder({ status: 'queued' }) });
    mockRequest.mockResolvedValueOnce(page([makeEntry({ attempts: 0 }, { status: 'queued' })]));
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild it' }));

    // So the row's two admin-only columns come from a re-read of the queue once
    // the mutation resolves — a row still showing "3" and the old message would
    // read as a fresh failure.
    await waitFor(() =>
      expect(mockRequest).toHaveBeenLastCalledWith('ADMIN_CNC_ORDERS', { status: null, limit: 50, cursor: null }),
    );
    expect(mockRequest).toHaveBeenCalledTimes(3);
    // Scoped to the row: "In the queue" is also one of the status filter chips.
    await waitFor(() => {
      const row = screen.getByText('BS-CNC-ABC234').closest('tr') as HTMLElement | null;
      expect(row).not.toBeNull();
      expect(within(row as HTMLElement).getByText('In the queue')).toBeDefined();
      expect(within(row as HTMLElement).getByText('0')).toBeDefined();
    });
    expect(screen.queryByText('ezdxf: PANEL_EXCEEDS_SHEET on panel 2')).toBeNull();
  });

  it('sends the status filter and asks for the first page again when it changes', async () => {
    mockRequest.mockResolvedValue(page([]));

    renderPanel();
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
    expect(mockRequest).toHaveBeenLastCalledWith('ADMIN_CNC_ORDERS', { status: null, limit: 50, cursor: null });

    fireEvent.click(screen.getByText('Did not build'));

    // A new filter starts over: a cursor from the unfiltered list means nothing
    // in the filtered one.
    await waitFor(() =>
      expect(mockRequest).toHaveBeenLastCalledWith('ADMIN_CNC_ORDERS', { status: 'failed', limit: 50, cursor: null }),
    );
  });

  it('appends the next page rather than replacing the one on screen', async () => {
    mockRequest.mockResolvedValueOnce(page([makeEntry()], { hasMore: true, cursor: 'cursor-1' }));

    renderPanel();
    await screen.findByText('BS-CNC-ABC234');

    mockRequest.mockResolvedValueOnce(page([makeEntry({}, { licenceId: 'BS-CNC-XYZ789' })]));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('BS-CNC-XYZ789')).toBeDefined();
    // The first page is still there — this is a growing list, not a pager.
    expect(screen.getByText('BS-CNC-ABC234')).toBeDefined();
    expect(mockRequest).toHaveBeenLastCalledWith('ADMIN_CNC_ORDERS', { status: null, limit: 50, cursor: 'cursor-1' });
  });

  it('can filter to any of the four free-preview statuses', async () => {
    // Previews are free and repeatable, so most of the queue now lives in these
    // four states — a stuck `preview_generating` is the first thing an operator
    // goes looking for, and it was unreachable while the filter row stopped at
    // `pending_payment`.
    mockRequest.mockResolvedValue(page([]));

    renderPanel();
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));

    for (const [label, status] of [
      ['Preview queued', 'preview_queued'],
      ['Drawing the preview', 'preview_generating'],
      ['Preview ready', 'preview_ready'],
      ['Preview did not build', 'preview_failed'],
    ] satisfies [string, CncOrderStatus][]) {
      fireEvent.click(screen.getByText(label));
      await waitFor(() =>
        expect(mockRequest).toHaveBeenLastCalledWith('ADMIN_CNC_ORDERS', { status, limit: 50, cursor: null }),
      );
    }
  });

  it('calls an unbought order a preview rather than a commercial licence', async () => {
    // `tier` is null for the whole free half of the lifecycle, and the tier
    // column is where an operator reads what the job actually is.
    mockRequest.mockResolvedValue(page([makeEntry({}, { status: 'preview_ready', tier: null })]));

    renderPanel();

    const row = (await screen.findByText('BS-CNC-ABC234')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Preview')).toBeDefined();
    expect(within(row).getByText('Preview ready')).toBeDefined();
    expect(within(row).queryByText('Commercial, single build')).toBeNull();
  });

  it('counts the previews drawn in the last hour', async () => {
    const now = Date.now();
    mockRequest.mockResolvedValue(
      page([
        makeEntry({}, { licenceId: 'BS-CNC-FRESH1', previewGeneratedAt: new Date(now - 5 * 60_000).toISOString() }),
        makeEntry({}, { licenceId: 'BS-CNC-FRESH2', previewGeneratedAt: new Date(now - 50 * 60_000).toISOString() }),
        makeEntry({}, { licenceId: 'BS-CNC-STALE1', previewGeneratedAt: new Date(now - 120 * 60_000).toISOString() }),
        makeEntry({}, { licenceId: 'BS-CNC-NEVER1', previewGeneratedAt: null }),
      ]),
    );

    renderPanel();

    expect(await screen.findByText(/2 previews drawn in the last hour/)).toBeDefined();
  });

  it('offers no Regenerate on any of the preview statuses', async () => {
    // A preview is regenerated by previewing again from the configurator; the
    // resolver refuses this transition, so the button must not be offered.
    for (const status of [
      'preview_queued',
      'preview_generating',
      'preview_ready',
      'preview_failed',
    ] satisfies CncOrderStatus[]) {
      mockRequest.mockResolvedValue(page([makeEntry({}, { status, tier: null })]));

      const view = renderPanel();
      await screen.findByText('BS-CNC-ABC234');
      expect({ status, offered: screen.queryByRole('button', { name: 'Regenerate' }) !== null }).toEqual({
        status,
        offered: false,
      });
      view.unmount();
    }
  });

  it('offers a retry rather than an empty table when the query fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRequest.mockRejectedValueOnce(new Error('backend unreachable'));

    renderPanel();

    expect(await screen.findByText("Couldn't load orders.")).toBeDefined();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });
});
