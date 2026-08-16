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

const formatNumber = (value: number) => new Intl.NumberFormat('en-US').format(value);

function gym(overrides: Partial<GymDirectoryCardData> = {}): GymDirectoryCardData {
  return {
    uuid: 'gym-1',
    slug: 'boulderwelt-muenchen-ost',
    name: 'Boulderwelt München Ost',
    address: null,
    latitude: null,
    longitude: null,
    boardCount: 1,
    isClaimed: false,
    boardSummaries: [],
    ...overrides,
  };
}

async function renderCard(props: {
  gym?: Partial<GymDirectoryCardData>;
  origin?: { latitude: number; longitude: number } | null;
  viewerState?: 'signed-in' | 'signed-out';
}) {
  const element = await GymDirectoryCard({
    gym: gym(props.gym),
    origin: props.origin ?? null,
    viewerState: props.viewerState ?? 'signed-out',
    formatNumber,
  });
  return render(element);
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
