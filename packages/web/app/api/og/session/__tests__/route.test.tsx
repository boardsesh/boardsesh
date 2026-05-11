// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { GET } from '../route';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/analytics.server', () => ({
  trackServer: vi.fn(),
}));

const sessionRouteState = vi.hoisted(() => ({
  getSessionOgSummaryMock: vi.fn(),
  capturedElement: null as unknown,
}));

vi.mock('@/app/lib/seo/dynamic-og-data', () => ({
  getSessionOgSummary: sessionRouteState.getSessionOgSummaryMock,
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: {
    neutral: {
      300: '#D0D0D0',
      400: '#B0B0B0',
      500: '#909090',
      600: '#6C6C6C',
      700: '#4C4C4C',
      900: '#101010',
    },
    colors: {
      primary: '#123456',
      accentGreen: '#22AA88',
      accentRose: '#CC6677',
    },
  },
  darkTokens: {
    neutral: {
      300: '#2A2A2A',
      500: '#8A8A8A',
      600: '#B0B0B0',
      700: '#D0D0D0',
      900: '#F5F5F5',
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

describe('api/og/session route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionRouteState.capturedElement = null;
  });

  it('renders the join variant with immutable PNG headers', async () => {
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

    const response = await GET(makeRequest({ sessionId: 'session-123', variant: 'join', v: 'abc123' }));
    const textContent = collectText(sessionRouteState.capturedElement);
    const imageSources = collectImageSources(sessionRouteState.capturedElement);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Cache-Control')).toContain('immutable');
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

    const response = await GET(makeRequest({ sessionId: 'missing-session' }));

    expect(response.status).toBe(404);
  });
});
