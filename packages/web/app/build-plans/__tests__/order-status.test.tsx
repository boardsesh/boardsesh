import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CncOrder, CncOrderStatus } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const useWsAuthToken = vi.hoisted(() => vi.fn());
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken }));

const routerReplace = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/i18n/use-locale-router', () => ({
  useLocaleRouter: () => ({ replace: routerReplace }),
  usePathnameWithoutLocale: () => '/build-plans/orders/BS-CNC-K7QM3T',
}));

const graphqlRequest = vi.hoisted(() => vi.fn());
// The same helper the component derives the download origin from, so the two
// agree in the test exactly as they do at runtime.
const BACKEND_GRAPHQL_URL = 'https://backend.example/graphql';
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: graphqlRequest }),
  getGraphQLHttpUrl: () => BACKEND_GRAPHQL_URL,
}));

const OrderStatusModule = await import('../orders/[licenceId]/order-status');
const OrderStatus = OrderStatusModule.default;
const { isBackendDownloadUrl, timelineProgress } = OrderStatusModule;
const { ORDER_POLL_INTERVAL_MS, MAX_CONSECUTIVE_NULL_POLLS } = await import('../use-cnc-order-poll');

const PREVIEW_IMAGES = [
  { name: 'panel1.png', url: 'https://backend.example/api/cnc/packs/BS-CNC-K7QM3T/preview/panel1.png?token=t' },
  { name: 'assembly.png', url: 'https://backend.example/api/cnc/packs/BS-CNC-K7QM3T/preview/assembly.png?token=t' },
];

function order(overrides: Partial<CncOrder> = {}): CncOrder {
  return {
    id: '41',
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
    previewImages: PREVIEW_IMAGES,
    configHash: 'a1b2c3',
    ...overrides,
  };
}

/** An order that has been previewed but not bought: null tier, nothing paid. */
function previewOrder(overrides: Partial<CncOrder> = {}): CncOrder {
  return order({
    status: 'preview_ready',
    tier: null,
    paidAt: null,
    generatedAt: null,
    amountCents: null,
    zipSizeBytes: null,
    ...overrides,
  });
}

function renderStatus(initialOrder: CncOrder, checkoutOutcome: 'success' | 'cancelled' | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <OrderStatus initialOrder={initialOrder} wallLabel="10x12" checkoutOutcome={checkoutOutcome} locale="en-US" />
    </QueryClientProvider>,
  );
}

const locationAssign = vi.fn();

beforeEach(() => {
  useWsAuthToken.mockReset().mockReturnValue({ token: 'ws-token', isAuthenticated: true });
  routerReplace.mockReset();
  // Default to "the order has not changed" so a component that DOES poll (a
  // queued order) does not blow up on an undefined response mid-test.
  graphqlRequest.mockReset().mockResolvedValue({ cncOrder: null });
  locationAssign.mockReset();
  // jsdom's own `location` is not assignable; replace the whole object so the
  // component's `window.location.assign(url)` is observable.
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { assign: locationAssign, href: 'http://localhost/build-plans/orders/BS-CNC-K7QM3T' },
  });
});

describe('the timeline', () => {
  it('covers both halves of the lifecycle, free preview first', () => {
    renderStatus(previewOrder());

    for (const step of ['Free preview drawn', 'Licence named and paid', 'Cutting the files', 'Ready to download']) {
      expect(screen.getAllByText(step).length).toBeGreaterThan(0);
    }
  });

  it('reads a preview being drawn as nothing done yet', () => {
    for (const status of ['preview_queued', 'preview_generating', 'preview_failed'] satisfies CncOrderStatus[]) {
      expect({ status, progress: timelineProgress(status) }).toEqual({ status, progress: -1 });
    }
  });

  it('reads a drawn preview as one step in, paid or not', () => {
    for (const status of ['preview_ready', 'pending_payment', 'cancelled'] satisfies CncOrderStatus[]) {
      expect({ status, progress: timelineProgress(status) }).toEqual({ status, progress: 0 });
    }
  });

  it('walks the paid half through to the end', () => {
    expect(timelineProgress('queued')).toBe(1);
    expect(timelineProgress('generating')).toBe(2);
    expect(timelineProgress('ready')).toBe(3);
    // A refund switches the download off; it does not un-cut the files.
    expect(timelineProgress('refunded')).toBe(3);
    // A failed order was paid, queued and picked up — it just never finished,
    // so it stalls at "cutting the files" rather than resetting to nothing.
    expect(timelineProgress('failed')).toBe(2);
  });

  it('says the page updates itself only while something is still moving', () => {
    renderStatus(previewOrder({ status: 'preview_generating' }));
    expect(screen.getByText('Previews take about fifteen seconds. This page updates itself.')).toBeTruthy();

    screen.getByText('Drawing the preview');
  });

  it('says nothing about waiting once the preview is drawn', () => {
    renderStatus(previewOrder());

    expect(screen.queryByText(/This page updates itself/)).toBeNull();
  });
});

