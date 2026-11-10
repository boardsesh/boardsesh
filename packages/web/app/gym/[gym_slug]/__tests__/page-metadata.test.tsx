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

const viewer = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock('@/app/lib/auth/server-auth', () => ({
  getServerAuthToken: vi.fn(async () => viewer.token),
}));

const executeAuthenticatedGraphQL = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL }));

vi.mock('@/app/lib/backend-url', () => ({
  getPublicBackendHttpUrl: () => 'https://ws.boardsesh.com',
}));

const { generateMetadata } = await import('../page');

// The base fixture is a GEOCODED commercial gym, because that is the only kind
// of gym this page still offers to the index. A pin-less row is a climber's home
// wall (see `gymIsIndexableVenue`) and goes `noindex, follow` with no canonical
// and no hreflang cluster — so every canonical/alternate assertion below would
// pass vacuously without these coordinates.
function gym(slug: string, overrides: Partial<Gym> = {}): Gym {
  return {
    uuid: `uuid-${slug}`,
    slug,
    name: 'Boulderwelt',
    isPublic: true,
    canEdit: false,
    description: 'A big gym',
    latitude: 48.1351,
    longitude: 11.582,
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
  viewer.token = undefined;
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
    // A private gym USED to keep its canonical and its hreflang cluster: it was
    // noindexed with a `path`. It no longer is, and that change is deliberate —
    // an owner's unpublished listing should advertise no locale twins either.
    expect(metadata.alternates).toBeUndefined();
  });

  it('indexes a public gym that carries a pin', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: gym('geocoded-gym') });

    const metadata = await metadataFor('geocoded-gym', {});

    expect(metadata.robots).toBeUndefined();
    expect(metadata.alternates?.canonical).toBe('/gym/geocoded-gym');
  });

  it('keeps an unlisted gym link readable without indexing it', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({
      gymBySlug: gym('qa-gym', { isPublic: true, isListed: false }),
    });
    const metadata = await metadataFor('qa-gym', {});
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates).toBeUndefined();
  });

  // A public gym with no coordinates is a climber's personal home wall: the
  // Aurora sync geocodes every commercial gym it writes, and 1,053 of these
  // names begin with the owner's own display name.
  it('keeps a pin-less home wall out of the index', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({
      gymBySlug: gym('home-wall', { latitude: null, longitude: null }),
    });

    const metadata = await metadataFor('home-wall', {});

    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it('publishes no canonical and no hreflang cluster for a home wall', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({
      gymBySlug: gym('home-wall-alternates', { latitude: null, longitude: null }),
    });

    const metadata = await metadataFor('home-wall-alternates', {});

    // Both halves matter. A canonical re-nominates the page as the one to index,
    // and a four-locale hreflang block republishes the three locale twins we are
    // removing — on a page that just said `noindex`.
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.openGraph?.url).toBeUndefined();
  });

  it('treats half a pin as no pin', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({
      gymBySlug: gym('half-pin', { latitude: 48.1351, longitude: null }),
    });

    const metadata = await metadataFor('half-pin', {});

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates).toBeUndefined();
  });
});

type OgImage = { url: string; width?: number; height?: number };

function ogImages(metadata: Awaited<ReturnType<typeof generateMetadata>>): OgImage[] {
  return (metadata.openGraph?.images ?? []) as OgImage[];
}

/** Answers the gym read and, for the boards a stranger sees, `boards`. */
function serveGym(gymRow: Gym, boards: Array<{ boardType: string; angle: number }> = []) {
  executeAuthenticatedGraphQL.mockImplementation(async (document: unknown) =>
    String(document).includes('gymBoards') ? { gymBoards: boards } : { gymBySlug: gymRow },
  );
}

const CARD_URL = (slug: string) =>
  new RegExp(`^https://ws\\.boardsesh\\.com/og/place\\?kind=gym&slug=${slug}&v=[0-9a-f]{12}-[0-9a-z]+$`);

describe('gym page share card', () => {
  it('points a public gym at the backend place card, which draws its photo itself', async () => {
    serveGym(gym('with-photo', { imageUrl: '/static/gym-photos/a.jpg' }), [{ boardType: 'kilter', angle: 40 }]);

    const metadata = await metadataFor('with-photo', {});

    const [image] = ogImages(metadata);
    expect(image.url).toMatch(CARD_URL('with-photo'));
    expect(image.width).toBe(1200);
    expect(metadata.twitter?.images).toEqual([image.url]);
  });

  it('uses the canonical slug when a merged twin was requested', async () => {
    serveGym(gym('survivor'));

    const metadata = await metadataFor('old-twin', {});

    expect(ogImages(metadata)[0].url).toMatch(CARD_URL('survivor'));
  });

  it('keeps the generic card for a private gym, which the backend card refuses', async () => {
    serveGym(gym('private-card', { isPublic: false, canEdit: true, imageUrl: '/static/gym-photos/a.jpg' }));

    const metadata = await metadataFor('private-card', {});

    expect(ogImages(metadata)[0].url).toBe('/opengraph-image');
    expect(metadata.openGraph?.title).toBe('gymPage.metaTitle:Boulderwelt | Boardsesh');
  });

  it("titles the preview with the gym's own name and the boards a stranger sees", async () => {
    serveGym(gym('copy-boards', { description: null }), [
      { boardType: 'kilter', angle: 40 },
      { boardType: 'tension', angle: 40 },
    ]);

    const metadata = await metadataFor('copy-boards', {});

    // The mocked `t` prints the key and the gym name.
    expect(metadata.openGraph?.title).toBe('gymPage.ogTitle:Boulderwelt');
    expect(metadata.openGraph?.description).toBe('gymPage.ogDescriptionManyTypes:Boulderwelt');
  });

  it("prefers the gym's own description, and a gym with no boards keeps just its name", async () => {
    serveGym(gym('copy-none'));

    const metadata = await metadataFor('copy-none', {});

    expect(metadata.openGraph?.title).toBe('Boulderwelt');
    expect(metadata.openGraph?.description).toBe('A big gym');
  });

  it("reads the boards a stranger sees, never a signed-in member's view", async () => {
    // A member can see the gym's Only-me boards; the card and its words cannot.
    viewer.token = 'member-token';
    serveGym(gym('member-view'), [{ boardType: 'kilter', angle: 40 }]);

    await metadataFor('member-view', {});

    const boardReads = executeAuthenticatedGraphQL.mock.calls.filter(([document]) =>
      String(document).includes('gymBoards'),
    );
    expect(boardReads.length).toBeGreaterThan(0);
    for (const [, , token] of boardReads) expect(token).toBeUndefined();
    const gymRead = executeAuthenticatedGraphQL.mock.calls.find(
      ([document]) => !String(document).includes('gymBoards'),
    );
    expect(gymRead?.[2]).toBe('member-token');
  });

  it('changes the token when the boards a stranger sees change', async () => {
    serveGym(gym('token-a'), [{ boardType: 'kilter', angle: 40 }]);
    const first = ogImages(await metadataFor('token-a', {}))[0].url;
    serveGym(gym('token-b', { slug: 'token-a' }), [
      { boardType: 'kilter', angle: 40 },
      { boardType: 'tension', angle: 40 },
    ]);
    const second = ogImages(await metadataFor('token-b', {}))[0].url;

    expect(second).not.toBe(first);
  });
});
