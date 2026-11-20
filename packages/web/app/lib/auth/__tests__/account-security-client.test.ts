import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// #7596 B7 (acceptance 4, first password on a bridged session): the emailed link
// opens a new tab, and its status check left before the page's first session
// read. The guard then named nobody, the route refused the missing
// expected-viewer header, and the page always said "try again".
const order: string[] = [];
let viewerKnown: () => void = () => {};
const whenViewerKnown = vi.fn(
  () =>
    new Promise<string | undefined>((resolve) => {
      viewerKnown = () => {
        order.push('viewer known');
        resolve('user-a:login-a');
      };
    }),
);
const guardedFetch = vi.fn(async () => {
  order.push('sent');
  return new Response(JSON.stringify({ status: 'pending' }), { status: 200 });
});

vi.mock('../session-guard', () => ({
  browserSessionGuard: () => ({ whenViewerKnown }),
  guardedFetch: (...args: unknown[]) => guardedFetch(...(args as [])),
}));
vi.mock('@/app/lib/auth/web-session-events', () => ({ bridgeLegacyBrowserSession: vi.fn() }));

const { ACCOUNT_SECURITY_VIEWER_WAIT_MS, postAccountSecurity, readAccountSecurity } =
  await import('../account-security-client');

beforeEach(() => {
  order.length = 0;
  whenViewerKnown.mockClear();
  guardedFetch.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('account-security calls wait for the page to know who it shows', () => {
  it('sends a post only once the first session read named the viewer', async () => {
    const answer = postAccountSecurity('/api/auth/first-password/status', { operation: 'b'.repeat(64) });
    await Promise.resolve();
    expect(guardedFetch).not.toHaveBeenCalled();
    expect(whenViewerKnown).toHaveBeenCalledWith(ACCOUNT_SECURITY_VIEWER_WAIT_MS);
    viewerKnown();
    await expect(answer).resolves.toEqual({ httpStatus: 200, body: { status: 'pending' } });
    expect(order).toEqual(['viewer known', 'sent']);
  });

  it('waits the same way for a read', async () => {
    const answer = readAccountSecurity('/api/auth/provider-security');
    await Promise.resolve();
    expect(guardedFetch).not.toHaveBeenCalled();
    viewerKnown();
    await answer;
    expect(order).toEqual(['viewer known', 'sent']);
  });
});
