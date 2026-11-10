// @vitest-environment node
import type { NextConfig } from 'next';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';
import RenderResult from 'next/dist/server/render-result';
import { sendRenderResult } from 'next/dist/server/send-payload';
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
  // This does not render an App Router page: Next's dev renderer can replace
  // Cache-Control afterward. Its production sender is exercised below.
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

  it('evaluates the configured rule for a trailing-slash path', async () => {
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

describe('pinned Next production render response cache policy', () => {
  async function renderResponse(configured?: Headers) {
    const socket = new Socket();
    const request = new IncomingMessage(socket);
    request.method = 'GET';
    const response = new ServerResponse(request);
    for (const [name, content] of configured ?? []) response.setHeader(name, content);
    try {
      // Exercise the installed response sender used by production rendering,
      // without a build or a second application server. This is not full SSR.
      await sendRenderResult({
        req: request,
        res: response,
        result: RenderResult.fromStatic('<p>Owned cache fixture</p>', 'text/html; charset=utf-8'),
        cacheControl: { revalidate: 0, expire: undefined },
        generateEtags: false,
        poweredByHeader: false,
      });
      return response.getHeaders();
    } finally {
      response.destroy();
      request.destroy();
      socket.destroy();
    }
  }

  it('prevents storage with production dynamic cache settings and no configured header', async () => {
    const headers = await renderResponse();
    const directives = String(headers['cache-control'])
      .split(',')
      .map((directive) => directive.trim());
    expect(directives).toContain('private');
    expect(directives).toContain('no-store');
  });

  it('preserves configured recovery privacy headers through production response sending', async () => {
    const configured = await configuredHeaders('/fr/auth/reset-password');
    const headers = await renderResponse(configured.headers);
    expect(headers['cache-control']).toBe(configured.headers.get('Cache-Control'));
    expect(headers['cdn-cache-control']).toBe('no-store');
    expect(headers['vercel-cdn-cache-control']).toBe('no-store');
    expect(headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('password recovery configuration header precedence', () => {
  const paths = localePrefixes.flatMap((prefix) =>
    ['/auth/reset-password', '/api/auth/forgot-password', '/api/auth/reset-password'].map(
      (pathname) => `${prefix}${pathname}`,
    ),
  );

  it.each(paths)('protects %s after the global header rule', async (pathname) => {
    const response = await configuredHeaders(`${pathname}?token=synthetic-capability&email=owner%40example.test`);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0, must-revalidate');
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, follow');
    expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it.each(['/auth/reset-password/', '/fr/auth/reset-password/', '/es/api/auth/reset-password/'])(
    'evaluates the configured trailing-slash rule at %s',
    async (pathname) => {
      // This public tester evaluates configuration, not the server's earlier
      // automatic 308. Live first-hop redirect privacy remains an ingress gate.
      const response = await configuredHeaders(pathname);
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('Cache-Control')).toContain('no-store');
    },
  );

  it.each(['/auth/login', '/es/auth/login', '/auth/reset-password-help', '/api/auth/reset-password-extra'])(
    'retains the unrelated site policy at %s',
    async (pathname) => {
      const response = await configuredHeaders(pathname);
      expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    },
  );
});

describe('partner app sign-in and consent pages', () => {
  const paths = localePrefixes.flatMap((prefix) =>
    ['/oauth/sign-in', '/oauth/consent'].map((pathname) => `${prefix}${pathname}`),
  );

  it.each(paths)('keeps %s out of frames, Referers, caches and search', async (pathname) => {
    const response = await configuredHeaders(`${pathname}?client_id=bsk_owned&state=owned-state&sig=owned-signature`);
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0, must-revalidate');
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, follow');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it.each(['/auth/login', '/oauthentication', '/developers'])('leaves %s on the site policy', async (pathname) => {
    const response = await configuredHeaders(pathname);
    expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});

describe('developer console', () => {
  it.each(localePrefixes.map((prefix) => `${prefix}/developers/apps`))(
    'keeps %s, which shows a client secret once, out of frames, caches and search',
    async (pathname) => {
      const response = await configuredHeaders(pathname);
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0, must-revalidate');
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, follow');
    },
  );
});

describe('OAuth credential response configuration precedence', () => {
  const paths = localePrefixes.flatMap((prefix) =>
    ['google', 'apple', 'facebook'].flatMap((provider) =>
      ['signin', 'callback'].map((action) => `${prefix}/api/auth/${action}/${provider}`),
    ),
  );
  it.each(paths)('keeps %s private after the site-wide rule', async (pathname) => {
    const response = await configuredHeaders(`${pathname}?state=owned-state&code=owned-provider-code`);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, follow');
  });
  it('protects the canonical opaque Apple continuation without affecting the session endpoint', async () => {
    const response = await configuredHeaders('/api/auth/callback/apple?boardseshOAuthContinue=owned-scope');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect((await configuredHeaders('/api/auth/session')).headers.get('Referrer-Policy')).toBe(
      'strict-origin-when-cross-origin',
    );
  });
});
