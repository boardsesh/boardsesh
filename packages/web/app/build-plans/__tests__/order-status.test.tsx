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
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: graphqlRequest }),
}));

const OrderStatusModule = await import('../orders/[licenceId]/order-status');
const OrderStatus = OrderStatusModule.default;
const { orderRefetchInterval, ORDER_POLL_INTERVAL_MS } = OrderStatusModule;

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
    ...overrides,
  };
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

describe('polling', () => {
  it('keeps polling while an order is still moving', () => {
    for (const status of ['pending_payment', 'queued', 'generating'] satisfies CncOrderStatus[]) {
      expect({ status, interval: orderRefetchInterval(status) }).toEqual({
        status,
        interval: ORDER_POLL_INTERVAL_MS,
      });
    }
  });

  it('stops the moment the pack is ready, and for every other terminal status', () => {
    // The whole point: a buyer who leaves the tab open on a finished pack must
    // not sit there asking the backend the same settled question forever.
    for (const status of ['ready', 'failed', 'cancelled', 'refunded'] satisfies CncOrderStatus[]) {
      expect({ status, interval: orderRefetchInterval(status) }).toEqual({ status, interval: false });
    }
  });

  it('does not re-fetch a ready order after the first render', async () => {
    renderStatus(order({ status: 'ready' }));

    // The button, not the status text: "Ready to download" is deliberately
    // both the chip label and the last timeline step, so a text query matches
    // twice and tells you nothing.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download the pack' })).toBeTruthy());
    // `initialData` seeds the cache from the server render, and a settled
    // status turns the interval off, so nothing should have gone out.
    expect(graphqlRequest).not.toHaveBeenCalled();
  });
});

describe('download', () => {
  it('asks for a fresh grant and sends the browser to it', async () => {
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

    // The grant mutation, with the licence id — not a cached URL, because a
    // grant lasts five minutes and a cached one is a dead link most of the time.
    const [document, variables] = graphqlRequest.mock.calls[0] as [string, Record<string, unknown>];
    expect(document).toContain('CreateCncDownloadGrant');
    expect(variables).toEqual({ licenceId: 'BS-CNC-K7QM3T' });
  });

  it('shows an error and re-enables the button when the grant fails', async () => {
    graphqlRequest.mockRejectedValue(new Error('nope'));

    renderStatus(order({ status: 'ready' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download the pack' }));

    await waitFor(() => expect(screen.getByText('That link did not come through. Try again.')).toBeTruthy());
    expect(locationAssign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Download the pack' }).hasAttribute('disabled')).toBe(false);
  });

  it('offers no download at all before the pack is ready', () => {
    renderStatus(order({ status: 'generating' }));

    expect(screen.queryByRole('button', { name: 'Download the pack' })).toBeNull();
  });

  it('disables the download button while there is no auth token yet', () => {
    useWsAuthToken.mockReturnValue({ token: null, isAuthenticated: true });
    renderStatus(order({ status: 'ready' }));

    // A click with no token would only fail inside handleDownload; disabling
    // up front means there is nothing to click before the token arrives.
    expect(screen.getByRole('button', { name: 'Download the pack' }).hasAttribute('disabled')).toBe(true);
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

  it('reports the checkout outcome the buyer came back with', () => {
    renderStatus(order({ status: 'queued' }), 'success');
    expect(screen.getByText('Payment went through. Your pack is being cut now.')).toBeTruthy();
  });
});
