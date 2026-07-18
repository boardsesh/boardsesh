import { createRequire } from 'node:module';
import { describe, expect, it } from 'vite-plus/test';
import { NextRequest } from 'next/server';

// The /app response-header set lives in three places that external rewrites and
// Metro can each serve independently: this middleware, next.config's headers(),
// and Metro's expo-web-response-headers.cjs. Each already has its own test, so a
// divergence (e.g. tightening HSTS in one) would leave every suite green. Pin
// all three to a single canonical source — the Metro `.cjs` constant — so drift
// fails loudly here.
const require = createRequire(import.meta.url);
const { EXPO_WEB_SECURITY_HEADERS, EXPO_WEB_ROBOTS_VALUE } =
  require('../../../mobile/expo-web-response-headers.cjs') as {
    EXPO_WEB_SECURITY_HEADERS: Record<string, string>;
    EXPO_WEB_ROBOTS_VALUE: string;
  };

const { middleware } = await import('@/middleware');

type Header = { source: string; headers: Array<{ key: string; value: string }> };
type NextConfigWithHeaders = { headers?: () => Promise<Header[]> };
const nextConfig = (await import('../../next.config.mjs')).default as unknown as NextConfigWithHeaders;

function headerMap(headers: Array<{ key: string; value: string }>): Record<string, string> {
  return Object.fromEntries(headers.map(({ key, value }) => [key, value]));
}

describe('/app security-header parity across middleware, next.config, and Metro', () => {
  it('middleware serves exactly the canonical Metro header set on /app', () => {
    const response = middleware(new NextRequest(new URL('/app', 'http://localhost:3000')));

    expect(response.headers.get('X-Robots-Tag')).toBe(EXPO_WEB_ROBOTS_VALUE);
    for (const [name, value] of Object.entries(EXPO_WEB_SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });

  it('next.config /app rule and global security rule match the canonical Metro headers', async () => {
    const headers = (await nextConfig.headers?.()) ?? [];

    const appRule = headers.find(({ source }) => source === '/app/:path*');
    expect(headerMap(appRule?.headers ?? [])['X-Robots-Tag']).toBe(EXPO_WEB_ROBOTS_VALUE);

    // /app responses inherit the global (non-embed) security headers.
    const globalRule = headers.find(({ source }) => source === '/((?!embed/).*)');
    const globalHeaders = headerMap(globalRule?.headers ?? []);
    for (const [name, value] of Object.entries(EXPO_WEB_SECURITY_HEADERS)) {
      expect(globalHeaders[name]).toBe(value);
    }
  });
});
