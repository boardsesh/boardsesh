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

vi.mock('@/app/lib/seo/dynamic-og-data', () => ({
  getSessionOgSummary: vi.fn(),
}));

vi.mock('@/app/lib/backend-url', () => ({
  getPublicBackendHttpUrl: () => 'https://ws.boardsesh.com',
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

const JOIN_CARD_URL =
  /^https:\/\/ws\.boardsesh\.com\/og\/session\?sessionId=session-123&variant=join&v=[0-9a-f]{12}-[0-9a-z]+$/;

async function joinMetadata(sessionId = 'session-123') {
  const metadata = await pageModule.generateMetadata({ params: Promise.resolve({ sessionId }) });
  const image = Array.isArray(metadata.openGraph?.images) ? metadata.openGraph.images[0] : metadata.openGraph?.images;
  return { metadata, imageUrl: getOpenGraphImageUrl(image) };
}

describe('join page metadata', () => {
  it('invites by name, board and angle, and points at the backend invite card', async () => {
    getSessionOgSummaryMock.mockResolvedValue(
      makeSessionOgSummary({
        isLive: true,
        inviteName: 'Huy Dang',
        liveBoard: { boardType: 'moonboard', angle: 40 },
        totalSends: 9,
        tickCount: 9,
        hardestSend: { grade: '6c/V5', angle: 40, flashed: false },
      }),
    );

    const { metadata, imageUrl } = await joinMetadata();

    expect(metadata.title).toBe('Join Huy Dang on the MoonBoard at 40° | Boardsesh');
    expect(metadata.openGraph?.title).toBe('Join Huy Dang on the MoonBoard at 40°');
    expect(metadata.openGraph?.description).toBe('9 sends so far, hardest 6c/V5. Tap to jump in.');
    expect(metadata.twitter?.title).toBe('Join Huy Dang on the MoonBoard at 40°');
    expect(imageUrl).toMatch(JOIN_CARD_URL);
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it('never claims what is happening now, and covers a crew nobody may name', async () => {
    getSessionOgSummaryMock.mockResolvedValue(makeSessionOgSummary({ isLive: true }));

    const { metadata, imageUrl } = await joinMetadata();

    expect(metadata.openGraph?.title).toBe('Join the crew on the wall');
    expect(metadata.openGraph?.description).toBe("No sends yet, first one's yours.");
    expect(JSON.stringify(metadata)).not.toMatch(/now/i);
    expect(imageUrl).toMatch(JOIN_CARD_URL);
  });

  it('recaps an ended session instead of saying Join', async () => {
    getSessionOgSummaryMock.mockResolvedValue(
      makeSessionOgSummary({
        isLive: false,
        totalSends: 2,
        tickCount: 2,
        recapParticipants: [{ name: 'Alex' }],
        boardTypes: ['kilter'],
        hardestSend: { grade: '6a/V3', angle: 30, flashed: false },
      }),
    );

    const { metadata, imageUrl } = await joinMetadata();

    expect(metadata.openGraph?.title).toBe('Alex sent 2, hardest 6a/V3');
    expect(JSON.stringify(metadata)).not.toContain('Join');
    // The backend serves the recap on the same invite URL.
    expect(imageUrl).toMatch(JOIN_CARD_URL);
  });

  it('advertises no card for an ended session with nothing a stranger may see', async () => {
    getSessionOgSummaryMock.mockResolvedValue(makeSessionOgSummary({ isLive: false, tickCount: 0 }));

    const { metadata, imageUrl } = await joinMetadata();

    expect(imageUrl).toBeUndefined();
    expect(metadata.twitter?.images).toBeUndefined();
  });

  it('keeps a daily feed group on the web route', async () => {
    getSessionOgSummaryMock.mockResolvedValue(makeSessionOgSummary({ tickCount: 1, totalSends: 1 }));

    const { imageUrl } = await joinMetadata('daily:user-1:2026-11-01');

    expect(imageUrl).toBe('/api/og/session?sessionId=daily%3Auser-1%3A2026-11-01&variant=join&v=abc123');
  });

  it('returns not-found metadata when the join summary is missing', async () => {
    getSessionOgSummaryMock.mockResolvedValue(NOT_FOUND_SESSION_OG_SUMMARY);

    const { metadata } = await joinMetadata('missing-session');

    expect(metadata.title).toBe('Session Not Found | Boardsesh');
  });
});
