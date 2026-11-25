import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('server-only', () => ({}));

const getServerTranslation = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/i18n/server', () => ({ getServerTranslation, loadServerResources: vi.fn() }));

vi.mock('@/app/lib/graphql/server-cached-client', () => ({
  createCachedGraphQLQuery: () => vi.fn(),
}));

// The route modules pull in the page renderer, which reaches next-auth (and
// through it the db client) for the claim call-out's viewer state. Metadata
// never needs a session, so stub the module rather than standing up a database.
vi.mock('@/app/lib/feature-flags/server-distinct-id', () => ({ getPosthogDistinctId: vi.fn() }));
vi.mock('@/app/lib/gym-funnel-analytics', () => ({
  trackGymFunnelEvent: vi.fn(),
  viewerStateFrom: (isAuthenticated: boolean) => (isAuthenticated ? 'signed-in' : 'signed-out'),
}));

const allRoute = await import('@/app/(site)/gyms/page');
const kilterRoute = await import('@/app/(site)/gyms/kilter/page');
const moonboardRoute = await import('@/app/(site)/gyms/moonboard/page');
const tensionRoute = await import('@/app/(site)/gyms/tension/page');

const ROUTES = [
  { name: '/gyms', generateMetadata: allRoute.generateMetadata, base: '/gyms' },
  { name: '/gyms/kilter', generateMetadata: kilterRoute.generateMetadata, base: '/gyms/kilter' },
  { name: '/gyms/moonboard', generateMetadata: moonboardRoute.generateMetadata, base: '/gyms/moonboard' },
  { name: '/gyms/tension', generateMetadata: tensionRoute.generateMetadata, base: '/gyms/tension' },
];

function mockLocale(locale: string) {
  getServerTranslation.mockResolvedValue({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog('gyms', key, options),
    i18n: {},
    locale,
  });
}

beforeEach(() => {
  getServerTranslation.mockReset();
  mockLocale('en-US');
  vi.stubEnv('GYM_DIRECTORY_INDEXING_ENABLED', 'true');
});

afterEach(() => vi.unstubAllEnvs());

describe('canonical matrix', () => {
  it('makes every route self-canonical on its OWN clean base', async () => {
    for (const route of ROUTES) {
      const metadata = await route.generateMetadata({ searchParams: Promise.resolve({}) });
      // A facet page canonicalises to itself, NOT to /gyms: it is a distinct
      // page with distinct copy, and folding it into /gyms would throw away the
      // "<board> board near me" surface this route exists to be.
      expect({ route: route.name, canonical: metadata.alternates?.canonical }).toEqual({
        route: route.name,
        canonical: route.base,
      });
    }
  });

  it('keeps filtered variants noindex and canonical to the clean base', async () => {
    for (const route of ROUTES) {
      for (const searchParams of [
        { q: 'bristol' },
        { page: '2' },
        { lat: '51', lng: '0' },
        { boardType: 'kilter' },
        { claim: '1' },
        { unknown: 'x' },
      ]) {
        const metadata = await route.generateMetadata({ searchParams: Promise.resolve(searchParams) });
        expect(metadata.alternates?.canonical).toBe(route.base);
        expect(metadata.robots).toEqual({ index: false, follow: true });
      }
    }
  });

  it('carries the canonical into the locale prefix', async () => {
    mockLocale('de');
    const metadata = await kilterRoute.generateMetadata({ searchParams: Promise.resolve({}) });
    expect(metadata.alternates?.canonical).toBe('/de/gyms/kilter');
  });

  it('emits hreflang alternates for every locale plus x-default', async () => {
    const metadata = await moonboardRoute.generateMetadata({ searchParams: Promise.resolve({}) });
    expect(metadata.alternates?.languages).toEqual({
      'en-US': '/gyms/moonboard',
      es: '/es/gyms/moonboard',
      fr: '/fr/gyms/moonboard',
      de: '/de/gyms/moonboard',
      it: '/it/gyms/moonboard',
      'zh-CN': '/zh-CN/gyms/moonboard',
      'x-default': '/gyms/moonboard',
    });
  });
});

describe('robots', () => {
  it('indexes clean directory routes when the rollout is enabled', async () => {
    for (const route of ROUTES) {
      const metadata = await route.generateMetadata({ searchParams: Promise.resolve({}) });
      expect(metadata.robots).toBeUndefined();
    }
  });

  it.each([undefined, '', 'false', 'TRUE'])('keeps the duplicate-cleanup hold for %s', async (flag) => {
    vi.stubEnv('GYM_DIRECTORY_INDEXING_ENABLED', flag);
    for (const route of ROUTES) {
      const metadata = await route.generateMetadata({ searchParams: Promise.resolve({}) });
      expect(metadata.robots).toEqual({ index: false, follow: true });
    }
  });
});

describe('titles and descriptions', () => {
  it('gives every route a unique, brand-suffixed title', async () => {
    const titles = await Promise.all(
      ROUTES.map(async (route) => {
        const { title } = await route.generateMetadata({ searchParams: Promise.resolve({}) });
        // `createPageMetadata` always emits the `absolute` form so the root
        // layout's `%s | Boardsesh` template can't double-suffix it.
        expect(title).toHaveProperty('absolute');
        return title && typeof title === 'object' && 'absolute' in title ? title.absolute : '';
      }),
    );

    expect(new Set(titles).size).toBe(ROUTES.length);
    for (const title of titles) {
      expect(title).toMatch(/ \| Boardsesh$/);
    }
  });

  it('gives every route a unique description', async () => {
    const descriptions = await Promise.all(
      ROUTES.map(async (route) => (await route.generateMetadata({ searchParams: Promise.resolve({}) })).description),
    );
    expect(new Set(descriptions).size).toBe(ROUTES.length);
  });
});
