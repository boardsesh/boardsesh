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

vi.mock('graphql-request', () => ({
  gql: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((result, chunk, index) => result + chunk + (values[index] ?? ''), ''),
  GraphQLClient: vi.fn(() => ({
    request: vi.fn(),
  })),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  getGraphQLHttpUrl: vi.fn(() => 'http://localhost:4000/graphql'),
}));

vi.mock('@/app/lib/seo/dynamic-og-data', () => ({
  getSessionOgSummary: vi.fn(),
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

describe('session page metadata', () => {
  it('builds versioned OG metadata for explicit sessions', async () => {
    getSessionOgSummaryMock.mockResolvedValue({
      sessionType: 'party',
      sessionName: 'Board Session',
      leaderName: 'Alex',
      participantNames: ['Alex'],
      participantCount: 1,
      totalSends: 3,
      gradeRows: [{ difficulty: 10, count: 3 }],
      boardLabel: null,
      boardAngle: null,
      boardPreviewPath: null,
      version: 'abc123',
      found: true,
    });

    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({ sessionId: 'session-1' }),
    });

    const image = Array.isArray(metadata.openGraph?.images) ? metadata.openGraph.images[0] : metadata.openGraph?.images;

    expect(metadata.title).toBe('Board Session | Boardsesh');
    expect(metadata.description).toBe('Alex — 3 sends');
    expect(getOpenGraphImageUrl(image)).toBe('/api/og/session?sessionId=session-1&v=abc123');
  });

  it('returns not-found metadata when the summary is missing', async () => {
    getSessionOgSummaryMock.mockResolvedValue({
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

    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({ sessionId: 'missing-session' }),
    });

    expect(metadata.title).toBe('Session Not Found | Boardsesh');
  });
});
