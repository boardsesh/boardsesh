import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import YouProgressContent from '../you-progress-content';
import YouTabBar from '../you-tab-bar';
import { useProfileData } from '@/app/profile/[user_id]/hooks/use-profile-data';
import { usePathname } from 'next/navigation';

// --- Mocks (before component imports) ---

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const mockPush = vi.fn();

vi.mock('next-auth/react', () => ({
  useSession: vi.fn(() => ({ status: 'authenticated', data: { user: { id: 'user-1' } } })),
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: mockPush })),
  usePathname: vi.fn(() => '/you'),
}));

vi.mock('@/app/profile/[user_id]/hooks/use-profile-data', () => ({
  useProfileData: vi.fn(),
}));

vi.mock('@/app/profile/[user_id]/components/stats-summary', () => ({
  default: (props: { weeklyBars?: unknown[] | null }) => (
    <div data-testid="stats-summary" data-has-weekly-bars={props.weeklyBars ? 'true' : 'false'} />
  ),
}));

vi.mock('@/app/profile/[user_id]/components/board-stats-section', () => ({
  default: (props: Record<string, unknown>) => (
    <div
      data-testid="board-stats-section"
      data-has-weekly-bars-prop={Object.prototype.hasOwnProperty.call(props, 'weeklyBars') ? 'true' : 'false'}
    />
  ),
}));

vi.mock('@/app/components/stats-filter-bridge/stats-filter-bridge-context', () => ({
  StatsFilterBridgeInjector: () => <div data-testid="stats-filter-bridge" />,
}));

vi.mock('@/app/components/stats-filter-drawer/stats-filter-drawer', () => ({
  default: () => <div data-testid="stats-filter-drawer" />,
}));

vi.mock('@/app/components/social/follower-count', () => ({
  default: (props: { userId: string; followerCount: number; followingCount: number }) => (
    <div data-testid="follower-count" data-user-id={props.userId}>
      {props.followerCount} followers, {props.followingCount} following
    </div>
  ),
}));

// --- Imports after mocks ---

const mockUseProfileData = vi.mocked(useProfileData);
const mockUsePathname = vi.mocked(usePathname);

// --- Helpers ---

function mockProfileDataReturn(overrides?: Partial<ReturnType<typeof useProfileData>>) {
  return {
    loading: false,
    notFound: false,
    profile: null,
    setProfile: vi.fn(),
    isOwnProfile: true,
    selectedBoard: 'all',
    setSelectedBoard: vi.fn(),
    allBoardsTicks: {},
    filteredLogbook: [],
    unifiedTimeframe: 'all' as const,
    setUnifiedTimeframe: vi.fn(),
    fromDate: '',
    setFromDate: vi.fn(),
    toDate: '',
    setToDate: vi.fn(),
    weeklyBars: null,
    aggregatedFlashRedpointBars: null,
    vPointsTimeline: null,
    loadingAggregated: false,
    aggregatedStackedBars: null,
    loadingProfileStats: false,
    layoutStats: [],
    statisticsSummary: { totalAscents: 0, layoutPercentages: [] },
    hardestSend: null,
    hardestFlash: null,
    percentile: null,
    ...overrides,
  };
}

