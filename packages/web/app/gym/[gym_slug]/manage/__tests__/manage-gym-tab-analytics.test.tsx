import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { Gym } from '@boardsesh/shared-schema';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// The shell reads the active tab from the URL, so a "tab change" in these tests
// means flipping this holder and re-rendering — exactly what a real navigation
// does once the router lands.
const searchState = vi.hoisted(() => ({ params: '' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(searchState.params),
}));

vi.mock('@/app/lib/i18n/use-locale-router', () => ({
  useLocaleRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathnameWithoutLocale: () => '/gym/old-slug/manage',
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'user-owner' } }, status: 'authenticated' }),
}));

vi.mock('@/app/components/gym-entity/manage/overview-tab', () => ({ default: () => <div data-testid="overview" /> }));
vi.mock('@/app/components/gym-entity/manage/kiosks-tab', () => ({ default: () => <div data-testid="kiosks" /> }));
vi.mock('@/app/components/gym-entity/manage/insights-tab', () => ({ default: () => <div data-testid="insights" /> }));
vi.mock('@/app/components/gym-entity/manage/branding-tab', () => ({ default: () => <div data-testid="branding" /> }));
vi.mock('@/app/components/gym-entity/manage/gym-boards-tab', () => ({ default: () => <div data-testid="boards" /> }));
vi.mock('@/app/components/gym-entity/manage/comments-tab', () => ({ default: () => <div data-testid="comments" /> }));
vi.mock('@/app/components/gym-entity/manage/profile-tab', () => ({ default: () => <div data-testid="profile" /> }));
vi.mock('@/app/components/gym-entity/gym-member-management', () => ({ default: () => <div data-testid="members" /> }));

const trackGymFunnelEvent = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/gym-funnel-analytics', () => ({ trackGymFunnelEvent }));

const ManageGymContent = (await import('../manage-gym-content')).default;

function makeGym(): Gym {
  return {
    uuid: 'gym-uuid-1',
    slug: 'old-slug',
    ownerId: 'user-owner',
    name: 'Test Gym',
    boardCount: 1,
    memberCount: 1,
    followerCount: 1,
    commentCount: 0,
    isPublic: true,
    canEdit: true,
    canGrantAccess: true,
  } as unknown as Gym;
}

const tabsSeen = () =>
  trackGymFunnelEvent.mock.calls
    .map(([event]) => event as { name: string; properties: { tab: string } })
    .filter((event) => event.name === 'Gym Manage Tab Viewed')
    .map((event) => event.properties.tab);

beforeEach(() => {
  trackGymFunnelEvent.mockReset();
  searchState.params = '';
});

describe('manage console tab views', () => {
  it('reports the default tab once on mount', () => {
    render(<ManageGymContent initialGym={makeGym()} />);

    expect(tabsSeen()).toEqual(['overview']);
  });

  it('reports the deep-linked tab on mount, not the default', () => {
    // Hooking the tap handler instead of the resolved tab would miss this
    // entirely — nobody tapped anything.
    searchState.params = 'tab=members';

    render(<ManageGymContent initialGym={makeGym()} />);

    expect(tabsSeen()).toEqual(['members']);
  });

  it('does not report again when an unrelated re-render happens', () => {
    const { rerender } = render(<ManageGymContent initialGym={makeGym()} />);
    rerender(<ManageGymContent initialGym={makeGym()} />);
    rerender(<ManageGymContent initialGym={makeGym()} />);

    expect(tabsSeen()).toEqual(['overview']);
  });

  it('reports once per completed tab change', () => {
    const { rerender } = render(<ManageGymContent initialGym={makeGym()} />);

    searchState.params = 'tab=branding';
    rerender(<ManageGymContent initialGym={makeGym()} />);
    searchState.params = 'tab=kiosks';
    rerender(<ManageGymContent initialGym={makeGym()} />);

    expect(tabsSeen()).toEqual(['overview', 'branding', 'kiosks']);
  });

  it('does not report a tab tap that never lands', () => {
    // The tap only asks the router to navigate; until the URL changes the tab
    // has not been viewed. Counting taps would over-count every one the
    // dirty-guard cancels.
    render(<ManageGymContent initialGym={makeGym()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Insights' }));

    expect(tabsSeen()).toEqual(['overview']);
  });
});
