import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { GymDirectoryCard } from '@boardsesh/graphql/operations';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const geolocation = vi.hoisted(() => ({
  useGeolocation: vi.fn(),
  requestPermission: vi.fn(),
}));
vi.mock('@/app/hooks/use-geolocation', () => ({ useGeolocation: geolocation.useGeolocation }));

const reactQuery = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: reactQuery.useQuery }));

const graphql = vi.hoisted(() => ({ request: vi.fn(), createGraphQLHttpClient: vi.fn() }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: graphql.createGraphQLHttpClient }));

const analytics = vi.hoisted(() => ({ trackGymFunnelEvent: vi.fn() }));
vi.mock('@/app/lib/gym-funnel-analytics', () => ({
  trackGymFunnelEvent: analytics.trackGymFunnelEvent,
  viewerStateFrom: (isAuthenticated: boolean) => (isAuthenticated ? 'signed-in' : 'signed-out'),
}));

// The map is covered by its own file; here it only has to not pull leaflet in.
vi.mock('../gym-directory-map', () => ({
  default: ({ pinnedCount, shownCount }: { pinnedCount: number; shownCount: number }) => (
    <div data-testid="map-stub" data-pinned={pinnedCount} data-shown={shownCount} />
  ),
}));

const GymDirectoryNearMe = (await import('../gym-directory-near-me')).default;

type QueryOptions = {
  queryKey: unknown[];
  queryFn: () => Promise<unknown>;
  enabled: boolean;
};

type QueryResult = {
  data?: { gyms: GymDirectoryCard[]; totalCount: number };
  isPending: boolean;
  isError: boolean;
};

let queryResult: QueryResult;
let lastQueryOptions: QueryOptions | null = null;

function gym(overrides: Partial<GymDirectoryCard> = {}): GymDirectoryCard {
  return {
    uuid: 'gym-1',
    slug: 'boulderwelt',
    name: 'Boulderwelt',
    address: null,
    latitude: 51.4,
    longitude: -2.5,
    isClaimed: true,
    boardSummaries: [],
    ...overrides,
  };
}

function setGeolocation(state: {
  coordinates?: { latitude: number; longitude: number; accuracy: number } | null;
  error?: { code?: number } | null;
  loading?: boolean;
}) {
  geolocation.useGeolocation.mockReturnValue({
    coordinates: state.coordinates ?? null,
    error: state.error ?? null,
    loading: state.loading ?? false,
    permissionState: null,
    requestPermission: geolocation.requestPermission,
    refresh: vi.fn(),
  });
}

function renderNearMe() {
  return render(
    <GymDirectoryNearMe
      boardTypes={['kilter']}
      locale="en-US"
      viewerState="signed-out"
      browsePins={[]}
      browsePinnedCount={15}
      browseShownCount={24}
    >
      <div data-testid="browse-list">Every gym</div>
    </GymDirectoryNearMe>,
  );
}

/**
 * jsdom ships no `navigator.geolocation`, so without this every test would sit
 * in the `unsupported` fallback with the button disabled — i.e. exactly the
 * branch the one test below wants, and none of the others.
 */
function defineGeolocationSupport(supported: boolean) {
  if (supported) {
    Object.defineProperty(navigator, 'geolocation', {
      value: { getCurrentPosition: vi.fn() },
      configurable: true,
    });
  } else {
    Reflect.deleteProperty(navigator, 'geolocation');
  }
}

beforeEach(() => {
  defineGeolocationSupport(true);
  analytics.trackGymFunnelEvent.mockReset();
  geolocation.requestPermission.mockReset();
  graphql.request.mockReset().mockResolvedValue({ searchGyms: { gyms: [], totalCount: 0 } });
  graphql.createGraphQLHttpClient.mockReset().mockReturnValue({ request: graphql.request });
  setGeolocation({});
  queryResult = { data: undefined, isPending: true, isError: false };
  lastQueryOptions = null;
  reactQuery.useQuery.mockReset().mockImplementation((options: QueryOptions) => {
    lastQueryOptions = options;
    return queryResult;
  });
});

describe('browse mode', () => {
  it('renders the server list untouched and no near-me notice', () => {
    renderNearMe();

    expect(screen.getByTestId('browse-list')).toBeTruthy();
    expect(screen.queryByText(/only shows gyms that dropped a map pin/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Use my location' })).toBeTruthy();
  });

  it('never runs the proximity query until somebody opts in', () => {
    renderNearMe();
    expect(lastQueryOptions?.enabled).toBe(false);
  });

  it('feeds the map the server page pin coverage', () => {
    renderNearMe();
    const map = screen.getByTestId('map-stub');
    expect(map.getAttribute('data-pinned')).toBe('15');
    expect(map.getAttribute('data-shown')).toBe('24');
  });

  it('offers the map behind a toggle for narrow viewports, with no matchMedia read', () => {
    renderNearMe();
    // The toggle exists at every width; CSS decides where it shows. Nothing in
    // this component asks the window how wide it is.
    expect(screen.getByRole('button', { name: 'Show map' })).toBeTruthy();
  });
});

describe('permission denied', () => {
  beforeEach(() => {
    setGeolocation({ error: { code: 1 } });
  });

  it('asks the browser once and degrades to a text-search hint', async () => {
    renderNearMe();
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }));

    expect(geolocation.requestPermission).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText(/keeping your location to itself/)).toBeTruthy());
  });

  it('leaves the full list on the page — nothing is unreachable without location', () => {
    renderNearMe();
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }));

    expect(screen.getByTestId('browse-list')).toBeTruthy();
    // And the control offers the retry again rather than a "show all" for a
    // near-me list that never rendered.
    expect(screen.getByRole('button', { name: 'Use my location' })).toBeTruthy();
    expect(lastQueryOptions?.enabled).toBe(false);
  });

  it('fires no search event for a denial', () => {
    renderNearMe();
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }));
    expect(analytics.trackGymFunnelEvent).not.toHaveBeenCalled();
  });
});