describe('YouProgressContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseProfileData.mockReturnValue(mockProfileDataReturn());
  });

  it('shows the page skeleton when loading is true', () => {
    mockUseProfileData.mockReturnValue(mockProfileDataReturn({ loading: true }));

    const { container } = render(<YouProgressContent userId="user-1" />);

    // YouPageSkeleton renders MUI Skeletons (.MuiSkeleton-root) instead of the
    // old CircularProgress, so we assert at least one skeleton is present and
    // that none of the real content has rendered yet.
    expect(container.querySelectorAll('.MuiSkeleton-root').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('stats-summary')).toBeNull();
  });

  it('renders stats summary and board stats section', () => {
    render(<YouProgressContent userId="user-1" />);

    expect(screen.getByTestId('stats-summary')).toBeTruthy();
    expect(screen.getByTestId('board-stats-section')).toBeTruthy();
  });

  it('renders the profile header with display name and follower counts when profile is loaded', () => {
    mockUseProfileData.mockReturnValue(
      mockProfileDataReturn({
        profile: {
          id: 'user-123',
          email: 'test@boardsesh.com',
          displayName: 'Display Name',
          avatarUrl: null,
          instagramUrl: null,
          followerCount: 42,
          followingCount: 17,
          isFollowedByMe: false,
        },
      }),
    );

    render(<YouProgressContent userId="user-1" />);

    expect(screen.getByRole('heading', { level: 1, name: 'Display Name' })).toBeTruthy();
    const followerCount = screen.getByTestId('follower-count');
    expect(followerCount.getAttribute('data-user-id')).toBe('user-123');
    expect(followerCount.textContent).toContain('42 followers');
  });

  // The backend coalesces displayName onto users.name before it ever reaches
  // this component, so a null here means the account has no name at all.
  it("falls back to 'Climber' when there is no display name", () => {
    mockUseProfileData.mockReturnValue(
      mockProfileDataReturn({
        profile: {
          id: 'user-123',
          email: 'test@boardsesh.com',
          displayName: null,
          avatarUrl: null,
          instagramUrl: null,
          followerCount: 0,
          followingCount: 0,
          isFollowedByMe: false,
        },
      }),
    );

    render(<YouProgressContent userId="user-1" />);

    expect(screen.getByRole('heading', { level: 1, name: 'Climber' })).toBeTruthy();
  });

  it('renders the avatar when one is set', () => {
    mockUseProfileData.mockReturnValue(
      mockProfileDataReturn({
        profile: {
          id: 'user-123',
          email: 'test@boardsesh.com',
          displayName: 'Display Name',
          avatarUrl: 'https://example.com/profile-avatar.jpg',
          instagramUrl: null,
          followerCount: 0,
          followingCount: 0,
          isFollowedByMe: false,
        },
      }),
    );

    render(<YouProgressContent userId="user-1" />);

    expect(screen.getByRole('img').getAttribute('src')).toBe('https://example.com/profile-avatar.jpg');
  });

  it('passes weekly bars into StatsSummary and keeps BoardStatsSection fallback-only', () => {
    mockUseProfileData.mockReturnValue(
      mockProfileDataReturn({
        filteredLogbook: [
          {
            climbed_at: new Date().toISOString(),
            difficulty: 12,
            tries: 2,
            angle: 40,
            status: 'send',
            climbUuid: 'climb-1',
          },
        ],
        weeklyBars: [{ key: '2026-W1', label: 'W1', segments: [{ value: 3, color: '#ccc', label: 'V4' }] }],
      }),
    );

    render(<YouProgressContent userId="user-1" />);

    expect(screen.getByTestId('stats-summary').getAttribute('data-has-weekly-bars')).toBe('true');
    expect(screen.getByTestId('board-stats-section').getAttribute('data-has-weekly-bars-prop')).toBe('false');
  });
});

describe('YouTabBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has three tabs: Progress, Sessions, Logbook', () => {
    mockUsePathname.mockReturnValue('/you');
    render(<YouTabBar />);

    expect(screen.getByRole('tab', { name: 'Progress' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Sessions' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Logbook' })).toBeTruthy();
  });

  it('highlights Progress tab on /you path', () => {
    mockUsePathname.mockReturnValue('/you');
    render(<YouTabBar />);

    expect(screen.getByRole('tab', { name: 'Progress', selected: true })).toBeTruthy();
  });

  it('highlights Sessions tab on /you/sessions path', () => {
    mockUsePathname.mockReturnValue('/you/sessions');
    render(<YouTabBar />);

    expect(screen.getByRole('tab', { name: 'Sessions', selected: true })).toBeTruthy();
  });

  it('highlights Logbook tab on /you/logbook path', () => {
    mockUsePathname.mockReturnValue('/you/logbook');
    render(<YouTabBar />);

    expect(screen.getByRole('tab', { name: 'Logbook', selected: true })).toBeTruthy();
  });

  it('navigates to /you/sessions when Sessions tab is clicked', () => {
    mockUsePathname.mockReturnValue('/you');
    render(<YouTabBar />);

    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }));

    expect(mockPush).toHaveBeenCalledWith('/you/sessions', { scroll: false });
  });

  it('navigates to /you/logbook when Logbook tab is clicked', () => {
    mockUsePathname.mockReturnValue('/you');
    render(<YouTabBar />);

    fireEvent.click(screen.getByRole('tab', { name: 'Logbook' }));

    expect(mockPush).toHaveBeenCalledWith('/you/logbook', { scroll: false });
  });

  it('navigates to /you when Progress tab is clicked', () => {
    mockUsePathname.mockReturnValue('/you/sessions');
    render(<YouTabBar />);

    fireEvent.click(screen.getByRole('tab', { name: 'Progress' }));

    expect(mockPush).toHaveBeenCalledWith('/you', { scroll: false });
  });
});
