import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import ProfilePageContent from '../profile-page-content';
import { useProfileData } from '../hooks/use-profile-data';

// --- Mocks (before component imports) ---

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('next-auth/react', () => ({
  useSession: vi.fn(() => ({ status: 'authenticated', data: { user: { id: 'user-1' } } })),
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock('../hooks/use-profile-data', () => ({
  useProfileData: vi.fn(),
}));

const mockBuildWeeklyBars = vi.fn(
  (): Array<{
    label: string;
    segments: Array<{ value: number; color: string; label: string }>;
  }> => [],
);
vi.mock('../utils/chart-data-builders', () => ({
  buildWeeklyBars: () => mockBuildWeeklyBars(),
}));

vi.mock('../components/user-card', () => ({
  default: (props: { userId: string }) => <div data-testid="user-card" data-user-id={props.userId} />,
}));

vi.mock('../components/profile-nav-card', () => ({
  default: (props: { title: string; href: string }) => (
    <div data-testid={`nav-card-${props.title.toLowerCase().replace(/\s+/g, '-')}`} data-href={props.href}>
      {props.title}
    </div>
  ),
}));

vi.mock('../components/profile-beta-section', () => ({
  default: () => null,
}));

vi.mock('@/app/components/charts/css-bar-chart', () => ({
  CssBarChart: () => <div data-testid="overview-chart" />,
}));

vi.mock('@/app/hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ gradeFormat: 'vscale', loaded: true }),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

vi.mock('@/app/components/ui/empty-state', () => ({
  EmptyState: (props: { description: string }) => <div data-testid="empty-state">{props.description}</div>,
}));

vi.mock('@/app/components/back-button', () => ({
  default: () => <div data-testid="back-button" />,
}));

vi.mock('@/app/components/brand/logo', () => ({
  default: () => <div data-testid="logo" />,
}));

vi.mock('@/app/components/profile-header-bridge/profile-header-bridge-context', () => ({
  ProfileHeaderShareInjector: (props: { displayName: string | null; isActive: boolean }) => (
    <div
      data-testid="profile-header-share-injector"
      data-active={props.isActive ? 'true' : 'false'}
      data-display-name={props.displayName ?? ''}
    />
  ),
}));

vi.mock('@/app/lib/share-utils', () => ({
  shareWithFallback: vi.fn(),
}));

// --- Imports after mocks ---

const mockUseProfileData = vi.mocked(useProfileData);

// --- Helpers ---

function mockProfileDataReturn(overrides?: Partial<ReturnType<typeof useProfileData>>) {
  return {
    loading: false,
    notFound: false,
    profile: null,
    setProfile: vi.fn(),
    isOwnProfile: false,
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

function makeProfile(overrides?: Record<string, unknown>) {
  return {
    id: 'user-2',
    email: 'climber@example.com',
    displayName: 'Test Climber',
    avatarUrl: null,
    instagramUrl: null,
    followerCount: 5,
    followingCount: 3,
    isFollowedByMe: false,
    ...overrides,
  };
}

describe('ProfilePageContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseProfileData.mockReturnValue(mockProfileDataReturn());
  });

  it('shows loading spinner when loading is true', () => {
    mockUseProfileData.mockReturnValue(mockProfileDataReturn({ loading: true }));

    render(<ProfilePageContent userId="user-2" />);

    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(screen.queryByTestId('user-card')).toBeNull();
  });

  it('shows "User not found" empty state when notFound is true', () => {
    mockUseProfileData.mockReturnValue(mockProfileDataReturn({ notFound: true }));

    render(<ProfilePageContent userId="user-2" />);

    expect(screen.getByTestId('empty-state')).toBeTruthy();
    expect(screen.getByText('User not found')).toBeTruthy();
    expect(screen.getByTestId('profile-header-share-injector').getAttribute('data-active')).toBe('false');
  });

  it('renders user card with userId when profile exists', () => {
    const profile = makeProfile();
    mockUseProfileData.mockReturnValue(mockProfileDataReturn({ profile }));

    render(<ProfilePageContent userId="user-2" />);

    const userCard = screen.getByTestId('user-card');
    expect(userCard).toBeTruthy();
    expect(userCard.getAttribute('data-user-id')).toBe('user-2');
    expect(screen.getByTestId('profile-header-share-injector').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('profile-header-share-injector').getAttribute('data-display-name')).toBe('Test Climber');
  });

  it('renders Statistics and Sessions navigation cards', () => {
    const profile = makeProfile();
    mockUseProfileData.mockReturnValue(mockProfileDataReturn({ profile }));

    render(<ProfilePageContent userId="user-2" />);

    expect(screen.getByTestId('nav-card-sessions')).toBeTruthy();
    expect(screen.getByTestId('nav-card-statistics')).toBeTruthy();
  });

  it('always shows "Created Climbs" nav card', () => {
    const profile = makeProfile();
    mockUseProfileData.mockReturnValue(mockProfileDataReturn({ profile }));

    render(<ProfilePageContent userId="user-2" />);

    expect(screen.getByTestId('nav-card-created-climbs')).toBeTruthy();
  });

  it('nav cards link to correct sub-pages', () => {
    const profile = makeProfile();
    mockUseProfileData.mockReturnValue(mockProfileDataReturn({ profile }));

    render(<ProfilePageContent userId="user-2" />);

    expect(screen.getByTestId('nav-card-sessions').getAttribute('data-href')).toBe('/profile/user-2/sessions');
    expect(screen.getByTestId('nav-card-statistics').getAttribute('data-href')).toBe('/profile/user-2/statistics');
    expect(screen.getByTestId('nav-card-created-climbs').getAttribute('data-href')).toBe('/profile/user-2/climbs');
  });

  it('renders overview chart when tick data is available', () => {
    const profile = makeProfile();
    const allBoardsTicks = {
      kilter: [
        {
          climbed_at: new Date().toISOString(),
          difficulty: 15,
          tries: 1,
          angle: 40,
          status: 'send' as const,
          climbUuid: 'c1',
        },
      ],
    };
    mockUseProfileData.mockReturnValue(mockProfileDataReturn({ profile, allBoardsTicks }));

    mockBuildWeeklyBars.mockReturnValue([{ label: 'W1', segments: [{ value: 3, color: '#ccc', label: 'V3' }] }]);

    render(<ProfilePageContent userId="user-2" initialAllBoardsTicks={allBoardsTicks} />);

    expect(screen.getByTestId('overview-chart')).toBeTruthy();
  });

  it('does not render a local share button or local header chrome', () => {
    const profile = makeProfile();
    mockUseProfileData.mockReturnValue(mockProfileDataReturn({ profile }));

    render(<ProfilePageContent userId="user-2" />);

    expect(screen.queryByLabelText('Share profile')).toBeNull();
    expect(screen.queryByTestId('back-button')).toBeNull();
    expect(screen.queryByTestId('logo')).toBeNull();
  });
});
