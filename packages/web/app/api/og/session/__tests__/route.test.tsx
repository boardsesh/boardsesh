// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { GET } from '../route';

const sessionRouteState = vi.hoisted(() => ({
  getSessionOgSummaryMock: vi.fn(),
  capturedElement: null as unknown,
  backendOrigin: 'https://ws.boardsesh.com' as string | null,
}));

vi.mock('@/app/lib/backend-url', () => ({
  getPublicBackendHttpUrl: () => sessionRouteState.backendOrigin,
}));

vi.mock('@/app/lib/seo/dynamic-og-data', () => ({
  getSessionOgSummary: sessionRouteState.getSessionOgSummaryMock,
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: {
    neutral: {
      300: '#2A2A2A',
      400: '#B0B0B0',
      500: '#8A8A8A',
      600: '#B0B0B0',
      700: '#D0D0D0',
      900: '#F5F5F5',
    },
    colors: {
      primary: '#123456',
      accentGreen: '#22AA88',
      accentRose: '#CC6677',
    },
    semantic: {
      background: '#000000',
      surface: '#0A0A0A',
      surfaceElevated: '#121212',
    },
    shadows: {
      md: '0 4px 6px rgba(0,0,0,0.2)',
      lg: '0 10px 15px rgba(0,0,0,0.3)',
    },
  },
}));

vi.mock('@/app/lib/grade-colors', () => ({
  FONT_GRADE_COLORS: {
    v5: '#00AAFF',
  },
  getGradeColorWithOpacity: vi.fn(() => 'rgba(0, 170, 255, 0.5)'),
}));

vi.mock('@/app/lib/board-data', () => ({
  BOULDER_GRADES: [{ difficulty_id: 10, font_grade: 'V5' }],
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
    sessionRouteState.capturedElement = element;
    return new Response('mock-image', {
      status: 200,
      headers: new Headers(init?.headers),
    });
  }),
}));

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/og/session');
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

function collectImageSources(node: unknown): string[] {
  if (!node || typeof node !== 'object') {
    return [];
  }

  if (Array.isArray(node)) {
    return node.flatMap(collectImageSources);
  }

  const typedNode = node as { type?: unknown; props?: { src?: string; children?: unknown } };
  const sources = typedNode.type === 'img' && typeof typedNode.props?.src === 'string' ? [typedNode.props.src] : [];

  return [...sources, ...collectImageSources(typedNode.props?.children)];
}

describe('api/og/session legacy redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionRouteState.backendOrigin = 'https://ws.boardsesh.com';
  });

  it('sends a recap URL to the backend card, carrying the version token', async () => {
    const response = await GET(makeRequest({ sessionId: 'session-123', v: 'abc123' }));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://ws.boardsesh.com/og/session?sessionId=session-123&v=abc123');
    expect(sessionRouteState.getSessionOgSummaryMock).not.toHaveBeenCalled();
  });

  it('keeps the join variant on the way through', async () => {
    const response = await GET(makeRequest({ sessionId: 'session-123', variant: 'join' }));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://ws.boardsesh.com/og/session?sessionId=session-123&variant=join',
    );
  });

  it('drops parameters the backend card does not read', async () => {
    const response = await GET(makeRequest({ sessionId: 'session-123', extra: 'x' }));

    expect(response.headers.get('location')).toBe('https://ws.boardsesh.com/og/session?sessionId=session-123');
  });

  it('answers 400 with no session id, as before', async () => {
    const response = await GET(makeRequest({}));

    expect(response.status).toBe(400);
  });

  it('answers an uncached 404 when there is no backend origin to send the reader to', async () => {
    sessionRouteState.backendOrigin = null;

    const response = await GET(makeRequest({ sessionId: 'session-123' }));

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('api/og/session daily feed groups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionRouteState.capturedElement = null;
  });

  it('still draws a daily group here, since the backend refuses those ids', async () => {
    sessionRouteState.getSessionOgSummaryMock.mockResolvedValue({
      sessionType: 'party',
      sessionName: 'Lunch Laps',
      leaderName: 'Alex',
      participantNames: ['Alex', 'Sam'],
      participantCount: 2,
      totalSends: 5,
      gradeRows: [{ difficulty: 10, count: 3 }],
      boardLabel: 'Kilter Original 12x12',
      boardAngle: 40,
      boardPreviewPath:
        '/api/internal/board-render?board_name=kilter&frames=&thumbnail=1&include_background=1&format=png',
      version: 'abc123',
      found: true,
    });

    const response = await GET(makeRequest({ sessionId: 'daily:user-1:2026-11-01', variant: 'join', v: 'abc123' }));
    const textContent = collectText(sessionRouteState.capturedElement);
    const imageSources = collectImageSources(sessionRouteState.capturedElement);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(textContent).toContain('Join Alex on the wall');
    expect(textContent).toContain('Lunch Laps');
    expect(textContent).toContain('Kilter Original 12x12');
    expect(textContent).toContain('40°');
    expect(textContent).toContain('2 climbers');
    expect(textContent).toContain('5 sends so far');
    expect(textContent).toContain('Grades climbed so far');
    expect(textContent).toContain('V5');
    expect(imageSources).toContain(
      'http://localhost:3000/api/internal/board-render?board_name=kilter&frames=&thumbnail=1&include_background=1&format=png',
    );
  });

  it('returns 404 when the session summary is not found', async () => {
    sessionRouteState.getSessionOgSummaryMock.mockResolvedValue({
      sessionType: null,
      sessionName: 'Climbing Session',
      leaderName: null,
      participantNames: [],
      participantCount: 0,
      totalSends: 0,
      gradeRows: [],
      boardLabel: null,
      boardAngle: null,
      boardPreviewPath: null,
      version: '0',
      found: false,
    });

    const response = await GET(makeRequest({ sessionId: 'daily:user-1:2026-11-02' }));

    expect(response.status).toBe(404);
  });
});
