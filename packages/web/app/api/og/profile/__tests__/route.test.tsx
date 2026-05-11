// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const trackServerMock = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/analytics.server', () => ({
  trackServer: trackServerMock,
}));

const getProfileOgSummaryMock = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/seo/dynamic-og-data', () => ({
  getProfileOgSummary: getProfileOgSummaryMock,
}));

const sqlExec = vi.hoisted(() => vi.fn(async () => ({ rows: [] })));
vi.mock('@/app/lib/db/db', () => ({
  getReadPool: () => sqlExec,
  rowsFromResult: vi.fn(() => []),
}));

vi.mock('@vercel/og', () => ({
  ImageResponse: class {
    constructor() {
      return new Response('img', { status: 200 });
    }
  },
}));

import { GET } from '../route';

function makeRequest(userId?: string): NextRequest {
  const url = new URL('http://localhost:3000/api/og/profile');
  if (userId !== undefined) url.searchParams.set('user_id', userId);
  return new NextRequest(url);
}

describe('api/og/profile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlExec.mockResolvedValue({ rows: [] });
  });

  it('returns 400 when user_id is missing and does not track', async () => {
    const response = await GET(makeRequest());
    expect(response.status).toBe(400);
    expect(trackServerMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the profile is not found and does not track', async () => {
    getProfileOgSummaryMock.mockResolvedValue(null);
    const response = await GET(makeRequest('missing-user'));
    expect(response.status).toBe(404);
    expect(trackServerMock).not.toHaveBeenCalled();
  });

  it('tracks OG Image Requested with kind=profile when the profile exists', async () => {
    getProfileOgSummaryMock.mockResolvedValue({
      displayName: 'Marco',
      avatarUrl: null,
      fallbackImageUrl: null,
      version: 'v1',
    });

    const response = await GET(makeRequest('user-42'));

    expect(response.status).toBe(200);
    expect(trackServerMock).toHaveBeenCalledWith('OG Image Requested', {
      distinctId: 'og-bot',
      properties: expect.objectContaining({
        kind: 'profile',
        userId: 'user-42',
      }),
    });
  });
});
