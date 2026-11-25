import React from 'react';
import { cleanup, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import MarketingAccountRuntime from '../marketing-account-runtime';
import { ConsentStateProvider, useConsent } from '../../consent/consent-state-provider';
import type { BrowserSessionContextValue } from '../../providers/session-provider';
import { serializeConsentCookieValue, type ConsentRecord } from '@boardsesh/consent';

const mocks = vi.hoisted(() => ({
  bridgeEnabled: false,
  clear: vi.fn().mockResolvedValue(undefined),
  identify: vi.fn(),
  reset: vi.fn(),
  session: { data: null, status: 'unauthenticated', update: async () => null } as BrowserSessionContextValue,
}));
vi.mock('../../providers/session-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../providers/session-provider')>();
  return {
    ...actual,
    default: ({ children, enableExpoAuthBridge }: { children: React.ReactNode; enableExpoAuthBridge?: boolean }) => {
      mocks.bridgeEnabled = enableExpoAuthBridge ?? false;
      return (
        <actual.BrowserSessionContext.Provider value={mocks.session}>{children}</actual.BrowserSessionContext.Provider>
      );
    },
    useBrowserSession: () => mocks.session,
  };
});
vi.mock('../../analytics-client', () => ({ default: () => null }));
vi.mock('../../ad-pixels-client', () => ({ default: () => null }));
vi.mock('@/app/lib/analytics', () => ({
  setAnalyticsFlagAccountId: vi.fn(),
  identify: mocks.identify,
  reset: mocks.reset,
  getAnalyticsDistinctId: () => 'anonymous',
  getAnalyticsAnonymousId: () => 'anonymous',
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/app/lib/auth/session-guard', () => ({
  browserSessionGuard: () => ({ registerCleanup: () => () => {} }),
  sessionViewerOf: (session: { user: { id: string }; authSessionId: string } | null) =>
    session ? { userId: session.user.id, authSessionId: session.authSessionId } : null,
  sessionViewerKey: (viewer: { userId: string; authSessionId: string } | null) =>
    viewer ? `${viewer.userId}:${viewer.authSessionId}` : 'anonymous',
}));
vi.mock('../marketing-consent-sync', () => ({ default: () => null }));
vi.mock('../marketing-viewer-cleanup', () => ({ clearMarketingViewerState: mocks.clear }));
vi.mock('@/app/lib/consent-pending-db', () => ({
  loadPendingConsent: async () => null,
  persistPendingConsent: async () => {},
}));
const anonymous: BrowserSessionContextValue = { data: null, status: 'unauthenticated', update: async () => null };
const climber: BrowserSessionContextValue = {
  data: { user: { id: 'climber-b' }, authSessionId: 'login-b', expires: '2030-01-01T00:00:00Z' },
  status: 'authenticated',
  update: async () => null,
};
const grantedRecord: ConsentRecord = {
  analytics: 'granted',
  version: 1,
  source: 'web',
  decidedAt: '2026-11-25T00:00:00.000Z',
};
function Probe() {
  return <output>{String(useConsent().granted)}</output>;
}
function Harness({
  mirror,
  transport,
}: {
  mirror: BrowserSessionContextValue;
  transport?: { read: () => Promise<ConsentRecord>; write: () => Promise<ConsentRecord> };
}) {
  return (
    <ConsentStateProvider
      auth={{
        accountId: mirror.data?.user.id ?? null,
        status: mirror.status,
        token: mirror.status === 'authenticated' ? 'token-b' : null,
      }}
      transport={transport}
    >
      <MarketingAccountRuntime enableExpoAuthBridge session={mirror} />
      <Probe />
    </ConsentStateProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = anonymous;
  document.cookie = `boardsesh-consent=${serializeConsentCookieValue(grantedRecord)}; Path=/`;
});
afterEach(() => {
  cleanup();
  document.cookie = 'boardsesh-consent=; Max-Age=0; Path=/';
});

it('preserves the Expo browser-session bridge on the existing session owner', () => {
  render(<Harness mirror={anonymous} />);
  expect(mocks.bridgeEnabled).toBe(true);
});

it('cleans up once when a locally accepted account signs out', async () => {
  mocks.session = climber;
  const view = render(<Harness mirror={anonymous} />);
  expect(mocks.clear).not.toHaveBeenCalled();
  mocks.session = anonymous;
  view.rerender(<Harness mirror={anonymous} />);
  await waitFor(() => expect(mocks.clear).toHaveBeenCalledOnce());
  view.rerender(<Harness mirror={anonymous} />);
  expect(mocks.clear).toHaveBeenCalledOnce();
});

it('never identifies a newly accepted account while the outer consent tree still has an anonymous grant', async () => {
  let finishRead: (record: ConsentRecord) => void = () => {};
  const read = vi.fn(
    () =>
      new Promise<ConsentRecord>((resolve) => {
        finishRead = resolve;
      }),
  );
  const transport = { read, write: async () => grantedRecord };
  const view = render(<Harness mirror={anonymous} transport={transport} />);
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('true'));
  mocks.session = climber;
  // The authority owner accepts B before MarketingRuntime's store render commits.
  view.rerender(<Harness mirror={anonymous} transport={transport} />);
  expect(mocks.identify).not.toHaveBeenCalled();
  view.rerender(<Harness mirror={climber} transport={transport} />);
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  expect(screen.getByRole('status').textContent).toBe('false');
  expect(mocks.identify).not.toHaveBeenCalled();
  await act(async () => finishRead({ ...grantedRecord, analytics: 'denied', decidedAt: '2026-11-25T00:00:01.000Z' }));
  expect(mocks.identify).not.toHaveBeenCalled();
});
