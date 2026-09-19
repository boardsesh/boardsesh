import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { GymDirectoryCard as GymDirectoryCardData } from '@boardsesh/graphql/operations';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const getServerTranslation = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/i18n/server', () => ({ getServerTranslation }));

const trackGymFunnelEvent = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/gym-funnel-analytics', () => ({
  trackGymFunnelEvent,
  viewerStateFrom: (isAuthenticated: boolean) => (isAuthenticated ? 'signed-in' : 'signed-out'),
}));

const GymDirectoryCard = (await import('../gym-directory-card')).default;

function gym(overrides: Partial<GymDirectoryCardData> = {}): GymDirectoryCardData {
  return {
    uuid: 'gym-1',
    slug: 'boulderwelt-muenchen-ost',
    name: 'Boulderwelt München Ost',
    address: null,
    latitude: null,
    longitude: null,
    isClaimed: false,
    boardSummaries: [],
    ...overrides,
  };
}

// A client component now (near-me results are fetched in the browser and
// render the same card), so it is rendered rather than awaited.
async function renderCard(props: {
  gym?: Partial<GymDirectoryCardData>;
  origin?: { latitude: number; longitude: number } | null;
}) {
  return render(<GymDirectoryCard gym={gym(props.gym)} origin={props.origin ?? null} locale="en-US" />);
}

beforeEach(() => {
  trackGymFunnelEvent.mockReset();
  getServerTranslation.mockResolvedValue({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog('gyms', key, options),
    i18n: {},
    locale: 'en-US',
  });
});

describe('GymDirectoryCard', () => {
  it('labels a claimed gym', async () => {
    await renderCard({ gym: { isClaimed: true } });
    expect(screen.getByText('Claimed')).toBeTruthy();
  });

  it('labels an unclaimed gym', async () => {
    await renderCard({});
    expect(screen.getByText('Unclaimed')).toBeTruthy();
  });

  it('links the gym name with a real href a crawler can follow', async () => {
    await renderCard({});
    const link = screen.getByRole('link', { name: 'Boulderwelt München Ost' });
    expect(link.getAttribute('href')).toBe('/gym/boulderwelt-muenchen-ost');
  });

  it('renders the gym name as the card heading', async () => {
    await renderCard({});
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Boulderwelt München Ost');
  });

  it('shows the free-text address when the gym typed one', async () => {
    await renderCard({ gym: { address: 'Hansastraße 15, München' } });
    expect(screen.getByText('Hansastraße 15, München')).toBeTruthy();
  });

  it('falls back to a distance when there is a pin and the request had an origin', async () => {
    await renderCard({
      gym: { latitude: 51.3811, longitude: -2.359 },
      origin: { latitude: 51.4545, longitude: -2.5879 },
    });
    expect(screen.getByText(/km away$/)).toBeTruthy();
  });

  it('shows no location line for a pin with no origin, rather than inventing a city', async () => {
    const { container } = await renderCard({ gym: { latitude: 51.3811, longitude: -2.359 } });
    expect(container.textContent).not.toContain('km away');
    expect(screen.queryByTestId('LocationOnOutlinedIcon')).toBeNull();
  });

  it('adds a distance line next to an address once a location is shared', async () => {
    await renderCard({
      gym: { address: 'Hansastraße 15, München', latitude: 51.3811, longitude: -2.359 },
      origin: { latitude: 51.4545, longitude: -2.5879 },
    });
    // The address still wins the location line; the distance is additive.
    expect(screen.getByText('Hansastraße 15, München')).toBeTruthy();
    expect(screen.getByText(/km away$/)).toBeTruthy();
  });

  it('renders one chip per distinct board and angle', async () => {
    await renderCard({
      gym: {
        boardSummaries: [
          { boardType: 'kilter', angle: 40 },
          { boardType: 'kilter', angle: 40 },
          { boardType: 'moonboard', angle: 25 },
        ],
      },
    });
    expect(screen.getByText('Kilter 40°')).toBeTruthy();
    expect(screen.getByText('MoonBoard 25°')).toBeTruthy();
    expect(screen.getAllByText('Kilter 40°')).toHaveLength(1);
  });

  it('renders a bare board name when no angle was recorded', async () => {
    await renderCard({ gym: { boardSummaries: [{ boardType: 'tension', angle: 0 }] } });
    expect(screen.getByText('Tension')).toBeTruthy();
  });

  it('carries no claim prompt of its own — the page has one, under the list', async () => {
    // It used to render on every unclaimed row, which is most rows, so a page
    // of 24 gyms asked "Is this your gym?" 24 times.
    await renderCard({ gym: { isClaimed: false } });
    expect(screen.queryByText(/Is this your gym\?/)).toBeNull();
  });

  it('renders the same card claimed or not, apart from the badge', async () => {
    await renderCard({ gym: { isClaimed: true, address: 'Hansastraße 15, München' } });
    // Same heading link, same address line, no demotion.
    expect(screen.getByRole('link', { name: 'Boulderwelt München Ost' })).toBeTruthy();
    expect(screen.getByText('Hansastraße 15, München')).toBeTruthy();
  });
});
