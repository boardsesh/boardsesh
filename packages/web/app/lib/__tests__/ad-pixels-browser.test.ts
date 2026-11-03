import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AD_MEASUREMENT_COPY_SINCE, CONSENT_VERSION, type ConsentRecord } from '@boardsesh/consent';

const harness = vi.hoisted(() => ({
  record: null as ConsentRecord | null,
  authorized: false,
  gpc: false,
}));
vi.mock('../consent', () => ({
  getWebConsentRecord: () => harness.record,
  hasAnalyticsConsent: () => harness.authorized,
  isGlobalPrivacyControlEnabled: () => harness.gpc,
  refreshWebConsent: () => {},
  subscribeWebConsent: () => () => {},
}));
const analyticsTrack = vi.hoisted(() => vi.fn());
vi.mock('../analytics', () => ({ track: analyticsTrack }));

type Queued = { queue?: unknown[][]; callQueue?: unknown[][] };
type TestWindow = Window & { fbq?: Queued; _fbq?: unknown; rdt?: Queued };

const META_ID = '123456789012345';
const REDDIT_ID = 'a2_abc123def';
const ALLOW_AFTER_COPY: ConsentRecord = {
  analytics: 'granted',
  version: CONSENT_VERSION,
  decidedAt: new Date(Date.parse(AD_MEASUREMENT_COPY_SINCE) + 60_000).toISOString(),
  source: 'web',
};
const originalLocation = window.location;
let cookieJar = new Map<string, string>();
const cookieWrites: string[] = [];

function setLocation(pathname: string, hostname = 'www.boardsesh.com'): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { hostname, pathname, href: `https://${hostname}${pathname}`, protocol: 'https:' },
  });
}
function grant(record: ConsentRecord = ALLOW_AFTER_COPY): void {
  harness.record = record;
  harness.authorized = true;
}
function testWindow(): TestWindow {
  return window as TestWindow;
}
function pixelScripts(): string[] {
  return [...document.querySelectorAll('script')].map((script) => script.src);
}

async function loadModule() {
  return import('../ad-pixels-browser');
}

beforeEach(() => {
  vi.resetModules();
  harness.record = null;
  harness.authorized = false;
  harness.gpc = false;
  analyticsTrack.mockReset();
  cookieJar = new Map();
  cookieWrites.length = 0;
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; '),
    set: (cookie: string) => {
      cookieWrites.push(cookie);
      const [pair] = cookie.split(';');
      const [name, value] = pair.split('=');
      if (/Max-Age=0/i.test(cookie)) cookieJar.delete(name.trim());
      else cookieJar.set(name.trim(), value);
    },
  });
  vi.stubEnv('NEXT_PUBLIC_META_PIXEL_ID', META_ID);
  vi.stubEnv('NEXT_PUBLIC_REDDIT_PIXEL_ID', REDDIT_ID);
  setLocation('/');
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (document as unknown as Record<string, unknown>).cookie;
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  delete testWindow().fbq;
  delete testWindow()._fbq;
  delete testWindow().rdt;
  document.head.innerHTML = '';
});

