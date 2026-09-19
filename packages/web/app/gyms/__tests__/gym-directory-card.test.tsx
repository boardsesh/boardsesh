import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { GymDirectoryCard as GymDirectoryCardData } from '@boardsesh/graphql/operations';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { discoveryBoard } from '@/app/__test-helpers__/board-discovery-fixture';
import type { BoardDiscoveryBoard } from '@boardsesh/shared-schema';

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
  viewerState?: 'signed-in' | 'signed-out';
  boardPreviews?: BoardDiscoveryBoard[];
}) {
  return render(
    <GymDirectoryCard
      gym={gym(props.gym)}
      origin={props.origin ?? null}
      viewerState={props.viewerState ?? 'signed-out'}
      locale="en-US"
      boardPreviews={props.boardPreviews}
    />,
  );
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
  it('replaces only represented summary chips with physical board rows', async () => {
    await renderCard({
      gym: {
        boardSummaries: [
          { boardType: 'kilter', angle: 40 },
          { boardType: 'tension', angle: 30 },
        ],
      },
      boardPreviews: [
        discoveryBoard({ currentClimb: { uuid: 'climb-one', name: 'A real climb', frames: 'p1r12', angle: 35 } }),
      ],
    });
    expect(screen.queryByText('Kilter 40°')).toBeNull();
    expect(screen.getByText('Tension 30°')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open this board' }).getAttribute('href')).toContain(
      '/b/northside-kilter/35/list',
    );
  });

  it('does not hide summary chips for boards outside the three visible previews', async () => {
    await renderCard({
      gym: { boardSummaries: [{ boardType: 'tension', angle: 30 }] },
      boardPreviews: [
        discoveryBoard({ uuid: 'board-one' }),
        discoveryBoard({ uuid: 'board-two', slug: 'second-kilter' }),
        discoveryBoard({ uuid: 'board-three', slug: 'third-kilter' }),
        discoveryBoard({ uuid: 'board-four', slug: 'hidden-tension', boardType: 'tension', angle: 30 }),
      ],
    });
    expect(screen.getByText('Tension 30°')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Open this board' })).toHaveLength(3);
  });

  it('renders only previews belonging to this gym and keeps the board UUID route', async () => {
    await renderCard({
      boardPreviews: [
        discoveryBoard(),
        discoveryBoard({ gymUuid: 'another-gym', slug: 'wrong-wall', name: 'Other gym wall' }),
      ],
    });
    expect(screen.getByRole('link', { name: /Training room Kilter/ }).getAttribute('href')).toBe('/b/northside-kilter');
    expect(screen.queryByRole('link', { name: /Other gym wall/ })).toBeNull();
  });

  it('labels a claimed gym without offering a claim action', async () => {
    await renderCard({ gym: { isClaimed: true } });
    expect(screen.getByText('Claimed')).toBeTruthy();
    expect(screen.queryByText('Is this your gym?')).toBeNull();
  });

  it('labels an unclaimed gym and keeps its claim action', async () => {
    await renderCard({});
    expect(screen.getByText('Unclaimed')).toBeTruthy();
    expect(screen.getByText('Is this your gym?')).toBeTruthy();
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

  it('offers the claim prompt on an unclaimed gym', async () => {
    await renderCard({ gym: { isClaimed: false } });
    expect(screen.getByRole('link', { name: 'Is this your gym?' })).toBeTruthy();
  });

  it('drops the claim prompt once a gym is claimed, and changes nothing else', async () => {
    await renderCard({ gym: { isClaimed: true, address: 'Hansastraße 15, München' } });
    expect(screen.queryByRole('link', { name: 'Is this your gym?' })).toBeNull();
    // Unclaimed and claimed gyms render the same card otherwise: same heading
    // link, same address line, no badge, no demotion.
    expect(screen.getByRole('link', { name: 'Boulderwelt München Ost' })).toBeTruthy();
    expect(screen.getByText('Hansastraße 15, München')).toBeTruthy();
  });

  it('uses isClaimed, not the viewer-scoped canClaim, so anonymous visitors see the prompt', async () => {
    // `canClaim` is false for every signed-out viewer — i.e. the directory's
    // whole audience — so gating on it would hide this from everyone.
    await renderCard({ gym: { isClaimed: false }, viewerState: 'signed-out' });
    expect(screen.getByRole('link', { name: 'Is this your gym?' })).toBeTruthy();
  });
});
