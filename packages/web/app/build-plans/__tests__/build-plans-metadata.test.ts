import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CncOrder } from '@boardsesh/shared-schema';
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

/**
 * The props the route hands `OrderStatus`, read off the returned element tree.
 *
 * The page is a server component that returns plain elements, so walking them
 * beats mounting the whole MUI + i18n stack to learn what one prop resolved to.
 */
function orderStatusProps(tree: ReactElement): { checkoutOutcome: 'success' | 'cancelled' | null } {
  const page = (tree.props as { children: ReactElement }).children;
  const orderStatus = (page.props as { children: ReactElement }).children;
  return orderStatus.props as { checkoutOutcome: 'success' | 'cancelled' | null };
}

function cncOrder(overrides: Partial<CncOrder> = {}): CncOrder {
  return {
    id: '41',
    licenceId: 'BS-CNC-K7QM3T',
    tier: 'personal',
    status: 'queued',
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27,28,29',
    options: {},
    artwork: [],
    licenseeName: 'Sam Bouldering',
    customerSiteName: null,
    amountCents: 14900,
    currency: 'AUD',
    createdAt: '2026-09-01T02:14:11.402Z',
    paidAt: null,
    generatedAt: null,
    zipSizeBytes: null,
    downloadCount: 0,
    lastDownloadedAt: null,
    errorMessage: null,
    ...overrides,
  };
}

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

describe('metadata while the flag is off', () => {
  const ORDER_ROUTE_PROPS = {
    params: Promise.resolve({ licenceId: 'BS-CNC-K7QM3T' }),
    searchParams: Promise.resolve({}),
  };

  it('says nothing but noindex on any of the three routes', async () => {
    getServerFeatureFlag.mockResolvedValue(false);

    const all = [
      { route: '/build-plans', metadata: await buildPlansRoute.generateMetadata() },
      { route: '/build-plans/orders', metadata: await ordersRoute.generateMetadata() },
      { route: '/build-plans/orders/[licenceId]', metadata: await orderRoute.generateMetadata(ORDER_ROUTE_PROPS) },
    ];

    for (const { route, metadata } of all) {
      // Bare on purpose: `generateMetadata` runs before the page body can
      // `notFound()`, so a title, description or canonical here would describe
      // the shape of a surface that answers 404 to everyone.
      expect({ route, metadata }).toEqual({ route, metadata: { robots: { index: false, follow: true } } });
    }
  });

  it('leaks neither the licence id nor a route-shaped canonical', async () => {
    getServerFeatureFlag.mockResolvedValue(false);

    const metadata = await orderRoute.generateMetadata(ORDER_ROUTE_PROPS);

    expect(metadata.title).toBeUndefined();
    expect(metadata.description).toBeUndefined();
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.openGraph).toBeUndefined();
    expect(JSON.stringify(metadata)).not.toContain('BS-CNC-K7QM3T');
  });

  it('resolves the flag through the same gate the page body uses', async () => {
    getServerFeatureFlag.mockResolvedValue(false);

    await buildPlansRoute.generateMetadata();

    expect(getServerFeatureFlag).toHaveBeenCalledWith('cnc-packs', {
      distinctId: 'user-uuid-1',
      allowAnonymous: true,
    });
  });

  it('goes back to the full metadata the moment the flag is on', async () => {
    const metadata = await buildPlansRoute.generateMetadata();

    expect(metadata.alternates?.canonical).toBe('/build-plans');
    expect(metadata.description).toBeTruthy();
  });
});

describe('the licence id in the path', () => {
  async function openOrder(licenceId: string) {
    return orderRoute.default({
      params: Promise.resolve({ licenceId }),
      searchParams: Promise.resolve({}),
    });
  }

  it('404s anything that is not a licence id, before it reaches a query', async () => {
    for (const licenceId of [
      '../../etc/passwd',
      'bs-cnc-k7qm3t',
      'BS-CNC-K7QM3',
      'BS-CNC-K7QM3TT',
      'BS-CNC-K7QM3T\n',
      'BS-CNC-K7QM_T',
      '',
    ]) {
      notFound.mockClear();
      executeAuthenticatedGraphQL.mockClear();

      await expect(openOrder(licenceId)).rejects.toThrow('NEXT_NOT_FOUND');
      // The point of checking first: a junk id must never reach the login
      // callback URL or the GraphQL variables.
      expect({ licenceId, queried: executeAuthenticatedGraphQL.mock.calls.length }).toEqual({ licenceId, queried: 0 });
      expect(redirect).not.toHaveBeenCalled();
    }
  });

  it('lets a well-formed licence id through', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ cncOrder: cncOrder() });

    await expect(openOrder('BS-CNC-K7QM3T')).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });
});

describe('the ?checkout= param', () => {
  async function openOrderWith(checkout: string | string[] | undefined) {
    executeAuthenticatedGraphQL.mockResolvedValue({ cncOrder: cncOrder() });
    return orderRoute.default({
      params: Promise.resolve({ licenceId: 'BS-CNC-K7QM3T' }),
      searchParams: Promise.resolve({ checkout }),
    });
  }

  it('reads the outcome out of a repeated param', async () => {
    // `?checkout=success&checkout=success` parses as an array. Comparing that
    // to a string is always false, which silently swallows the alert Stripe
    // sent the buyer back for.
    for (const outcome of ['success', 'cancelled'] as const) {
      const tree = await openOrderWith([outcome, 'cancelled']);
      expect(orderStatusProps(tree).checkoutOutcome).toBe(outcome);
    }
  });

  it('still reads a plain string param', async () => {
    const tree = await openOrderWith('success');
    expect(orderStatusProps(tree).checkoutOutcome).toBe('success');
  });

  it('ignores an unknown outcome, an empty array and a missing param', async () => {
    for (const checkout of ['whatever', [], ['nope'], undefined] as (string | string[] | undefined)[]) {
      const tree = await openOrderWith(checkout);
      expect({ checkout, outcome: orderStatusProps(tree).checkoutOutcome }).toEqual({ checkout, outcome: null });
    }
  });
});