describe('no geolocation API at all', () => {
  it('shows the text-search hint unprompted, because the button is unusable', async () => {
    setGeolocation({});
    defineGeolocationSupport(false);

    renderNearMe();

    await waitFor(() => expect(screen.getByText(/browser doesn't do location/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Use my location' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('near-me results', () => {
  beforeEach(() => {
    setGeolocation({ coordinates: { latitude: 51.4545092, longitude: -2.5879431, accuracy: 10 } });
    queryResult = {
      data: { gyms: [gym(), gym({ uuid: 'gym-2', slug: 'redpoint', name: 'Redpoint' })], totalCount: 2 },
      isPending: false,
      isError: false,
    };
  });

  it('replaces the browse list, states the radius and says what it is hiding', () => {
    renderNearMe();
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }));

    expect(screen.queryByTestId('browse-list')).toBeNull();
    expect(screen.getByText('2 gyms within 25 km')).toBeTruthy();
    expect(screen.getByText(/only shows gyms that dropped a map pin/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Redpoint' })).toBeTruthy();
  });

  it('puts the whole list back in one tap', () => {
    renderNearMe();
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show all gyms' }));

    expect(screen.getByTestId('browse-list')).toBeTruthy();
    expect(screen.queryByText(/only shows gyms that dropped a map pin/)).toBeNull();
  });

  it('reports the search as Gym Directory Searched with hasGeo and no coordinates', () => {
    renderNearMe();
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }));

    expect(analytics.trackGymFunnelEvent).toHaveBeenCalledTimes(1);
    const event = analytics.trackGymFunnelEvent.mock.calls[0][0];
    expect(event.name).toBe('Gym Directory Searched');
    expect(event.properties.hasGeo).toBe(true);
    expect(event.properties.boardTypes).toBe('kilter');
    expect(event.properties.resultsCount).toBe(2);

    // The same rule the contract's own test enforces, asserted at the call
    // site that actually has coordinates in scope.
    const serialised = JSON.stringify(event);
    expect(/-?\d{1,3}\.\d+/.test(serialised)).toBe(false);
    expect(/lat|lng|lon|coord/i.test(JSON.stringify(Object.keys(event.properties)))).toBe(false);
  });

  it('fires once per result set, not once per interaction', () => {
    renderNearMe();
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }));
    fireEvent.click(screen.getByTestId('map-stub'));

    expect(analytics.trackGymFunnelEvent).toHaveBeenCalledTimes(1);
  });

  it('draws the near-me pin coverage on the map instead of the browse page numbers', () => {
    renderNearMe();
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }));

    const map = screen.getByTestId('map-stub');
    expect(map.getAttribute('data-pinned')).toBe('2');
    expect(map.getAttribute('data-shown')).toBe('2');
  });
});

describe('the proximity query itself', () => {
  beforeEach(() => {
    setGeolocation({ coordinates: { latitude: 51.4545092, longitude: -2.5879431, accuracy: 10 } });
    queryResult = { data: { gyms: [], totalCount: 0 }, isPending: false, isError: false };
  });

  it('rounds the coordinates and caps the limit at what the backend zod allows', async () => {
    renderNearMe();
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }));

    await lastQueryOptions?.queryFn();

    const [, variables] = graphql.request.mock.calls[0];
    expect(variables.input).toEqual({
      boardTypes: ['kilter'],
      latitude: 51.455,
      longitude: -2.588,
      radiusKm: 25,
      requireSlug: true,
      // `SearchGymsInputSchema.limit` is `.max(50)` and throws past it.
      limit: 50,
      offset: 0,
    });
  });

  it('keeps raw coordinates out of the cache key too', () => {
    renderNearMe();
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }));

    expect(lastQueryOptions?.queryKey).toEqual(['gym-directory-near-me', 'kilter', 51.455, -2.588, 25]);
  });

  it('re-queries at the radius the climber picked', () => {
    renderNearMe();
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }));
    fireEvent.click(screen.getByRole('button', { name: '100 km' }));

    expect(lastQueryOptions?.queryKey.at(-1)).toBe(100);
  });

  it('surfaces a failed search instead of an empty "no gyms near you"', () => {
    queryResult = { data: undefined, isPending: false, isError: true };
    renderNearMe();
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }));

    expect(screen.getByText(/couldn't run that search/)).toBeTruthy();
  });

  it('says nothing was in range rather than showing an empty page', () => {
    renderNearMe();
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }));

    expect(screen.getByText(/No gyms with a map pin in that radius/)).toBeTruthy();
  });
});
