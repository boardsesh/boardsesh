import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('server-only', () => ({}));

const getServerTranslation = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/i18n/server', () => ({ getServerTranslation, loadServerResources: vi.fn() }));

vi.mock('@/app/lib/graphql/server-cached-client', () => ({
  createCachedGraphQLQuery: () => vi.fn(),
}));

// The route modules pull in the page renderer, which reaches next-auth (and
// through it the db client) for the flag's distinct id. Metadata never needs a
// session, so stub the module rather than standing up a database for it.
vi.mock('@/app/lib/feature-flags/server-distinct-id', () => ({ getPosthogDistinctId: vi.fn() }));
vi.mock('@/app/lib/feature-flags/server-feature-flag', () => ({ getServerFeatureFlag: vi.fn() }));
vi.mock('@/app/lib/gym-funnel-analytics', () => ({
  trackGymFunnelEvent: vi.fn(),
  viewerStateFrom: (isAuthenticated: boolean) => (isAuthenticated ? 'signed-in' : 'signed-out'),
}));

const allRoute = await import('../page');
const kilterRoute = await import('../kilter/page');
const moonboardRoute = await import('../moonboard/page');
const tensionRoute = await import('../tension/page');

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
});

describe('canonical matrix', () => {
  it('makes every route self-canonical on its OWN clean base', async () => {
    for (const route of ROUTES) {
      const metadata = await route.generateMetadata();
      // A facet page canonicalises to itself, NOT to /gyms: it is a distinct
      // page with distinct copy, and folding it into /gyms would throw away the
      // "<board> board near me" surface this route exists to be.
      expect({ route: route.name, canonical: metadata.alternates?.canonical }).toEqual({
        route: route.name,
        canonical: route.base,
      });
    }
  });

  it('cannot let a query param reach the canonical, because it never sees one', async () => {
    // Structural, not defensive: `generateMetadata` takes no arguments at all,
    // so `?q`, `?page`, `?lat`/`?lng`/`?radius` and `?boardType` physically
    // cannot be concatenated into `path`. Every variant collapses to the base.
    for (const route of ROUTES) {
      expect({ route: route.name, arity: route.generateMetadata.length }).toEqual({ route: route.name, arity: 0 });
    }
  });

  it('carries the canonical into the locale prefix', async () => {
    mockLocale('de');
    const metadata = await kilterRoute.generateMetadata();
    expect(metadata.alternates?.canonical).toBe('/de/gyms/kilter');
  });

  it('emits hreflang alternates for every locale plus x-default', async () => {
    const metadata = await moonboardRoute.generateMetadata();
    expect(metadata.alternates?.languages).toEqual({
      'en-US': '/gyms/moonboard',
      es: '/es/gyms/moonboard',
      fr: '/fr/gyms/moonboard',
      de: '/de/gyms/moonboard',
      'x-default': '/gyms/moonboard',
    });
  });
});

describe('robots', () => {
  it('ships noindex, follow on every route while the directory is flag-gated', async () => {
    for (const route of ROUTES) {
      const metadata = await route.generateMetadata();
      // Launch (#4382) removes this and nothing else. Note the gate is BOTH:
      // the page also 404s while the flag is off, because noindex alone would
      // still leave a publicly reachable directory.
      expect({ route: route.name, robots: metadata.robots }).toEqual({
        route: route.name,
        robots: { index: false, follow: true },
      });
    }
  });
});

describe('titles and descriptions', () => {
  it('gives every route a unique, brand-suffixed title', async () => {
    const titles = await Promise.all(
      ROUTES.map(async (route) => {
        const { title } = await route.generateMetadata();
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
    const descriptions = await Promise.all(ROUTES.map(async (route) => (await route.generateMetadata()).description));
    expect(new Set(descriptions).size).toBe(ROUTES.length);
  });
});
