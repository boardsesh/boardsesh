// @vitest-environment node
import type { NextConfig } from 'next';
import { unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';
import { afterAll, describe, expect, it, vi } from 'vite-plus/test';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@boardsesh/i18n';

await vi.hoisted(async () => {
  // Next's server bootstrap provides this platform global. Its standalone
  // public config tester needs the same Node primitive, never a fake context.
  const { AsyncLocalStorage } = await import('node:async_hooks');
  vi.stubGlobal('AsyncLocalStorage', AsyncLocalStorage);
});
afterAll(() => vi.unstubAllGlobals());

const nextConfig = (await import('../../next.config.mjs')).default as unknown as NextConfig;
const localePrefixes = SUPPORTED_LOCALES.map((locale) => (locale === DEFAULT_LOCALE ? '' : `/${locale}`));

async function configuredHeaders(pathname: string) {
  // Use Next's public route matcher and header precedence, rather than a
  // hand-written matcher or merely asserting that a rule exists in the array.
  return unstable_getResponseFromNextConfig({
    url: `https://www.boardsesh.com${pathname}`,
    nextConfig: { headers: nextConfig.headers },
  });
}

describe('verification credential URL header precedence', () => {
  it.each(localePrefixes)('keeps %s verification links private after the global header rule', async (prefix) => {
    const response = await configuredHeaders(`${prefix}/api/auth/verify-email?token=synthetic-credential`);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('protects the trailing-slash canonicalization response', async () => {
    expect((await configuredHeaders('/fr/api/auth/verify-email/')).headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  // The pinned public tester matches a serialized regex without its case flag.
  // The actual server's uppercase-path privacy was checked separately over HTTP;
  // this suite makes no case-insensitive matching claim for that test helper.

  it.each(['/', '/about', '/es/settings', '/api/auth/session', '/api/auth/verify-email-extra', '/embed/board/example'])(
    'retains the existing site policy at %s',
    async (pathname) => {
      expect((await configuredHeaders(pathname)).headers.get('Referrer-Policy')).toBe(
        'strict-origin-when-cross-origin',
      );
    },
  );
});
