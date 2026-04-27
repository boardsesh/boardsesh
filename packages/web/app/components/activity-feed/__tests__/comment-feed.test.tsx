import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import type { Comment as CommentType } from '@boardsesh/shared-schema';

// --- Mocks ---

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: vi.fn(),
}));

vi.mock('@/app/lib/graphql/operations/comments-votes', () => ({
  GET_GLOBAL_COMMENT_FEED: 'GET_GLOBAL_COMMENT_FEED',
}));

vi.mock('@/app/hooks/use-infinite-scroll', () => ({
  useInfiniteScroll: () => ({ sentinelRef: { current: null } }),
}));

vi.mock('@/app/components/social/vote-button', () => ({
  default: () => <div data-testid="vote-button" />,
}));

vi.mock('../feed-item-skeleton', () => ({
  default: () => <div data-testid="feed-item-skeleton" />,
}));

import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import CommentFeed from '../comment-feed';

const mockUseWsAuthToken = vi.mocked(useWsAuthToken);

// --- Helpers ---

function makeComment(uuid: string, entityType = 'session'): CommentType {
  return {
    uuid,
    userId: 'user-1',
    userDisplayName: 'Test User',
    userAvatarUrl: undefined,
    entityType: entityType as CommentType['entityType'],
    entityId: 'entity-1',
    parentCommentUuid: null,
    body: 'Great session!',
    isPublic: false,
    isDeleted: false,
    replyCount: 0,
    upvotes: 1,
    downvotes: 0,
    voteScore: 1,
    userVote: 0,
    createdAt: '2024-01-15T10:00:00.000Z',
    updatedAt: '2024-01-15T10:00:00.000Z',
  };
}

function createWrapper(queryClient?: QueryClient) {
  const client = queryClient ?? createTestQueryClient();
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('CommentFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequest.mockReset();
  });

  describe('Loading state', () => {
    it('shows skeleton placeholders while loading', () => {
      mockUseWsAuthToken.mockReturnValue({
        token: null,
        isAuthenticated: false,
        isLoading: true,
        error: null,
      });

      render(<CommentFeed isAuthenticated={false} />, { wrapper: createWrapper() });

      expect(screen.getAllByTestId('feed-item-skeleton')).toHaveLength(3);
    });
  });

  describe('Data fetching', () => {
    beforeEach(() => {
      mockUseWsAuthToken.mockReturnValue({
        token: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
      });
    });

    it('fetches and renders comment cards', async () => {
      const comments = [makeComment('c1'), makeComment('c2', 'climb')];
      mockRequest.mockResolvedValueOnce({
        globalCommentFeed: { comments, totalCount: 0, hasMore: false, cursor: null },
      });

      render(<CommentFeed isAuthenticated={false} />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getAllByTestId('comment-feed-item')).toHaveLength(2);
      });

      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(mockRequest).toHaveBeenCalledWith('GET_GLOBAL_COMMENT_FEED', expect.any(Object));
    });

    it('shows entity type labels', async () => {
      const comments = [
        makeComment('c1', 'session'),
        makeComment('c2', 'climb'),
        makeComment('c3', 'proposal'),
      ];
      mockRequest.mockResolvedValueOnce({
        globalCommentFeed: { comments, totalCount: 0, hasMore: false, cursor: null },
      });

      render(<CommentFeed isAuthenticated={false} />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText(/a session/)).toBeTruthy();
        expect(screen.getByText(/a climb/)).toBeTruthy();
        expect(screen.getByText(/a proposal/)).toBeTruthy();
      });
    });

    it('shows comment body text', async () => {
      const comments = [makeComment('c1')];
      mockRequest.mockResolvedValueOnce({
        globalCommentFeed: { comments, totalCount: 0, hasMore: false, cursor: null },
      });

      render(<CommentFeed isAuthenticated={false} />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Great session!')).toBeTruthy();
      });
    });

    it('shows empty state when no comments', async () => {
      mockRequest.mockResolvedValueOnce({
        globalCommentFeed: { comments: [], totalCount: 0, hasMore: false, cursor: null },
      });

      render(<CommentFeed isAuthenticated={false} />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText(/No comments yet/)).toBeTruthy();
      });
    });
  });

  describe('Board filter', () => {
    it('passes boardUuid to the query', async () => {
      mockUseWsAuthToken.mockReturnValue({
        token: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
      });

      mockRequest.mockResolvedValueOnce({
        globalCommentFeed: { comments: [], totalCount: 0, hasMore: false, cursor: null },
      });

      render(
        <CommentFeed isAuthenticated={false} boardUuid="board-456" />,
        { wrapper: createWrapper() },
      );

      await waitFor(() => {
        expect(mockRequest).toHaveBeenCalledWith(
          'GET_GLOBAL_COMMENT_FEED',
          expect.objectContaining({
            input: expect.objectContaining({ boardUuid: 'board-456' }),
          }),
        );
      });
    });
  });

  describe('Pagination', () => {
    beforeEach(() => {
      mockUseWsAuthToken.mockReturnValue({
        token: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
      });
    });

    it('requests first page with null cursor', async () => {
      mockRequest.mockResolvedValueOnce({
        globalCommentFeed: {
          comments: [makeComment('c1')],
          totalCount: 1,
          hasMore: false,
          cursor: null,
        },
      });

      render(<CommentFeed isAuthenticated={false} />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getAllByTestId('comment-feed-item')).toHaveLength(1);
      });

      expect(mockRequest).toHaveBeenCalledWith(
        'GET_GLOBAL_COMMENT_FEED',
        expect.objectContaining({
          input: expect.objectContaining({ cursor: null, limit: 20 }),
        }),
      );
    });

    it('returns cursor for next page when hasMore is true', async () => {
      const comments = Array.from({ length: 20 }, (_, i) => makeComment(`c${i}`));
      mockRequest.mockResolvedValueOnce({
        globalCommentFeed: {
          comments,
          totalCount: 30,
          hasMore: true,
          cursor: 'next-cursor-abc',
        },
      });

      const queryClient = createTestQueryClient();
      render(<CommentFeed isAuthenticated={false} />, { wrapper: createWrapper(queryClient) });

      await waitFor(() => {
        expect(screen.getAllByTestId('comment-feed-item')).toHaveLength(20);
      });

      // Verify query state has the page data with cursor
      const state = queryClient.getQueryState(['globalCommentFeed', undefined]);
      expect(state?.data).toBeDefined();
    });
  });

  describe('Error state', () => {
    it('shows error state with retry button on failure', async () => {
      mockUseWsAuthToken.mockReturnValue({
        token: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
      });

      mockRequest.mockRejectedValueOnce(new Error('Network error'));

      render(<CommentFeed isAuthenticated={false} />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText(/Failed to load comments/)).toBeTruthy();
      });

      expect(screen.getByText('Retry')).toBeTruthy();
    });

    it('calls refetch when retry button is clicked', async () => {
      mockUseWsAuthToken.mockReturnValue({
        token: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
      });

      // First call fails
      mockRequest.mockRejectedValueOnce(new Error('Network error'));

      render(<CommentFeed isAuthenticated={false} />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Retry')).toBeTruthy();
      });

      // Set up success response for retry
      mockRequest.mockResolvedValueOnce({
        globalCommentFeed: { comments: [makeComment('c1')], totalCount: 1, hasMore: false, cursor: null },
      });

      fireEvent.click(screen.getByText('Retry'));

      await waitFor(() => {
        expect(mockRequest).toHaveBeenCalledTimes(2);
      });
    });
  });
});
