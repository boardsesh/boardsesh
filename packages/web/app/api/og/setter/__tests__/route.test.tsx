// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { GET } from '../route';

const backend = vi.hoisted(() => ({ origin: 'https://ws.boardsesh.com' as string | null }));

vi.mock('@/app/lib/backend-url', () => ({
  getPublicBackendHttpUrl: () => backend.origin,
}));

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/og/setter');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

describe('api/og/setter legacy redirect', () => {
  beforeEach(() => {
    backend.origin = 'https://ws.boardsesh.com';
  });

  it('sends an already-shared URL to the backend card, version token and all', () => {
    const response = GET(makeRequest({ username: 'Jimmy Webb', v: 'abc123' }));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://ws.boardsesh.com/og/setter?username=Jimmy+Webb&v=abc123');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=3600');
  });

  it('carries the id and nothing else the backend does not read', () => {
    const response = GET(makeRequest({ username: 'Jimmy Webb', utm_source: 'chat' }));

    expect(response.headers.get('location')).toBe('https://ws.boardsesh.com/og/setter?username=Jimmy+Webb');
  });

  it('answers 400 without an id, as the old route did', () => {
    const response = GET(makeRequest({}));

    expect(response.status).toBe(400);
  });

  it('answers an uncached 404 when this deployment has no backend origin', () => {
    backend.origin = null;

    const response = GET(makeRequest({ username: 'Jimmy Webb' }));

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('location')).toBeNull();
  });
});
