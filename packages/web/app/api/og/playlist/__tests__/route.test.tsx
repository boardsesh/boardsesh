// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { GET } from '../route';

const playlistRouteState = vi.hoisted(() => ({
  getPlaylistOgSummaryMock: vi.fn(),
  capturedElement: null as unknown,
  capturedOptions: null as ({ emoji?: string } & ResponseInit) | null,
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
  ImageResponse: vi.fn(function ImageResponse(element: unknown, init?: { emoji?: string } & ResponseInit) {
    playlistRouteState.capturedElement = element;
    playlistRouteState.capturedOptions = init ?? null;
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
    playlistRouteState.capturedOptions = null;
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

  it.each([
    ['a ZWJ emoji', '🧗‍♀️'],
    ['a flag', '🇫🇷'],
    ['a keycap', '1️⃣'],
  ])('keeps %s as one grapheme in the playlist mark', async (_label, icon) => {
    playlistRouteState.getPlaylistOgSummaryMock.mockResolvedValue({
      name: 'Emoji Playlist',
      description: null,
      color: '#123456',
      icon: `${icon} extra`,
      isPublic: true,
      boardType: 'kilter',
      climbCount: 1,
      version: 'emoji-test',
    });

    const response = await GET(makeRequest({ uuid: 'emoji-playlist' }));
    const textContent = collectText(playlistRouteState.capturedElement);

    expect(response.status).toBe(200);
    expect(playlistRouteState.capturedOptions?.emoji).toBe('twemoji');
    expect(textContent).toContain(icon);
  });

  it('retains ASCII identifiers in the playlist mark', async () => {
    playlistRouteState.getPlaylistOgSummaryMock.mockResolvedValue({
      name: 'Steep Projects',
      description: null,
      color: '#123456',
      icon: 'StarOutlined',
      isPublic: true,
      boardType: 'kilter',
      climbCount: 1,
      version: 'ascii-test',
    });

    await GET(makeRequest({ uuid: 'ascii-playlist' }));
    expect(collectText(playlistRouteState.capturedElement)).toContain('ST');
  });

  it('falls back to playlist initials when the icon is empty', async () => {
    playlistRouteState.getPlaylistOgSummaryMock.mockResolvedValue({
      name: 'Steep Projects',
      description: null,
      color: '#123456',
      icon: '',
      isPublic: true,
      boardType: 'kilter',
      climbCount: 1,
      version: 'initials-test',
    });

    await GET(makeRequest({ uuid: 'initials-playlist' }));
    expect(collectText(playlistRouteState.capturedElement)).toContain('SP');
  });

  it('redirects to the branded fallback card instead of leaking the underlying error', async () => {
    playlistRouteState.getPlaylistOgSummaryMock.mockRejectedValue(
      Object.assign(new Error('Failed query: SELECT * FROM playlists WHERE uuid = $1 params: leaky-playlist'), {
        name: 'DrizzleQueryError',
      }),
    );

    const response = await GET(makeRequest({ uuid: 'leaky-playlist' }));
    const body = await response.text();

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/opengraph-image');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, s-maxage=60');
    expect(body).not.toContain('SELECT');
    expect(body).not.toContain('leaky-playlist');
  });
});
