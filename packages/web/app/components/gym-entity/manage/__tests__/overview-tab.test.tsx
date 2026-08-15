import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { Gym } from '@boardsesh/shared-schema';
import OverviewTab from '../overview-tab';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token', isAuthenticated: true, isLoading: false, error: null }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'user-owner' } }, status: 'authenticated' }),
}));

// The welcome checklist has its own IndexedDB + query machinery; stub it so this
// test can prove the checklist was relocated INTO the Overview surface without
// dragging in that machinery.
vi.mock('../gym-welcome-card', () => ({ default: () => <div data-testid="welcome-card" /> }));

// EmbedCodeDialog's Copy button uses the snackbar; stub the provider so opening
// the dialog doesn't need a real one.
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

function makeGym(overrides: Partial<Gym> = {}): Gym {
  return {
    uuid: 'gym-uuid-1',
    slug: 'test-gym',
    ownerId: 'user-owner',
    name: 'Test Gym',
    boardCount: 3,
    memberCount: 4,
    followerCount: 7,
    commentCount: 0,
    isPublic: true,
    ...overrides,
  } as unknown as Gym;
}

function renderTab(gym: Gym) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <OverviewTab gym={gym} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockResolvedValue({ gymKiosks: [{ uuid: 'k1' }, { uuid: 'k2' }] });
});

describe('OverviewTab', () => {
  it('deep-links each quick link to its manage tab', async () => {
    renderTab(makeGym());

    const cases: Record<string, string> = {
      'Put it on the TV': '/gym/test-gym/manage?tab=kiosks',
      'Set your colors': '/gym/test-gym/manage?tab=branding',
      'Link your boards': '/gym/test-gym/manage?tab=boards',
      'Invite your crew': '/gym/test-gym/manage?tab=members',
      "See this week's activity": '/gym/test-gym/manage?tab=insights',
      'Edit your profile': '/gym/test-gym/manage?tab=profile',
    };
    for (const [label, href] of Object.entries(cases)) {
      const link = await screen.findByRole('link', { name: new RegExp(label, 'i') });
      expect(link.getAttribute('href')).toBe(href);
    }
  });

  it('links to the public gym page', async () => {
    renderTab(makeGym());
    const link = await screen.findByRole('link', { name: /view public page/i });
    expect(link.getAttribute('href')).toBe('/gym/test-gym');
  });

  it('links to the printable QR poster', async () => {
    renderTab(makeGym());
    const link = await screen.findByRole('link', { name: /print your poster/i });
    expect(link.getAttribute('href')).toBe('/gym/test-gym/poster');
  });

  it('hides the poster link for a slug-less gym — the printed code encodes the slug', async () => {
    renderTab(makeGym({ slug: null }));
    await screen.findByRole('link', { name: /put it on the tv/i });
    expect(screen.queryByRole('link', { name: /print your poster/i })).toBeNull();
  });

  it('shows the follower/member/board counts from the gym and the kiosk count from the query', async () => {
    renderTab(makeGym());

    // Kiosk count comes from the mocked GET_GYM_KIOSKS response (2 kiosks).
    expect(await screen.findByText('2')).toBeTruthy();
    // Counts already on the gym.
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('kiosks')).toBeTruthy();
  });

  it('shows a loading skeleton for the kiosk count while the query is in flight, not a hard 0', () => {
    mockRequest.mockReset();
    mockRequest.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = renderTab(makeGym());
    // Skeleton while pending; the server-passed counts still render; no hard 0.
    expect(container.querySelector('.MuiSkeleton-root')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('falls back to an em-dash for the kiosk count when the query fails', async () => {
    mockRequest.mockReset();
    mockRequest.mockRejectedValue(new Error('boom'));
    const { container } = renderTab(makeGym());
    // Settled error state: an em-dash, not an endless skeleton.
    expect(await screen.findByText('—')).toBeTruthy();
    expect(container.querySelector('.MuiSkeleton-root')).toBeNull();
  });

  it('mounts the relocated welcome checklist at the top of the surface', () => {
    renderTab(makeGym());
    expect(screen.getByTestId('welcome-card')).toBeTruthy();
  });

  it('opens the embed dialog with the gym leaderboard snippet', async () => {
    renderTab(makeGym());

    fireEvent.click(await screen.findByRole('button', { name: /embed on your website/i }));

    await waitFor(() => {
      const field = screen.getByDisplayValue(/\/embed\/gym\/gym-uuid-1\/leaderboard/);
      expect(field).toBeTruthy();
    });
  });

  it('hides the public-page link for a slug-less gym', async () => {
    renderTab(makeGym({ slug: null }));
    // Quick links fall back to the UUID; the public-page button is slug-only.
    await screen.findByRole('link', { name: /put it on the tv/i });
    expect(screen.queryByRole('button', { name: /view public page/i })).toBeNull();
  });
});
