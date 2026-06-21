// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicUserProfile } from '@boardsesh/shared-schema';
import { UPDATE_PROFILE } from '../../operations';

const requestMock = vi.fn();
vi.mock('../../client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));
vi.mock('../use-infinite-search-climbs', () => ({ useInfiniteSearchClimbs: vi.fn() }));
vi.mock('../use-beta-link-preview', () => ({ useBetaLinkPreview: vi.fn() }));
vi.mock('../use-mobile-climb-actions-data', () => ({ useMobileClimbActionsData: vi.fn() }));
vi.mock('../use-you-data', () => ({
  useAllBoardsTicks: vi.fn(),
  useUserProfileStats: vi.fn(),
  useUserClimbPercentile: vi.fn(),
  useUserAscentsFeed: vi.fn(),
  useActivityFeed: vi.fn(),
  useSessionGroupedFeed: vi.fn(),
}));
vi.mock('../use-you-profile-data', () => ({ useYouProfileData: vi.fn() }));
vi.mock('../use-social', () => ({
  usePublicProfile: vi.fn(),
  useFollowers: vi.fn(),
  useFollowing: vi.fn(),
  useSearchUsers: vi.fn(),
  useToggleUserFollow: vi.fn(),
  useUserClimbs: vi.fn(),
  useVote: vi.fn(),
  useBulkVoteSummaries: vi.fn(),
  useChunkedBulkVoteSummaries: vi.fn(),
  useGroupedBulkVoteSummaries: vi.fn(),
  useComments: vi.fn(),
  useAddComment: vi.fn(),
}));
vi.mock('../use-session-detail', () => ({ useSessionDetail: vi.fn(), useSessionPreview: vi.fn() }));
vi.mock('../use-delete-account', () => ({ useDeleteAccountInfo: vi.fn(), useDeleteAccount: vi.fn() }));
vi.mock('../use-integrations', () => ({
  useIntegrationStatuses: vi.fn(),
  useDisconnectIntegration: vi.fn(),
  useSetIntegrationAutoSync: vi.fn(),
  useSyncSessionToIntegration: vi.fn(),
}));

import { useUpdateProfile } from '../index';

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('useUpdateProfile', () => {
  it('writes the returned profile into current and public profile caches', async () => {
    const updatedProfile = {
      id: 'user-1',
      email: 'alex@example.com',
      displayName: 'Alex Sender',
      avatarUrl: 'https://ws.example.com/static/avatars/user-1.jpg?v=upload-123',
    };
    const cachedPublicProfile: PublicUserProfile = {
      id: 'user-1',
      displayName: 'Alex',
      avatarUrl: 'https://ws.example.com/static/avatars/user-1.jpg?v=old',
      followerCount: 10,
      followingCount: 3,
      isFollowedByMe: false,
    };
    requestMock.mockResolvedValue({ updateProfile: updatedProfile });
    const { queryClient, Wrapper } = makeWrapper();
    queryClient.setQueryData(['publicProfile', 'user-1'], cachedPublicProfile);

    const { result } = renderHook(() => useUpdateProfile(), { wrapper: Wrapper });

    await result.current.mutateAsync({ avatarUrl: updatedProfile.avatarUrl });

    expect(requestMock).toHaveBeenCalledWith(UPDATE_PROFILE, { input: { avatarUrl: updatedProfile.avatarUrl } });
    expect(queryClient.getQueryData(['profile'])).toEqual({ profile: updatedProfile });
    expect(queryClient.getQueryData(['publicProfile', 'user-1'])).toEqual({
      ...cachedPublicProfile,
      displayName: updatedProfile.displayName,
      avatarUrl: updatedProfile.avatarUrl,
    });
  });
});
