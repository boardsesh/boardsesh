import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { Gym } from '@boardsesh/shared-schema';

vi.mock('server-only', () => ({}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(),
  permanentRedirect: vi.fn(),
}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}:${String(options.gymName)}` : key),
    locale: 'en-US',
  })),
}));

vi.mock('@/app/lib/auth/server-auth', () => ({
  getServerAuthToken: vi.fn(async () => undefined),
}));

const executeAuthenticatedGraphQL = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL }));

vi.mock('@/app/lib/backend-url', () => ({
  getPublicBackendHttpUrl: () => 'https://ws.boardsesh.com',
}));

const { generateMetadata } = await import('../page');

function gym(slug: string, overrides: Partial<Gym> = {}): Gym {
  return {
    uuid: `uuid-${slug}`,
    slug,
    name: 'Boulderwelt',
    isPublic: true,
    canEdit: false,
    description: 'A big gym',
    ...overrides,
  } as unknown as Gym;
}

// `fetchGymBySlug` is wrapped in React's `cache()`, so every test uses a slug of
// its own rather than relying on the mock being re-read for the same arguments.
const metadataFor = (slug: string, params: Record<string, string | string[] | undefined>) =>
  generateMetadata({
    params: Promise.resolve({ gym_slug: slug }),
    searchParams: Promise.resolve(params),
  });

beforeEach(() => {
  executeAuthenticatedGraphQL.mockReset();
});

describe('gym page metadata', () => {
  it('canonicalises to the bare /gym/{slug} path when the URL carries QR attribution params', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: gym('qr-landing') });

    // The route now receives searchParams. Nothing from it may reach `path`: a
    // query string in the canonical gives every param combination its own
    // canonical URL and splits the page's ranking signals.
    const metadata = await metadataFor('qr-landing', { src: 'qr', medium: 'poster' });

    expect(metadata.alternates?.canonical).toBe('/gym/qr-landing');
  });

  it('canonicalises to the same path when no params are present', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: gym('no-params') });

    const metadata = await metadataFor('no-params', {});

    expect(metadata.alternates?.canonical).toBe('/gym/no-params');
  });

  it('keeps every hreflang alternate free of the query string', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: gym('alternates') });

    const metadata = await metadataFor('alternates', { src: 'qr', medium: 'poster', tab: 'boards' });

    const languages = metadata.alternates?.languages ?? {};
    const hrefs = Object.values(languages).flatMap((href) => (typeof href === 'string' ? [href] : []));
    expect(hrefs.length).toBeGreaterThan(1);
    for (const href of hrefs) {
      expect(href).not.toContain('?');
      expect(href).toContain('/gym/alternates');
    }
  });

  it('keeps a private gym out of the index', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({
      gymBySlug: gym('private-gym', { isPublic: false, canEdit: true }),
    });

    const metadata = await metadataFor('private-gym', {});

    expect(metadata.robots).toEqual({ index: false, follow: true });
  });
});

const PHOTO_PATH = '/static/gym-photos/11111111-2222-4333-8444-555555555555.jpg?v=abc';

type OgImage = { url: string; width?: number; height?: number };

function ogImages(metadata: Awaited<ReturnType<typeof generateMetadata>>): OgImage[] {
  return (metadata.openGraph?.images ?? []) as OgImage[];
}

describe('gym page share card', () => {
  it('uses the owner-uploaded photo, resolved absolute and with no claimed dimensions', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: gym('with-photo', { imageUrl: PHOTO_PATH }) });

    const metadata = await metadataFor('with-photo', {});

    const [image] = ogImages(metadata);
    expect(image.url).toBe(`https://ws.boardsesh.com${PHOTO_PATH}`);
    // A user photo's aspect ratio is unknown; claiming 1200×630 makes scrapers crop.
    expect(image.width).toBeUndefined();
    expect(image.height).toBeUndefined();
    expect(metadata.twitter?.images).toEqual([`https://ws.boardsesh.com${PHOTO_PATH}`]);
  });

  it('falls back to the generic card when the gym has no photo', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: gym('no-photo') });

    const metadata = await metadataFor('no-photo', {});

    const [image] = ogImages(metadata);
    expect(image.url).toBe('/opengraph-image');
    expect(image.width).toBe(1200);
  });

  it('refuses a legacy javascript: row and falls back to the generic card', async () => {
    // gyms.image_url was validated with a bare z.string().url() until this
    // feature landed, and that accepted javascript:/data: URLs.
    executeAuthenticatedGraphQL.mockResolvedValue({
      gymBySlug: gym('hostile-photo', { imageUrl: 'javascript:alert(1)' }),
    });

    const metadata = await metadataFor('hostile-photo', {});

    const [image] = ogImages(metadata);
    expect(image.url).toBe('/opengraph-image');
  });
});
