// @vitest-environment node
/**
 * #7596 deleted the www browser coordinator: its utility frame at
 * `/auth/browser-coordinator`, the two `/api/internal/auth/browser-coordinator`
 * routes and the session provider preflight. The frame path had its own
 * frameable header rule in next.config.mjs and a middleware carve-out. This file
 * pins that both are gone, so the old path is treated like any other page, and
 * that the site-wide frame-denying default skips embeds only again.
 */
import type { NextConfig } from 'next';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vite-plus/test';

await vi.hoisted(async () => {
  // Next's standalone config tester needs the platform AsyncLocalStorage global.
  const { AsyncLocalStorage } = await import('node:async_hooks');
  vi.stubGlobal('AsyncLocalStorage', AsyncLocalStorage);
});
afterAll(() => vi.unstubAllGlobals());

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const nextConfig = (await import('../../next.config.mjs')).default as unknown as NextConfig;
const { middleware } = await import('@/middleware');

const FORMER_FRAME_PATH = '/auth/browser-coordinator';
// An ordinary auth page with no rule or carve-out of its own.
const ORDINARY_PAGE_PATH = '/auth/login';

async function configuredHeaders(pathname: string): Promise<[string, string][]> {
  const response = await unstable_getResponseFromNextConfig({
    url: `https://www.boardsesh.com${pathname}`,
    nextConfig: { headers: nextConfig.headers },
  });
  // Header iteration is already sorted by name (Fetch spec).
  return [...response.headers.entries()];
}

function middlewareDecision(pathname: string, search: string, headers: Record<string, string>) {
  const response = middleware(new NextRequest(`https://www.boardsesh.com${pathname}${search}`, { headers }));
  return {
    status: response.status,
    headers: [...response.headers.entries()],
  };
}

describe('deleted www browser coordinator', () => {
  it('leaves no frame page, route or route helper behind', () => {
    const surviving = [
      'app/auth/browser-coordinator',
      'app/api/internal/auth/browser-coordinator',
      'app/lib/auth/browser-coordinator-routes.server.ts',
      'app/lib/auth/browser-coordinator-client.ts',
      'app/lib/auth/browser-coordinator-readiness.ts',
      'app/lib/auth/canonical-browser-origin.ts',
    ].filter((path) => existsSync(join(WEB_ROOT, path)));
    expect(surviving).toEqual([]);
  });

  it('keeps one frame-denying default that skips only embeds', async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const sameOrigin = rules.filter((rule) =>
      rule.headers.some((header) => header.key === 'X-Frame-Options' && header.value === 'SAMEORIGIN'),
    );
    expect(sameOrigin.map((rule) => rule.source)).toEqual(['/((?!embed/).*)']);
    expect(rules.filter((rule) => rule.source.includes('browser-coordinator'))).toEqual([]);
  });

  it('serves the former frame path the same headers as an ordinary auth page', async () => {
    const formerFrame = await configuredHeaders(FORMER_FRAME_PATH);
    expect(formerFrame).toEqual(await configuredHeaders(ORDINARY_PAGE_PATH));
    expect(formerFrame).toContainEqual(['x-frame-options', 'SAMEORIGIN']);
    expect(formerFrame.map(([name]) => name)).not.toContain('content-security-policy');
  });

  it.each([
    ['a plain visit', '', { 'user-agent': 'Mozilla/5.0' }],
    ['a sticky locale cookie', '', { 'user-agent': 'Mozilla/5.0', cookie: 'boardsesh-locale=fr' }],
    ['a legacy ?session= link', '?session=party-123', { 'user-agent': 'Mozilla/5.0' }],
  ])('gives the former frame path ordinary page middleware for %s', (_case, search, headers) => {
    // A ?session= redirect sets a cookie whose Expires is derived from now.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
    try {
      const formerFrame = middlewareDecision(FORMER_FRAME_PATH, search, headers);
      const ordinaryPage = middlewareDecision(ORDINARY_PAGE_PATH, search, headers);
      expect(JSON.stringify(formerFrame).replaceAll(FORMER_FRAME_PATH, ORDINARY_PAGE_PATH)).toBe(
        JSON.stringify(ordinaryPage),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