describe('the preview', () => {
  it('shows the watermarked sheets with a caption each', () => {
    renderStatus(previewOrder());

    expect(screen.getByRole('img', { name: 'Panel 1' }).getAttribute('src')).toBe(PREVIEW_IMAGES[0].url);
    expect(screen.getByRole('img', { name: 'Assembly' })).toBeTruthy();
    expect(screen.getByText(/Watermarked, 110 dpi/)).toBeTruthy();
  });

  it('keeps the preview on screen after the pack has been bought', () => {
    // It is what the buyer checked before spending money. Hiding it the moment
    // the invoice lands is how a support ticket starts.
    renderStatus(order({ status: 'ready' }));

    expect(screen.getByRole('img', { name: 'Panel 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download the preview' })).toBeTruthy();
  });

  it('keeps the card and says what is happening while the sheets are drawn', () => {
    // No spinner-only card: the head stays, the status chip carries the state.
    renderStatus(previewOrder({ status: 'preview_generating', hasPreview: false, previewImages: [] }));

    expect(screen.getByText('We are drawing your sheets. They land here as soon as they are done.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download the preview' })).toBeNull();
  });

  it('offers Finalise on a drawn preview, pointing at the configurator', () => {
    renderStatus(previewOrder());

    expect(screen.getByRole('link', { name: 'Finalise and buy' }).getAttribute('href')).toBe(
      '/build-plans?order=BS-CNC-K7QM3T',
    );
  });

  it('offers no Finalise once the order has been bought', () => {
    renderStatus(order({ status: 'ready' }));

    expect(screen.queryByRole('link', { name: 'Finalise and buy' })).toBeNull();
  });
});

