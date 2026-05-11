// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { GET } from '../route';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/analytics.server', () => ({
  trackServer: vi.fn(),
}));

const playlistRouteState = vi.hoisted(() => ({
  getPlaylistOgSummaryMock: vi.fn(),
  capturedElement: null as unknown,
}));

vi.mock('@/app/lib/seo/dynamic-og-data', () => ({
  getPlaylistOgSummary: playlistRouteState.getPlaylistOgSummaryMock,
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: {
    neutral: {
      300: '#D0D0D0',
      400: '#B0B0B0',
      500: '#909090',
      600: '#707070',
      900: '#101010',
    },
    colors: {
      primary: '#123456',
    },
  },
}));

vi.mock('@/app/lib/string-utils', () => ({
  formatBoardDisplayName: vi.fn((boardType: string) => {
    if (boardType === 'moonboard') return 'MoonBoard';
    return boardType.charAt(0).toUpperCase() + boardType.slice(1);
  }),
}));

vi.mock('@/app/lib/seo/og', () => ({
  OG_IMAGE_WIDTH: 1200,
  OG_IMAGE_HEIGHT: 630,
  createOgImageHeaders: vi.fn(
    ({ contentType, version, serverTiming }: { contentType: string; version?: string; serverTiming?: string }) => ({
      'Content-Type': contentType,
      'Cache-Control': version
        ? 'public, max-age=31536000, s-maxage=31536000, immutable'
        : 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400',
      'CDN-Cache-Control': version
        ? 'public, s-maxage=31536000, immutable'
        : 'public, s-maxage=300, stale-while-revalidate=86400',
      'Vercel-CDN-Cache-Control': version
        ? 'public, s-maxage=31536000, immutable'
        : 'public, s-maxage=300, stale-while-revalidate=86400',
      'Server-Timing': serverTiming ?? '',
    }),
  ),
}));

vi.mock('@vercel/og', () => ({
  ImageResponse: vi.fn(function ImageResponse(element: unknown, init?: ResponseInit) {
    playlistRouteState.capturedElement = element;
    return new Response('mock-image', {
      status: 200,
      headers: new Headers(init?.headers),
    });
  }),
}));

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/og/playlist');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

function collectText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }

  if (!node || typeof node !== 'object') {
    return '';
  }

  if (Array.isArray(node)) {
    return node.map(collectText).join(' ');
  }

  const children = (node as { props?: { children?: unknown } }).props?.children;
  return collectText(children);
}

describe('api/og/playlist route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    playlistRouteState.capturedElement = null;
  });

  it('renders a playlist OG image with ASCII-safe fallback markup and truncated copy', async () => {
    playlistRouteState.getPlaylistOgSummaryMock.mockResolvedValue({
      name: 'A very long playlist name that should be shortened for the OG image',
      description:
        'This description is intentionally much longer than the OG image should render so the route has to trim it before handing the tree to ImageResponse.',
      color: '',
      icon: '',
      isPublic: true,
      boardType: 'kilter',
      climbCount: 12,
      version: 'abc123',
    });

    const response = await GET(makeRequest({ uuid: 'playlist-123', v: 'abc123' }));
    const textContent = collectText(playlistRouteState.capturedElement);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Cache-Control')).toContain('immutable');
    expect(textContent).toContain('AV');
    expect(textContent).toContain('A very long playlist name that...');
    expect(textContent).toContain(
      'This description is intentionally much longer than the OG image should render so the route has to trim it before hand...',
    );
    expect(textContent).not.toContain('before handing the tree to ImageResponse.');
    expect(textContent).toContain('12');
    expect(textContent).toContain('Kilter');
    expect(textContent).not.toContain('\u{1F3B5}');
  });

  it('returns 404 for private playlists', async () => {
    playlistRouteState.getPlaylistOgSummaryMock.mockResolvedValue({
      name: 'Private Playlist',
      description: null,
      color: null,
      icon: null,
      isPublic: false,
      boardType: 'kilter',
      climbCount: 0,
      version: 'abc123',
    });

    const response = await GET(makeRequest({ uuid: 'private-playlist' }));

    expect(response.status).toBe(404);
  });
});
