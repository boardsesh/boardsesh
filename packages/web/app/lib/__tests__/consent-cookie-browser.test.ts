import { runInNewContext } from 'node:vm';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vite-plus/test';
const originalLocation = window.location;
let cookies = '';
let written = '';
beforeEach(() => {
  vi.resetModules();
  cookies = '';
  written = '';
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => cookies,
    set: (cookie: string) => {
      written = cookie;
      cookies = cookie.split(';')[0];
    },
  });
});
afterEach(() => {
  delete (document as unknown as Record<string, unknown>).cookie;
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  delete document.documentElement.dataset.consent;
});
describe('cache-safe browser consent cookie', () => {
  it('blocks an external grant before any listener or flag callback can capture', async () => {
    cookies = 'boardsesh-consent=v1.denied.1760000000.web';
    const consent = await import('../consent');
    consent.getWebConsentRecord();
    consent.setConsentAccountResolved(true);
    const listenerGrants: boolean[] = [];
    consent.subscribeWebConsent(() => listenerGrants.push(consent.hasAnalyticsConsent()));
    cookies = 'boardsesh-consent=v1.granted.1760000001.web';
    consent.refreshWebConsent();
    expect(listenerGrants).toEqual([false]);
    expect(consent.hasAnalyticsConsent()).toBe(false);
  });
  it('holds a stored grant until the account resolves, then honors a cross-origin denial on the next capture check', async () => {
    cookies = 'boardsesh-consent=v1.granted.1760000000.web';
    const consent = await import('../consent');
    expect(consent.hasAnalyticsConsent()).toBe(false);
    consent.setConsentAccountResolved(true);
    expect(consent.hasAnalyticsConsent()).toBe(true);
    cookies = 'boardsesh-consent=v1.denied.1760000001.web';
    expect(consent.hasAnalyticsConsent()).toBe(false);
    expect(consent.getWebConsentRecord()?.analytics).toBe('denied');
  });

  it.each([
    'v0.granted.1760000000.web',
    'v1.maybe.1760000000.web',
    'v1.granted.wrong.web',
    'v1.granted.1760000000.unknown',
  ])('does not grant or hide the prompt for %s', async (cookie) => {
    cookies = `boardsesh-consent=${cookie}`;
    const consent = await import('../consent');
    expect(consent.hasAnalyticsConsent()).toBe(false);
    runInNewContext(consent.CONSENT_PREPAINT_SCRIPT, { document });
    expect(document.documentElement.dataset.consent).toBeUndefined();
  });
  it('pre-paint recognizes the same valid cookie without a server cookie read', async () => {
    cookies = 'boardsesh-consent=v1.denied.1760000000.web';
    const consent = await import('../consent');
    runInNewContext(consent.CONSENT_PREPAINT_SCRIPT, { document });
    expect(document.documentElement.dataset.consent).toBe('denied');
  });
  it.each([
    ['https://www.boardsesh.com/', true],
    ['https://app.boardsesh.com/', true],
    ['http://localhost:3000/', false],
    ['https://42.preview.boardsesh.com/', false],
  ])('writes correct scope on %s', async (url, shared) => {
    Object.defineProperty(window, 'location', { configurable: true, value: new URL(url) });
    const consent = await import('../consent');
    consent.writeWebConsent({ analytics: 'denied', version: 1, source: 'web', decidedAt: '2026-10-08T00:00:00Z' });
    expect(written.includes('Domain=.boardsesh.com')).toBe(shared);
    expect(written.includes('; Secure')).toBe(url.startsWith('https:'));
    expect(written).toContain('SameSite=Lax');
    expect(written).toContain('Max-Age=31536000');
  });
});
