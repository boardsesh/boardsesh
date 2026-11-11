import { describe, expect, it, vi } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { NOT_FOUND_SESSION_OG_SUMMARY, makeSessionOgSummary } from '@/app/__test-helpers__/session-og-summary';

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
  GraphQLClient: vi.fn(function () {
    return { request: vi.fn() };
  }),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  getGraphQLHttpUrl: vi.fn(() => 'http://localhost:4000/graphql'),
}));

vi.mock('../session-detail-content', () => ({ default: () => null }));

vi.mock('@/app/lib/backend-url', () => ({
  getPublicBackendHttpUrl: () => 'https://ws.boardsesh.com',
}));

vi.mock('@/app/lib/seo/dynamic-og-data', () => ({
  getSessionOgSummary: vi.fn(),
}));

const { GraphQLClient } = await import('graphql-request');
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
  it('advertises the backend recap card and says how the session went', async () => {
    getSessionOgSummaryMock.mockResolvedValue(
      makeSessionOgSummary({
        participantNames: ['Zara'],
        participantCount: 1,
        totalSends: 17,
        totalFlashes: 17,
        tickCount: 17,
        durationMinutes: 49,
        recapParticipants: [{ name: 'Zara' }],
        boardTypes: ['kilter'],
        hardestSend: { grade: '6a/V3', angle: 40, flashed: true },
      }),
    );

    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({ sessionId: 'session-1' }),
    });

    const image = Array.isArray(metadata.openGraph?.images) ? metadata.openGraph.images[0] : metadata.openGraph?.images;

    // The search title and snippet stay as they were; only the preview changes.
    expect(metadata.title).toEqual({ absolute: 'Board Session | Boardsesh' });
    expect(metadata.description).toBe('Zara — 17 sends');
    expect(metadata.openGraph?.title).toBe('Zara flashed 17 climbs, hardest 6a/V3');
    expect(metadata.openGraph?.description).toBe('17 sends in 49 minutes on Kilter.');
    expect(metadata.twitter?.title).toBe('Zara flashed 17 climbs, hardest 6a/V3');
    const imageUrl = getOpenGraphImageUrl(image);
    expect(imageUrl).toMatch(
      /^https:\/\/ws\.boardsesh\.com\/og\/session\?sessionId=session-1&v=[0-9a-f]{12}-[0-9a-z]+$/,
    );
    expect(metadata.twitter?.images).toEqual([imageUrl]);
  });

  it.each([
    [
      'mixed sends',
      { totalSends: 3, totalFlashes: 1, tickCount: 5, recapParticipants: [{ name: 'jed kinross' }] },
      { grade: '7a+/V7', angle: 45, flashed: false },
      'jed kinross sent 3, hardest 7a+/V7',
      '3 sends on Kilter.',
    ],
    [
      'one flash',
      { totalSends: 1, totalFlashes: 1, tickCount: 1, recapParticipants: [{ name: 'Line' }] },
      { grade: '4a/V0', angle: 20, flashed: true },
      'Line flashed 4a/V0 on Kilter',
      '1 send on Kilter.',
    ],
    [
      'an unnamed climber',
      { totalSends: 2, totalFlashes: 0, tickCount: 2, recapParticipants: [{ name: null }] },
      { grade: '6b/V4', angle: 40, flashed: false },
      'A climber sent 2, hardest 6b/V4',
      '2 sends on Kilter.',
    ],
    [
      'a crew',
      {
        totalSends: 4,
        totalFlashes: 1,
        tickCount: 4,
        recapParticipants: [{ name: null }, { name: 'Ana' }, { name: 'Ben' }],
      },
      { grade: '6c/V5', angle: 40, flashed: false },
      'Ana + 2 others sent 4, hardest 6c/V5',
      '4 sends on Kilter.',
    ],
  ])('words a recap with %s', async (_label, counts, hardestSend, ogTitle, ogDescription) => {
    getSessionOgSummaryMock.mockResolvedValue(makeSessionOgSummary({ ...counts, boardTypes: ['kilter'], hardestSend }));

    const metadata = await pageModule.generateMetadata({ params: Promise.resolve({ sessionId: 'session-1' }) });

    expect(metadata.openGraph?.title).toBe(ogTitle);
    expect(metadata.openGraph?.description).toBe(ogDescription);
  });

  it('keeps a zero-send session honest: it was projecting, never a send', async () => {
    getSessionOgSummaryMock.mockResolvedValue(
      makeSessionOgSummary({
        tickCount: 6,
        recapParticipants: [{ name: 'Dylan Lenze' }],
        boardTypes: ['tension'],
        hardestAttempt: { grade: '7a+/V7', angle: 40, flashed: false },
      }),
    );

    const metadata = await pageModule.generateMetadata({ params: Promise.resolve({ sessionId: 'session-1' }) });

    expect(metadata.openGraph?.title).toBe('Dylan Lenze was projecting 7a+/V7');
    expect(metadata.openGraph?.description).toBe('6 tries logged on Tension, no sends yet.');
  });

  it('moves the card to a new URL when a tick leaves the recap, even with the same newest tick', async () => {
    const recap = { totalSends: 3, tickCount: 3, recapParticipants: [{ name: 'Alex' }], boardTypes: ['kilter'] };
    getSessionOgSummaryMock.mockResolvedValue(makeSessionOgSummary(recap));
    const before = await pageModule.generateMetadata({ params: Promise.resolve({ sessionId: 'session-1' }) });
    getSessionOgSummaryMock.mockResolvedValue(makeSessionOgSummary({ ...recap, totalSends: 2, tickCount: 2 }));
    const after = await pageModule.generateMetadata({ params: Promise.resolve({ sessionId: 'session-1' }) });

    expect(after.twitter?.images).not.toEqual(before.twitter?.images);
  });

  it('advertises no card when a stranger can see no tick, since the backend card would 404', async () => {
    getSessionOgSummaryMock.mockResolvedValue(makeSessionOgSummary({ tickCount: 0 }));

    const metadata = await pageModule.generateMetadata({ params: Promise.resolve({ sessionId: 'session-1' }) });

    expect(metadata.openGraph?.images).toBeUndefined();
    expect(metadata.twitter?.images).toBeUndefined();
  });

  it('keeps a daily feed group on the web route, which the backend card refuses', async () => {
    getSessionOgSummaryMock.mockResolvedValue(
      makeSessionOgSummary({ tickCount: 3, totalSends: 3, recapParticipants: [{ name: 'Alex' }] }),
    );

    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({ sessionId: 'daily:user-1:2026-11-01' }),
    });
    const image = Array.isArray(metadata.openGraph?.images) ? metadata.openGraph.images[0] : metadata.openGraph?.images;

    expect(getOpenGraphImageUrl(image)).toBe('/api/og/session?sessionId=daily%3Auser-1%3A2026-11-01&v=abc123');
  });

  it('returns not-found metadata when the summary is missing', async () => {
    getSessionOgSummaryMock.mockResolvedValue(NOT_FOUND_SESSION_OG_SUMMARY);

    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({ sessionId: 'missing-session' }),
    });

    expect(metadata.title).toEqual({ absolute: 'Session Not Found | Boardsesh' });
  });

  it('never leaks the private session recap notes into title/description/OG', async () => {
    const secretRecap = 'PRIVATE_RECAP_wrecked_my_fingers_on_the_crimps';
    getSessionOgSummaryMock.mockResolvedValue({
      ...makeSessionOgSummary({
        participantNames: ['Alex'],
        totalSends: 3,
        tickCount: 3,
        recapParticipants: [{ name: 'Alex' }],
      }),
      // Notes are not part of the OG summary contract; this extra field guards
      // against a future leak of the free-text recap into crawlable metadata.
      notes: secretRecap,
    } as Awaited<ReturnType<typeof getSessionOgSummary>>);

    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({ sessionId: 'session-1' }),
    });

    const image = Array.isArray(metadata.openGraph?.images) ? metadata.openGraph.images[0] : metadata.openGraph?.images;

    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain(secretRecap);
    expect((metadata.title as { absolute: string }).absolute).not.toContain(secretRecap);
    expect(metadata.description).not.toContain(secretRecap);
    expect(getOpenGraphImageUrl(image) ?? '').not.toContain(secretRecap);
  });

  it('bounds the session detail fetch with a deadline', async () => {
    await pageModule.default({ params: Promise.resolve({ sessionId: 'session-deadline' }) });

    expect(vi.mocked(GraphQLClient)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('rethrows a deadline on the detail fetch instead of rendering not-found', async () => {
    vi.mocked(GraphQLClient).mockImplementationOnce(function () {
      return { request: vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError')) };
    } as never);

    await expect(pageModule.default({ params: Promise.resolve({ sessionId: 'session-slow' }) })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  it('falls back to not-found metadata when the summary read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getSessionOgSummaryMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));

    const metadata = await pageModule.generateMetadata({ params: Promise.resolve({ sessionId: 'session-meta-slow' }) });

    expect(metadata.robots).toMatchObject({ index: false });
  });
});
