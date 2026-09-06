import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('server-only', () => ({}));

const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
);
const redirect = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
);
vi.mock('next/navigation', () => ({ notFound, redirect }));

const getServerTranslation = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/i18n/server', () => ({ getServerTranslation, loadServerResources: vi.fn() }));

const getPosthogDistinctId = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/feature-flags/server-distinct-id', () => ({ getPosthogDistinctId }));

const getServerFeatureFlag = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/feature-flags/server-feature-flag', () => ({ getServerFeatureFlag }));

// The catalogue fetch would otherwise open a GraphQL client against a backend
// that is not running. Every test here is about the gate and the metadata.
const cachedCatalogQuery = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/server-cached-client', () => ({ createCachedGraphQLQuery: () => cachedCatalogQuery }));

const executeAuthenticatedGraphQL = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL }));

const getServerAuthToken = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken }));

const buildPlansRoute = await import('../page');
const ordersRoute = await import('../orders/page');
const orderRoute = await import('../orders/[licenceId]/page');

const ROUTES = [
  { name: '/build-plans', generateMetadata: buildPlansRoute.generateMetadata, base: '/build-plans' },
  { name: '/build-plans/orders', generateMetadata: ordersRoute.generateMetadata, base: '/build-plans/orders' },
];

function mockLocale(locale: string) {
  getServerTranslation.mockResolvedValue({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog('cnc', key, options),
    i18n: {},
    locale,
  });
}

beforeEach(() => {
  notFound.mockClear();
  redirect.mockClear();
  getServerTranslation.mockReset();
  mockLocale('en-US');
  getPosthogDistinctId.mockReset().mockResolvedValue('user-uuid-1');
  getServerFeatureFlag.mockReset().mockResolvedValue(true);
  cachedCatalogQuery.mockReset().mockResolvedValue({ cncCatalog: { version: 'test', entries: [] } });
  executeAuthenticatedGraphQL.mockReset().mockResolvedValue({ myCncOrders: [] });
  getServerAuthToken.mockReset().mockResolvedValue('session-cookie');
});

describe('robots', () => {
  it('ships noindex, follow on every build-plans route while the flag is on', async () => {
    for (const route of ROUTES) {
      const metadata = await route.generateMetadata();
      // Launch removes this from `/build-plans` and nothing else — the orders
      // pages are a purchase history and stay out of the index forever. Note
      // the gate is BOTH: the pages also 404 while the flag is off, because
      // noindex alone would leave a publicly reachable shop.
      expect({ route: route.name, robots: metadata.robots }).toEqual({
        route: route.name,
        robots: { index: false, follow: true },
      });
    }
  });

  it('keeps a single order page out of the index too, licence id and all', async () => {
    const metadata = await orderRoute.generateMetadata({
      params: Promise.resolve({ licenceId: 'BS-CNC-K7QM3T' }),
      searchParams: Promise.resolve({}),
    });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe('/build-plans/orders/BS-CNC-K7QM3T');
  });
});

describe('canonicals and titles', () => {
  it('self-canonicalises each route on its own clean base', async () => {
    for (const route of ROUTES) {
      const metadata = await route.generateMetadata();
      expect({ route: route.name, canonical: metadata.alternates?.canonical }).toEqual({
        route: route.name,
        canonical: route.base,
      });
    }
  });

  it('carries the canonical into the locale prefix', async () => {
    mockLocale('de');
    const metadata = await buildPlansRoute.generateMetadata();
    expect(metadata.alternates?.canonical).toBe('/de/build-plans');
  });

  it('gives each route a unique, brand-suffixed title', async () => {
    const titles = await Promise.all(
      ROUTES.map(async (route) => {
        const { title } = await route.generateMetadata();
        expect(title).toHaveProperty('absolute');
        return title && typeof title === 'object' && 'absolute' in title ? title.absolute : '';
      }),
    );

    expect(new Set(titles).size).toBe(ROUTES.length);
    for (const title of titles) {
      expect(title).toMatch(/ \| Boardsesh$/);
    }
  });
});

describe('the flag gate', () => {
  it('404s /build-plans when the flag is off', async () => {
    getServerFeatureFlag.mockResolvedValue(false);

    await expect(buildPlansRoute.default()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it('404s the orders pages too — the gate is not just the shop front', async () => {
    getServerFeatureFlag.mockResolvedValue(false);

    await expect(ordersRoute.default()).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(
      orderRoute.default({
        params: Promise.resolve({ licenceId: 'BS-CNC-K7QM3T' }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('evaluates the flag for signed-out visitors, not only for a session', async () => {
    // Without `allowAnonymous` a null distinct id short-circuits to false and
    // the shop would stay signed-in-only however the rollout is configured —
    // which is fatal for a page whose whole funnel starts with a stranger.
    getPosthogDistinctId.mockResolvedValue(null);

    await buildPlansRoute.default();

    expect(getServerFeatureFlag).toHaveBeenCalledWith('cnc-packs', { distinctId: null, allowAnonymous: true });
    expect(notFound).not.toHaveBeenCalled();
  });

  it('resolves the flag against the signed-in person when there is one', async () => {
    await buildPlansRoute.default();

    expect(getServerFeatureFlag).toHaveBeenCalledWith('cnc-packs', {
      distinctId: 'user-uuid-1',
      allowAnonymous: true,
    });
  });

  it('renders the page when the flag is on', async () => {
    await expect(buildPlansRoute.default()).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });
});

describe('the orders pages need a session', () => {
  it('sends a signed-out visitor to login with a callback back to the list', async () => {
    getServerAuthToken.mockResolvedValue(undefined);

    await expect(ordersRoute.default()).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/auth/login?callbackUrl=%2Fbuild-plans%2Forders');
  });

  it('sends them back to the order they were opening, not to the list', async () => {
    getServerAuthToken.mockResolvedValue(undefined);

    await expect(
      orderRoute.default({
        params: Promise.resolve({ licenceId: 'BS-CNC-K7QM3T' }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/auth/login?callbackUrl=%2Fbuild-plans%2Forders%2FBS-CNC-K7QM3T');
  });
});
