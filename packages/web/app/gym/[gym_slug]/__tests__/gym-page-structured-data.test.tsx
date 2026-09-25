import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import React from 'react';
import type { Gym } from '@boardsesh/shared-schema';

/**
 * `SportsActivityLocation` describes a PLACE the public can climb at. A
 * climber's personal home wall is not one, and the markup carries the same name
 * — usually the owner's own — that the page title does, so shipping it there is
 * the index leak in a second format.
 */

vi.mock('server-only', () => ({}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  permanentRedirect: () => {
    throw new Error('permanentRedirect');
  },
}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: vi.fn(async () => 'en-US') }));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken: vi.fn(async () => undefined) }));
vi.mock('@/app/lib/analytics', () => ({ track: vi.fn() }));

const executeAuthenticatedGraphQL = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL }));

const GymPage = (await import('../page')).default;

function gym(slug: string, overrides: Partial<Gym> = {}): Gym {
  return {
    uuid: `uuid-${slug}`,
    slug,
    name: 'Boulderwelt',
    isPublic: true,
    canEdit: false,
    latitude: 48.1351,
    longitude: 11.582,
    ...overrides,
  } as unknown as Gym;
}

function respondWith(gymRow: Gym): void {
  executeAuthenticatedGraphQL.mockImplementation(async (document: unknown) => {
    const text = String(document);
    if (text.includes('gymSprayWalls')) return { gymSprayWalls: [] };
    if (text.includes('gymBoards')) return { gymBoards: [] };
    if (text.includes('gymBySlug')) return { gymBySlug: gymRow };
    return {};
  });
}

/** Every element in a rendered-but-not-mounted tree, depth first. */
function allElements(node: React.ReactNode): React.ReactElement[] {
  const found: React.ReactElement[] = [];
  const visit = (current: React.ReactNode): void => {
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (!React.isValidElement(current)) return;
    found.push(current);
    visit((current.props as { children?: React.ReactNode }).children);
  };
  visit(node);
  return found;
}

type StructuredData = { '@type'?: string; name?: string };

const structuredDataPayloads = (node: React.ReactNode): StructuredData[] =>
  allElements(node)
    .map((element) => (element.props as { data?: unknown }).data)
    .filter((payload): payload is StructuredData => typeof payload === 'object' && payload !== null);

// `fetchGymBySlug` is wrapped in React's `cache()`, so each test uses its own slug.
const renderPage = (slug: string) =>
  GymPage({ params: Promise.resolve({ gym_slug: slug }), searchParams: Promise.resolve({}) });

beforeEach(() => {
  executeAuthenticatedGraphQL.mockReset();
});

describe("a gym page's structured data", () => {
  it('describes a geocoded public gym as a SportsActivityLocation', async () => {
    respondWith(gym('venue-jsonld'));

    const tree = await renderPage('venue-jsonld');

    expect(structuredDataPayloads(tree).map((payload) => payload['@type'])).toContain('SportsActivityLocation');
  });

  it('publishes no venue markup for a pin-less home wall', async () => {
    respondWith(gym('home-wall-jsonld', { latitude: null, longitude: null, name: "Zhou Zhou's MoonBoard" }));

    const tree = await renderPage('home-wall-jsonld');

    expect(structuredDataPayloads(tree).map((payload) => payload['@type'])).not.toContain('SportsActivityLocation');
  });
});
