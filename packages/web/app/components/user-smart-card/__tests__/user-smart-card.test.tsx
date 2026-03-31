import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, back: vi.fn() }),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@/app/crusher/[user_id]/utils/profile-constants', () => ({
  getLayoutDisplayName: (boardType: string, layoutId: number | null) =>
    `${boardType}-${layoutId}`,
  getLayoutColor: () => 'rgba(100,100,100,0.7)',
}));

let mockFetch: ReturnType<typeof vi.fn>;

import UserSmartCard from '../user-smart-card';

const mockProfileResponse = {
  id: 'user-1',
  name: 'Test Climber',
  image: null,
  profile: { displayName: 'TestDisplay', avatarUrl: null },
  followerCount: 5,
  followingCount: 12,
};

const mockStatsResponse = {
  userProfileStats: {
    totalDistinctClimbs: 42,
    layoutStats: [
      {
        layoutKey: 'kilter-1',
        boardType: 'kilter',
        layoutId: 1,
        distinctClimbCount: 30,
        gradeCounts: [],
      },
      {
        layoutKey: 'tension-9',
        boardType: 'tension',
        layoutId: 9,
        distinctClimbCount: 12,
        gradeCounts: [],
      },
    ],
  },
};

describe('UserSmartCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  it('shows loading skeleton initially', () => {
    mockFetch.mockReturnValue(new Promise(() => {})); // never resolves
    mockRequest.mockReturnValue(new Promise(() => {}));
    render(<UserSmartCard userId="user-1" />);

    // Skeleton elements should be present (MUI Skeleton renders with role)
    const skeletons = document.querySelectorAll('.MuiSkeleton-root');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders profile data after loading', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockProfileResponse),
    });
    mockRequest.mockResolvedValue(mockStatsResponse);

    render(<UserSmartCard userId="user-1" />);

    await waitFor(() => {
      expect(screen.getByText('TestDisplay')).toBeTruthy();
    });

    expect(screen.getByText(/5 followers/)).toBeTruthy();
    expect(screen.getByText(/12 following/)).toBeTruthy();
    expect(screen.getByText('42 distinct climbs')).toBeTruthy();
  });

  it('shows error state when profile fetch fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    mockRequest.mockResolvedValue({ userProfileStats: null });

    render(<UserSmartCard userId="user-1" />);

    await waitFor(() => {
      expect(screen.getByText(/Couldn't load your profile/)).toBeTruthy();
    });
  });

  it('shows error state when fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    mockRequest.mockRejectedValue(new Error('GraphQL error'));

    render(<UserSmartCard userId="user-1" />);

    await waitFor(() => {
      expect(screen.getByText(/Couldn't load your profile/)).toBeTruthy();
    });
  });

  it('shows empty state when user has no climbs', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockProfileResponse),
    });
    mockRequest.mockResolvedValue({
      userProfileStats: { totalDistinctClimbs: 0, layoutStats: [] },
    });

    render(<UserSmartCard userId="user-1" />);

    await waitFor(() => {
      expect(screen.getByText(/No climbs logged yet/)).toBeTruthy();
    });
  });

  it('navigates to profile page on click', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockProfileResponse),
    });
    mockRequest.mockResolvedValue(mockStatsResponse);

    render(<UserSmartCard userId="user-1" />);

    await waitFor(() => {
      expect(screen.getByText('TestDisplay')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('TestDisplay'));
    expect(mockPush).toHaveBeenCalledWith('/crusher/user-1');
  });

  it('refetches data when refreshKey changes', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockProfileResponse),
    });
    mockRequest.mockResolvedValue(mockStatsResponse);

    const { rerender } = render(<UserSmartCard userId="user-1" refreshKey={0} />);

    await waitFor(() => {
      expect(screen.getByText('TestDisplay')).toBeTruthy();
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);

    rerender(<UserSmartCard userId="user-1" refreshKey={1} />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