describe('downloads', () => {
  it('asks for a PREVIEW grant for the watermarked sheets', () => {
    renderStatus(previewOrder());
    fireEvent.click(screen.getByRole('button', { name: 'Download the preview' }));

    const [document, variables] = graphqlRequest.mock.calls[0] as [string, Record<string, unknown>];
    expect(document).toContain('CreateCncDownloadGrant');
    expect(variables).toEqual({ licenceId: 'BS-CNC-K7QM3T', kind: 'PREVIEW' });
  });

  it('asks for a FULL grant for the pack, and sends the browser to it', async () => {
    graphqlRequest.mockResolvedValue({
      createCncDownloadGrant: {
        url: 'https://backend.example/api/cnc/packs/BS-CNC-K7QM3T/download?token=abc',
        expiresAt: '2026-09-01T02:22:00.000Z',
      },
    });

    renderStatus(order({ status: 'ready' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download the pack' }));

    await waitFor(() => expect(locationAssign).toHaveBeenCalledTimes(1));
    expect(locationAssign).toHaveBeenCalledWith(
      'https://backend.example/api/cnc/packs/BS-CNC-K7QM3T/download?token=abc',
    );

    // A fresh grant on every click: it lasts five minutes, so a cached one is a
    // dead link most of the time.
    const [document, variables] = graphqlRequest.mock.calls[0] as [string, Record<string, unknown>];
    expect(document).toContain('CreateCncDownloadGrant');
    expect(variables).toEqual({ licenceId: 'BS-CNC-K7QM3T', kind: 'FULL' });
  });

  it('offers the pack only once it is ready', () => {
    for (const status of ['preview_ready', 'pending_payment', 'queued', 'generating'] satisfies CncOrderStatus[]) {
      const view = renderStatus(order({ status, tier: status === 'preview_ready' ? null : 'personal' }));
      expect({ status, offered: screen.queryByRole('button', { name: 'Download the pack' }) !== null }).toEqual({
        status,
        offered: false,
      });
      view.unmount();
    }

    renderStatus(order({ status: 'ready' }));
    expect(screen.getByRole('button', { name: 'Download the pack' })).toBeTruthy();
  });

  it('refuses a grant URL on any other origin', async () => {
    graphqlRequest.mockResolvedValue({
      createCncDownloadGrant: {
        url: 'https://evil.example/api/cnc/packs/BS-CNC-K7QM3T/download?token=abc',
        expiresAt: '2026-09-01T02:22:00.000Z',
      },
    });

    renderStatus(order({ status: 'ready' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download the pack' }));

    await waitFor(() => expect(screen.getByText('That link did not come through. Try again.')).toBeTruthy());
    expect(locationAssign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Download the pack' }).hasAttribute('disabled')).toBe(false);
  });

  it('shows the same error for a malformed grant URL instead of throwing', async () => {
    graphqlRequest.mockResolvedValue({
      createCncDownloadGrant: { url: 'not a url', expiresAt: '2026-09-01T02:22:00.000Z' },
    });

    renderStatus(order({ status: 'ready' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download the pack' }));

    await waitFor(() => expect(screen.getByText('That link did not come through. Try again.')).toBeTruthy());
    expect(locationAssign).not.toHaveBeenCalled();
  });

  it('accepts only the backend origin the GraphQL client already talks to', () => {
    for (const url of [
      'https://backend.example/api/cnc/packs/BS-CNC-K7QM3T/download?token=abc',
      'https://backend.example/anything',
    ]) {
      expect({ url, allowed: isBackendDownloadUrl(url) }).toEqual({ url, allowed: true });
    }

    for (const url of [
      'https://backend.example.evil.test/api/cnc/packs/BS-CNC-K7QM3T/download',
      'http://backend.example/api/cnc/packs/BS-CNC-K7QM3T/download',
      'https://evil.test/api/cnc/packs/BS-CNC-K7QM3T/download',
      '/api/cnc/packs/BS-CNC-K7QM3T/download',
      '',
    ]) {
      expect({ url, allowed: isBackendDownloadUrl(url) }).toEqual({ url, allowed: false });
    }
  });

  it('shows an error and re-enables the button when the grant fails', async () => {
    graphqlRequest.mockRejectedValue(new Error('nope'));

    renderStatus(order({ status: 'ready' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download the pack' }));

    await waitFor(() => expect(screen.getByText('That link did not come through. Try again.')).toBeTruthy());
    expect(locationAssign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Download the pack' }).hasAttribute('disabled')).toBe(false);
  });

  it('disables the download button while there is no auth token yet', () => {
    useWsAuthToken.mockReturnValue({ token: null, isAuthenticated: true });
    renderStatus(order({ status: 'ready' }));

    // A click with no token would only fail inside handleDownload; disabling up
    // front means there is nothing to click before the token arrives.
    expect(screen.getByRole('button', { name: 'Download the pack' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('polling', () => {
  it('does not re-fetch a ready order after the first render', async () => {
    renderStatus(order({ status: 'ready' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Download the pack' })).toBeTruthy());
    // `initialData` seeds the cache from the server render, and a settled status
    // turns the interval off, so nothing should have gone out.
    expect(graphqlRequest).not.toHaveBeenCalled();
  });

  it('does not re-fetch a drawn preview either — it is waiting on the buyer', async () => {
    renderStatus(previewOrder());

    await waitFor(() => expect(screen.getByRole('link', { name: 'Finalise and buy' })).toBeTruthy());
    expect(graphqlRequest).not.toHaveBeenCalled();
  });

  it('keeps asking while a preview is being drawn, then stops at the cap', async () => {
    vi.useFakeTimers();
    try {
      graphqlRequest.mockResolvedValue({ cncOrder: null });
      renderStatus(previewOrder({ status: 'preview_generating', hasPreview: false, previewImages: [] }));

      for (let poll = 1; poll <= MAX_CONSECUTIVE_NULL_POLLS; poll += 1) {
        await vi.advanceTimersByTimeAsync(ORDER_POLL_INTERVAL_MS + 50);
        expect({ poll, calls: graphqlRequest.mock.calls.length }).toEqual({ poll, calls: poll });
      }

      await vi.advanceTimersByTimeAsync(ORDER_POLL_INTERVAL_MS * 4);
      expect(graphqlRequest).toHaveBeenCalledTimes(MAX_CONSECUTIVE_NULL_POLLS);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('checkout param cleanup', () => {
  it('strips ?checkout= from the URL once the outcome has been shown', () => {
    renderStatus(order({ status: 'queued' }), 'success');

    // The alert already said what happened; a refresh of this URL must not
    // repeat it, so the query param is replaced away rather than left in place.
    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(routerReplace).toHaveBeenCalledWith('/build-plans/orders/BS-CNC-K7QM3T');
  });

  it('leaves the URL alone when there is no checkout outcome to clean up', () => {
    renderStatus(order({ status: 'ready' }), null);

    expect(routerReplace).not.toHaveBeenCalled();
  });
});

describe('terminal states', () => {
  it('explains a refund instead of offering a download', () => {
    renderStatus(order({ status: 'refunded' }));

    expect(screen.queryByRole('button', { name: 'Download the pack' })).toBeNull();
    expect(screen.getByText(/refunded, so the download is switched off/)).toBeTruthy();
  });

  it('shows the fixed public failure message and a way to reach a human', () => {
    const publicMessage =
      'This pack could not be generated. Boardsesh has been notified and will be in touch by email.';
    renderStatus(order({ status: 'failed', errorMessage: publicMessage }));

    expect(screen.getByText(publicMessage)).toBeTruthy();
    const contact = screen.getByText('Email us and we will sort it out');
    expect(contact.closest('a')?.getAttribute('href')).toContain('mailto:support@boardsesh.com');
  });

  it('says nothing was charged when a preview did not draw, and offers support', () => {
    renderStatus(previewOrder({ status: 'preview_failed', hasPreview: false, previewImages: [] }));

    expect(screen.getByText('This preview did not draw')).toBeTruthy();
    expect(screen.getByText(/Nothing was charged/)).toBeTruthy();
    const contact = screen.getByText('Email us and we will sort it out');
    expect(contact.closest('a')?.getAttribute('href')).toContain('mailto:support@boardsesh.com');
  });

  it('reports the checkout outcome the buyer came back with', () => {
    renderStatus(order({ status: 'queued' }), 'success');
    expect(screen.getByText('Payment went through. Your pack is being cut now.')).toBeTruthy();
  });
});