describe('ad pixels in the browser', () => {
  it('loads nothing and sends nothing without consent', async () => {
    const pixels = await loadModule();
    pixels.syncAdPixels('/');
    pixels.reportAdLead({ platform: 'ios', placement: 'hero' });
    expect(testWindow().fbq).toBeUndefined();
    expect(testWindow().rdt).toBeUndefined();
    expect(pixelScripts()).toEqual([]);
  });

  it('loads nothing with consent when both ids are unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_META_PIXEL_ID', '');
    vi.stubEnv('NEXT_PUBLIC_REDDIT_PIXEL_ID', '');
    grant();
    const pixels = await loadModule();
    pixels.syncAdPixels('/');
    pixels.reportAdLead({ platform: 'android', placement: 'hero' });
    expect(testWindow().fbq).toBeUndefined();
    expect(testWindow().rdt).toBeUndefined();
    expect(pixelScripts()).toEqual([]);
  });

  it('loads both scripts once and sends one page view per page', async () => {
    grant();
    const pixels = await loadModule();
    pixels.syncAdPixels('/');
    pixels.syncAdPixels('/');
    pixels.syncAdPixels('/gyms');

    expect(pixelScripts()).toEqual([
      'https://connect.facebook.net/en_US/fbevents.js',
      'https://www.redditstatic.com/ads/pixel.js',
    ]);
    expect(testWindow().fbq?.queue).toEqual([
      ['set', 'autoConfig', false, META_ID],
      ['init', META_ID],
      ['track', 'PageView'],
      ['track', 'PageView'],
    ]);
    expect(testWindow().rdt?.callQueue).toEqual([
      ['init', REDDIT_ID],
      ['track', 'PageVisit'],
      ['track', 'PageVisit'],
    ]);
  });

  it('never loads on kiosk, embed or auth pages', async () => {
    grant();
    const pixels = await loadModule();
    for (const path of ['/kiosk/gym', '/embed/board/x', '/auth/login']) {
      setLocation(path);
      pixels.syncAdPixels(path);
      pixels.reportAdLead({ platform: 'ios' });
    }
    expect(pixelScripts()).toEqual([]);
  });

  it('sends Lead with placement and platform on a store click', async () => {
    grant();
    const { trackAppInstallClick } = await import('../track-app-install-click');
    trackAppInstallClick({ platform: 'android', source: 'google-play', placement: 'gym-page', gymSlug: 'x' });
    expect(analyticsTrack).toHaveBeenCalledWith('App Install Click', {
      platform: 'android',
      source: 'google-play',
      placement: 'gym-page',
      gymSlug: 'x',
    });
    expect(testWindow().fbq?.queue).toContainEqual(['track', 'Lead', { platform: 'android', placement: 'gym-page' }]);
    expect(testWindow().rdt?.callQueue).toContainEqual([
      'track',
      'Lead',
      { platform: 'android', placement: 'gym-page' },
    ]);
  });

  it('a store click still reaches PostHog but never the pixels without ad consent', async () => {
    // An Allow from before the copy named Meta and Reddit: PostHog yes, pixels no.
    grant({ ...ALLOW_AFTER_COPY, decidedAt: '2026-01-01T00:00:00.000Z' });
    const { trackAppInstallClick } = await import('../track-app-install-click');
    trackAppInstallClick({ platform: 'ios', source: 'app-store', placement: 'hero' });
    expect(analyticsTrack).toHaveBeenCalledTimes(1);
    expect(testWindow().fbq).toBeUndefined();
    expect(testWindow().rdt).toBeUndefined();
  });

  it('pauses without withdrawing while the account or region is still resolving', async () => {
    grant();
    cookieJar.set('_fbp', 'fb.1.1.1');
    harness.authorized = false;
    const pixels = await loadModule();
    pixels.syncAdPixels('/');
    expect(pixelScripts()).toEqual([]);
    expect(cookieJar.get('_fbp')).toBe('fb.1.1.1');
  });

  it('withdraws on No thanks: revokes Meta, deletes the cookies and stops firing', async () => {
    grant();
    const pixels = await loadModule();
    pixels.syncAdPixels('/');
    cookieJar.set('_fbp', 'fb.1.1.1');
    cookieJar.set('_rdt_uuid', 'abc');
    cookieJar.set('boardsesh-consent', 'v1.denied.1.web');

    harness.record = { ...ALLOW_AFTER_COPY, analytics: 'denied' };
    harness.authorized = false;
    pixels.syncAdPixels('/');
    pixels.reportAdLead({ platform: 'ios', placement: 'hero' });
    pixels.syncAdPixels('/gyms');

    const metaQueue = testWindow().fbq?.queue ?? [];
    expect(metaQueue.at(-1)).toEqual(['consent', 'revoke']);
    expect(metaQueue.filter(([, event]) => event === 'Lead')).toEqual([]);
    expect((testWindow().rdt?.callQueue ?? []).filter(([, event]) => event === 'Lead')).toEqual([]);
    expect(cookieJar.has('_fbp')).toBe(false);
    expect(cookieJar.has('_rdt_uuid')).toBe(false);
    expect(cookieJar.get('boardsesh-consent')).toBe('v1.denied.1.web');
    // Cleared on the host and on the parent domain the pixels write to.
    expect(cookieWrites).toContain('_fbp=; Max-Age=0; Path=/; Domain=boardsesh.com');
    expect(cookieWrites).toContain('_rdt_uuid=; Max-Age=0; Path=/');
    expect(cookieWrites).toContain('_rdt_uuid=; Max-Age=0; Path=/; Domain=www.boardsesh.com');
  });

  it('withdraws when Global Privacy Control turns up on a region default', async () => {
    grant({ ...ALLOW_AFTER_COPY, basis: 'region_default' });
    harness.gpc = true;
    cookieJar.set('_rdt_uuid', 'abc');
    const pixels = await loadModule();
    pixels.syncAdPixels('/');
    expect(pixelScripts()).toEqual([]);
    expect(cookieJar.has('_rdt_uuid')).toBe(false);
  });

  it('stays off for the rest of the page load after a withdrawal, even on a new Allow', async () => {
    grant();
    const pixels = await loadModule();
    pixels.syncAdPixels('/');
    harness.record = null;
    pixels.syncAdPixels('/');
    grant();
    pixels.syncAdPixels('/gyms');
    pixels.reportAdLead({ platform: 'ios', placement: 'hero' });
    const metaQueue = testWindow().fbq?.queue ?? [];
    expect(metaQueue.at(-1)).toEqual(['consent', 'revoke']);
    expect((testWindow().rdt?.callQueue ?? []).at(-1)).toEqual(['track', 'PageVisit']);
    expect(testWindow().rdt?.callQueue).toHaveLength(2);
  });

  it('never loads inside the Capacitor app', async () => {
    grant();
    (window as unknown as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    try {
      const pixels = await loadModule();
      pixels.syncAdPixels('/');
      pixels.reportAdLead({ platform: 'ios', placement: 'hero' });
      expect(pixelScripts()).toEqual([]);
    } finally {
      delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    }
  });

  it('waits for the Capacitor bridge on a WebView user agent before the first event', async () => {
    vi.useFakeTimers();
    const userAgent = vi
      .spyOn(navigator, 'userAgent', 'get')
      .mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148');
    try {
      grant();
      const pixels = await loadModule();
      pixels.syncAdPixels('/');
      expect(pixelScripts()).toEqual([]);
      await vi.advanceTimersByTimeAsync(3000);
      expect((testWindow().fbq?.queue ?? []).at(-1)).toEqual(['track', 'PageView']);
    } finally {
      userAgent.mockRestore();
      vi.useRealTimers();
    }
  });
});
