import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { MarketingRuntime } from '../marketing-runtime';
import { useMarketingCapabilities } from '../marketing-capabilities-context';

vi.mock('../marketing-account-runtime', () => ({
  default: ({ enableExpoAuthBridge }: { enableExpoAuthBridge?: boolean }) => (
    <output>{String(enableExpoAuthBridge ?? false)}</output>
  ),
}));
vi.mock('@/app/lib/consent-pending-db', () => ({
  loadPendingConsent: async () => null,
  persistPendingConsent: async () => {},
}));
const fetchCapabilities = vi.fn();
beforeEach(() => {
  fetchCapabilities.mockReset();
  vi.stubGlobal('fetch', fetchCapabilities);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function FooterDestination() {
  return <a href={useMarketingCapabilities()?.developerHref ?? '/docs'}>Developer docs</a>;
}

it('loads account controls before runtime configuration and updates static fallbacks after resolution', async () => {
  let resolveCapabilities!: (response: Response) => void;
  fetchCapabilities.mockReturnValue(new Promise<Response>((resolve) => (resolveCapabilities = resolve)));
  render(
    <MarketingRuntime>
      <main>Public copy</main>
      <FooterDestination />
    </MarketingRuntime>,
  );
  expect(screen.getByText('Public copy')).toBeTruthy();
  expect((await screen.findByRole('status')).textContent).toBe('false');
  expect(screen.getByRole('link').getAttribute('href')).toBe('/docs');
  expect(fetchCapabilities).toHaveBeenCalledWith('/api/health', {
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal: expect.any(AbortSignal),
  });
  await act(async () => {
    resolveCapabilities(
      Response.json({
        marketing: { enableExpoAuthBridge: true, developerHref: '/developers', hasMonthlySupport: false },
      }),
    );
  });
  expect((await screen.findByRole('status')).textContent).toBe('true');
  expect(screen.getByRole('link').getAttribute('href')).toBe('/developers');
});

it.each([
  () => Promise.reject(new Error('offline')),
  () => Promise.resolve(Response.json({}, { status: 503 })),
  () => Promise.resolve(Response.json({ marketing: { enableExpoAuthBridge: '1', developerHref: '/private' } })),
])('keeps account controls and safe links usable when configuration fails, then retries online', async (failedRead) => {
  fetchCapabilities.mockImplementationOnce(failedRead);
  fetchCapabilities.mockResolvedValue(
    Response.json({
      marketing: { enableExpoAuthBridge: true, developerHref: '/developers', hasMonthlySupport: false },
    }),
  );
  render(
    <MarketingRuntime>
      <FooterDestination />
    </MarketingRuntime>,
  );
  expect((await screen.findByRole('status')).textContent).toBe('false');
  expect(screen.getByRole('link').getAttribute('href')).toBe('/docs');
  await act(async () => window.dispatchEvent(new Event('online')));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('true'));
  expect(screen.getByRole('link').getAttribute('href')).toBe('/developers');
  expect(fetchCapabilities).toHaveBeenCalledTimes(2);
});

it('aborts an unfinished capability request when the document unmounts', () => {
  fetchCapabilities.mockReturnValue(new Promise<Response>(() => {}));
  const view = render(
    <MarketingRuntime>
      <main>Public copy</main>
    </MarketingRuntime>,
  );
  const signal = fetchCapabilities.mock.calls[0]?.[1].signal as AbortSignal;
  expect(signal.aborted).toBe(false);
  view.unmount();
  expect(signal.aborted).toBe(true);
});

it('refreshes configuration on bfcache restore and discards the response from before pagehide', async () => {
  let finishOldRead!: (response: Response) => void;
  fetchCapabilities.mockReturnValueOnce(new Promise<Response>((resolve) => (finishOldRead = resolve)));
  fetchCapabilities.mockResolvedValue(
    Response.json({ marketing: { enableExpoAuthBridge: false, developerHref: '/docs', hasMonthlySupport: false } }),
  );
  render(
    <MarketingRuntime>
      <FooterDestination />
    </MarketingRuntime>,
  );
  expect((await screen.findByRole('status')).textContent).toBe('false');
  const oldSignal = fetchCapabilities.mock.calls[0]?.[1].signal as AbortSignal;
  await act(() => window.dispatchEvent(new Event('pagehide')));
  expect(oldSignal.aborted).toBe(true);
  await act(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await waitFor(() => expect(fetchCapabilities).toHaveBeenCalledTimes(2));
  await act(async () =>
    finishOldRead(
      Response.json({
        marketing: { enableExpoAuthBridge: true, developerHref: '/developers', hasMonthlySupport: true },
      }),
    ),
  );
  expect(screen.getByRole('status').textContent).toBe('false');
  expect(screen.getByRole('link').getAttribute('href')).toBe('/docs');
});

it('exhausts three automatic attempts during an outage and recovers on the next online event', async () => {
  vi.useFakeTimers();
  fetchCapabilities.mockRejectedValue(new Error('offline'));
  render(
    <MarketingRuntime>
      <FooterDestination />
    </MarketingRuntime>,
  );
  await act(async () => {});
  expect(fetchCapabilities).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(fetchCapabilities).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(fetchCapabilities).toHaveBeenCalledTimes(3);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(fetchCapabilities).toHaveBeenCalledTimes(3);
  fetchCapabilities.mockResolvedValue(
    Response.json({
      marketing: { enableExpoAuthBridge: true, developerHref: '/developers', hasMonthlySupport: false },
    }),
  );
  await act(async () => window.dispatchEvent(new Event('online')));
  expect(fetchCapabilities).toHaveBeenCalledTimes(4);
  expect(screen.getByRole('status').textContent).toBe('true');
});
