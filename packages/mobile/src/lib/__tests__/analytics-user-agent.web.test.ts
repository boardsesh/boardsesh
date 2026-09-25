import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAnalyticsUserAgent as resolveNativeUserAgent } from '../analytics-user-agent';
import { MOBILE_USER_AGENT } from '../mobile-user-agent';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// #5653: the Expo browser app stamped every visitor with the native constant,
// so PostHog's `$virt_is_bot` could never flag a crawler rendering /app.
describe('resolveAnalyticsUserAgent (Expo browser app)', () => {
  it('sends the browser user agent, not the native constant', async () => {
    vi.stubGlobal('navigator', { userAgent: BROWSER_UA });
    const { resolveAnalyticsUserAgent } = await import('../analytics-user-agent.web');

    expect(resolveAnalyticsUserAgent()).toBe(BROWSER_UA);
  });

  it('flags a crawler by passing its user agent through unchanged', async () => {
    const applebot = `${BROWSER_UA} (Applebot/0.1; +http://www.apple.com/go/applebot)`;
    vi.stubGlobal('navigator', { userAgent: applebot });
    const { resolveAnalyticsUserAgent } = await import('../analytics-user-agent.web');

    expect(resolveAnalyticsUserAgent()).toBe(applebot);
  });

  it('caps the user agent at 1000 characters', async () => {
    vi.stubGlobal('navigator', { userAgent: `${BROWSER_UA} ${'x'.repeat(2000)}` });
    const { resolveAnalyticsUserAgent } = await import('../analytics-user-agent.web');

    const resolved = resolveAnalyticsUserAgent() ?? '';
    expect(resolved).toHaveLength(1000);
    expect(resolved.startsWith(BROWSER_UA)).toBe(true);
  });

  // A real browser always has a UA, so an empty one is a bot signal. Returning
  // the app constant here would label it human; www leaves the property unset.
  it('returns null, not the app constant, when the browser exposes no user agent', async () => {
    vi.stubGlobal('navigator', {});
    const { resolveAnalyticsUserAgent } = await import('../analytics-user-agent.web');

    expect(resolveAnalyticsUserAgent()).toBeNull();
  });

  it('returns null for an empty user agent string', async () => {
    vi.stubGlobal('navigator', { userAgent: '' });
    const { resolveAnalyticsUserAgent } = await import('../analytics-user-agent.web');

    expect(resolveAnalyticsUserAgent()).toBeNull();
  });
});

describe('resolveAnalyticsUserAgent (native)', () => {
  it('keeps the static app constant regardless of any navigator.userAgent', () => {
    vi.stubGlobal('navigator', { userAgent: BROWSER_UA });

    expect(resolveNativeUserAgent()).toBe(MOBILE_USER_AGENT);
  });
});
