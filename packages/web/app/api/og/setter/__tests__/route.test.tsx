// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const trackServerMock = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/analytics.server', () => ({
  trackServer: trackServerMock,
}));

const getSetterOgSummaryMock = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/seo/dynamic-og-data', () => ({
  getSetterOgSummary: getSetterOgSummaryMock,
}));

const executeRowsMock = vi.hoisted(() => vi.fn(async () => []));
vi.mock('@/app/lib/db/db', () => ({
  dbz: {},
  executeRows: executeRowsMock,
}));

vi.mock('@vercel/og', () => ({
  ImageResponse: class {
    constructor() {
      return new Response('img', { status: 200 });
    }
  },
}));

import { GET } from '../route';

function makeRequest(username?: string): NextRequest {
  const url = new URL('http://localhost:3000/api/og/setter');
  if (username !== undefined) url.searchParams.set('username', username);
  return new NextRequest(url);
}

describe('api/og/setter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeRowsMock.mockResolvedValue([]);
  });

  it('returns 400 when username is missing and does not track', async () => {
    const response = await GET(makeRequest());
    expect(response.status).toBe(400);
    expect(trackServerMock).not.toHaveBeenCalled();
  });

  it('tracks after the data fetch resolves so a query failure is not counted', async () => {
    getSetterOgSummaryMock.mockRejectedValue(new Error('db down'));
    await expect(GET(makeRequest('test-setter'))).resolves.toBeDefined();
    // The route's outer try/catch returns a 500; track must NOT have fired.
    expect(trackServerMock).not.toHaveBeenCalled();
  });

  it('tracks OG Image Requested with kind=setter on the success path', async () => {
    getSetterOgSummaryMock.mockResolvedValue({
      displayName: 'TestSetter',
      avatarUrl: null,
      version: 'v1',
    });

    const response = await GET(makeRequest('test-setter'));

    expect(response.status).toBe(200);
    expect(trackServerMock).toHaveBeenCalledWith('OG Image Requested', {
      distinctId: 'og-bot',
      properties: expect.objectContaining({
        kind: 'setter',
        username: 'test-setter',
      }),
    });
  });
});
