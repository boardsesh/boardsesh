import { describe, expect, it } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
const { default: configuration, APP_ORIGIN } = await import('../../next.config.mjs');

describe('canonical coordinator utility frame', () => {
  it('allows only the exact configured app origin and keeps other auth pages frame-denying', async () => {
    if (!configuration.headers) throw new Error('Expected configured headers');
    const rules = await configuration.headers();
    const frame = rules.find((rule) => rule.source === '/auth/browser-coordinator');
    expect(frame?.headers).toContainEqual({
      key: 'Content-Security-Policy',
      value: `frame-ancestors 'self' ${APP_ORIGIN}`,
    });
    expect(frame?.headers).not.toContainEqual(expect.objectContaining({ key: 'X-Frame-Options' }));
    expect(frame?.headers).toContainEqual({ key: 'Cache-Control', value: 'private, no-store' });
    expect(frame?.headers).toContainEqual({ key: 'X-Robots-Tag', value: 'noindex, follow' });
    const defaultRule = rules.find((rule) => rule.headers.some((header) => header.key === 'X-Frame-Options'));
    expect(defaultRule?.source).toBe('/((?!embed/|auth/browser-coordinator$).*)');
    expect(new RegExp(`^${defaultRule!.source.slice(1)}$`).test('auth/browser-coordinator')).toBe(false);
    expect(new RegExp(`^${defaultRule!.source.slice(1)}$`).test('auth/browser-coordinator/other')).toBe(true);
    expect(new RegExp(`^${defaultRule!.source.slice(1)}$`).test('auth/signin')).toBe(true);
  });
  it('does not redirect or set locale/session cookies on the utility GET', () => {
    const response = middleware(
      new NextRequest('https://www.boardsesh.test/auth/browser-coordinator?session=untrusted', {
        headers: { cookie: 'boardsesh-locale=fr', 'user-agent': 'Mozilla/5.0' },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
  });
});
