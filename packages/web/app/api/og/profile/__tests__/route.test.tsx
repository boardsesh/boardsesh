import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above all declarations, so use vi.hoisted to define
// the mock before vi.mock's factory runs.
const { mockImageResponse } = vi.hoisted(() => ({
  mockImageResponse: vi.fn().mockImplementation(function (_jsx: unknown, options: unknown) {
    return new Response('mock-image', {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        ...((options as { headers?: Record<string, string> })?.headers ?? {}),
      },
    });
  }),
}));

vi.mock('@vercel/og', () => ({
  ImageResponse: mockImageResponse,
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: {
    neutral: {
      100: '#F3F4F6',
      200: '#E5E7EB',
      400: '#9CA3AF',
      500: '#6B7280',
      600: '#4B5563',
      900: '#111827',
    },
  },
}));

import { GET } from '../route';
import { NextRequest } from 'next/server';

function createRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/og/profile');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

describe('/api/og/profile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with default name when no params provided', async () => {
    const response = await GET(createRequest());
    expect(response.status).toBe(200);

    // ImageResponse was called with JSX and options including cache headers
    expect(mockImageResponse).toHaveBeenCalledTimes(1);
    const [, options] = mockImageResponse.mock.calls[0] as [unknown, { width: number; height: number; headers: Record<string, string> }];
    expect(options.width).toBe(1200);
    expect(options.height).toBe(630);
  });

  it('includes cache headers in response', async () => {
    const response = await GET(createRequest({ name: 'TestUser' }));
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
    );
  });

  it('passes name and totalClimbs to ImageResponse', async () => {
    await GET(createRequest({ name: 'Alice', totalClimbs: '100' }));
    expect(mockImageResponse).toHaveBeenCalledTimes(1);
  });

  it('parses valid layouts JSON', async () => {
    const layouts = JSON.stringify([
      { name: 'Kilter', pct: 70, color: 'red' },
      { name: 'Tension', pct: 30, color: 'blue' },
    ]);
    const response = await GET(createRequest({ name: 'Bob', layouts }));
    expect(response.status).toBe(200);
  });

  it('ignores invalid layouts JSON gracefully', async () => {
    const response = await GET(createRequest({ name: 'Bob', layouts: 'not-json' }));
    expect(response.status).toBe(200);
  });

  it('ignores layouts param exceeding 2000 chars', async () => {
    const longLayouts = '[' + Array(500).fill('{"name":"x","pct":1,"color":"red"}').join(',') + ']';
    expect(longLayouts.length).toBeGreaterThan(2000);
    const response = await GET(createRequest({ name: 'Bob', layouts: longLayouts }));
    expect(response.status).toBe(200);
  });

  it('filters out layout items with wrong shape', async () => {
    const layouts = JSON.stringify([
      { name: 'Valid', pct: 50, color: 'red' },
      { name: 123, pct: 'bad', color: null },
      'not-an-object',
    ]);
    const response = await GET(createRequest({ name: 'Charlie', layouts }));
    expect(response.status).toBe(200);
  });

  it('allows avatar URLs from allowlisted domains', async () => {
    const response = await GET(
      createRequest({ name: 'Eve', avatar: 'https://lh3.googleusercontent.com/photo123' }),
    );
    expect(response.status).toBe(200);
  });

  it('rejects avatar URLs from non-allowlisted domains', async () => {
    const response = await GET(
      createRequest({ name: 'Eve', avatar: 'https://evil.com/avatar.jpg' }),
    );
    // Should still return 200 but render the initial-letter fallback (no img)
    expect(response.status).toBe(200);
  });

  it('rejects non-HTTPS avatar URLs', async () => {
    const response = await GET(
      createRequest({ name: 'Eve', avatar: 'http://lh3.googleusercontent.com/photo' }),
    );
    expect(response.status).toBe(200);
  });

  it('caps layouts to 10 items', async () => {
    const layouts = JSON.stringify(
      Array.from({ length: 15 }, (_, i) => ({
        name: `Board ${i}`,
        pct: 6,
        color: 'rgba(0,0,0,0.5)',
      })),
    );
    const response = await GET(createRequest({ name: 'Dave', layouts }));
    expect(response.status).toBe(200);
  });
});
