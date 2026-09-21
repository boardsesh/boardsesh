import { describe, expect, it, vi } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    locale: 'en-US',
  })),
}));

vi.mock('@/app/lib/i18n/get-locale', () => ({
  getLocale: vi.fn(async () => 'en-US'),
}));

vi.mock('@/app/components/providers/i18n-provider', () => ({
  default: ({ children }: { children?: unknown }) => children ?? null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: unknown }) => children ?? null,
}));

vi.mock('@/app/lib/seo/dynamic-og-data', () => ({
  getSessionOgSummary: vi.fn(),
}));

vi.mock('@/app/lib/board-data', () => ({
  BOULDER_GRADES: [{ difficulty_id: 10, font_grade: 'V5' }],
}));

vi.mock('@/app/lib/seo/og', () => ({
  OG_IMAGE_WIDTH: 1200,
  OG_IMAGE_HEIGHT: 630,
  buildVersionedOgImagePath: vi.fn(
    (path: string, params: Record<string, string>, version: string) =>
      `${path}?sessionId=${params.sessionId}&variant=${params.variant}&v=${version}`,
  ),
}));

vi.mock('../join-redirect', () => ({
  default: (props: { sessionId: string }) => ({ type: 'JoinRedirect', props }),
}));

const pageModule = await import('../page');
const { getSessionOgSummary } = await import('@/app/lib/seo/dynamic-og-data');
const getSessionOgSummaryMock = vi.mocked(getSessionOgSummary);

function getOpenGraphImageUrl(image: string | URL | { url: string | URL } | undefined) {
  if (!image) {
    return undefined;
  }

  if (typeof image === 'string') {
    return image;
  }

  if (image instanceof URL) {
    return image.toString();
  }

  return typeof image.url === 'string' ? image.url : image.url.toString();
}

describe('join page metadata', () => {
  it('builds host-led OG metadata for join pages', async () => {
    getSessionOgSummaryMock.mockResolvedValue({
      sessionType: 'party',
      sessionName: 'Lunch Laps',
      leaderName: 'Alex',
      participantNames: ['Alex', 'Sam'],
      participantCount: 2,
      totalSends: 5,
      gradeRows: [{ difficulty: 10, count: 5 }],
      boardType: 'kilter',
      boardLabel: 'Kilter Original 12x12',
      boardAngle: 40,
      boardPreviewPath:
        '/api/internal/board-render?board_name=kilter&frames=&thumbnail=1&include_background=1&format=png',
      version: 'abc123',
      found: true,
    });

    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({ sessionId: 'session-123' }),
    });

    const image = Array.isArray(metadata.openGraph?.images) ? metadata.openGraph.images[0] : metadata.openGraph?.images;

    expect(metadata.title).toBe('Join Alex on the wall | Boardsesh');
    expect(metadata.description).toBe('Kilter Original 12x12 at 40°. 5 sends so far on V5. Get on the wall.');
    expect(getOpenGraphImageUrl(image)).toBe('/api/og/session?sessionId=session-123&variant=join&v=abc123');
  });

  it('returns not-found metadata when the join summary is missing', async () => {
    getSessionOgSummaryMock.mockResolvedValue({
      sessionType: null,
      sessionName: 'Climbing Session',
      leaderName: null,
      participantNames: [],
      participantCount: 0,
      totalSends: 0,
      gradeRows: [],
      boardType: null,
      boardLabel: null,
      boardAngle: null,
      boardPreviewPath: null,
      version: '0',
      found: false,
    });

    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({ sessionId: 'missing-session' }),
    });

    expect(metadata.title).toBe('Session Not Found | Boardsesh');
  });
});
