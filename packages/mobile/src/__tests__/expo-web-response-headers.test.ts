import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { EXPO_WEB_ROBOTS_VALUE, EXPO_WEB_SECURITY_HEADERS, applyExpoWebResponseHeaders, isExpoWebAppRequest } =
  require('../../expo-web-response-headers.cjs') as {
    EXPO_WEB_ROBOTS_VALUE: string;
    EXPO_WEB_SECURITY_HEADERS: Record<string, string>;
    applyExpoWebResponseHeaders: (
      response: { setHeader: (name: string, value: string) => void },
      webFlag: string | undefined,
      rawUrl: string | undefined,
    ) => void;
    isExpoWebAppRequest: (webFlag: string | undefined, rawUrl: string | undefined) => boolean;
  };

describe('Expo web response headers', () => {
  it.each(['/app', '/app/', '/app/auth/login', '/app/(tabs)/climbs?sort=popular'])('marks %s as Expo web', (url) => {
    expect(isExpoWebAppRequest('1', url)).toBe(true);
  });

  it.each([
    [undefined, '/app'],
    ['0', '/app'],
    ['1', '/application'],
    ['1', '/assets'],
    ['1', undefined],
  ])('does not mark non-web or unrelated request %j, %j', (webFlag, url) => {
    expect(isExpoWebAppRequest(webFlag, url)).toBe(false);
  });

  it('sets noindex and the standard security headers on the Metro response', () => {
    const setHeader = vi.fn();

    applyExpoWebResponseHeaders({ setHeader }, '1', '/app/play?session=crew');

    expect(setHeader).toHaveBeenCalledWith('X-Robots-Tag', EXPO_WEB_ROBOTS_VALUE);
    expect(EXPO_WEB_ROBOTS_VALUE).toBe('noindex, follow');
    for (const [name, value] of Object.entries(EXPO_WEB_SECURITY_HEADERS)) {
      expect(setHeader).toHaveBeenCalledWith(name, value);
    }
    // Metro serves dev over http://localhost, so it must never send HSTS.
    expect(EXPO_WEB_SECURITY_HEADERS['Strict-Transport-Security']).toBeUndefined();
    expect(setHeader).not.toHaveBeenCalledWith('Strict-Transport-Security', expect.anything());
  });

  it('does not change native Metro responses', () => {
    const setHeader = vi.fn();

    applyExpoWebResponseHeaders({ setHeader }, undefined, '/app');

    expect(setHeader).not.toHaveBeenCalled();
  });
});
