'use client';

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Avatar from '@mui/material/Avatar';
import MuiButton from '@mui/material/Button';
import ErrorOutline from '@mui/icons-material/ErrorOutline';
import ChatBubbleOutlineOutlined from '@mui/icons-material/ChatBubbleOutlineOutlined';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import LocaleLink from '@/app/components/i18n/locale-link';

import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useInfiniteQuery } from '@tanstack/react-query';
import { persistUser } from '@/app/lib/react-query-persist-meta';
import { EmptyState } from '@/app/components/ui/empty-state';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_GLOBAL_COMMENT_FEED,
  type GetGlobalCommentFeedResponse,
} from '@/app/lib/graphql/operations/comments-votes';
import type { Comment as CommentType, CommentConnection } from '@boardsesh/shared-schema';
import VoteButton from '@/app/components/social/vote-button';
import FeedItemSkeleton from './feed-item-skeleton';
import { useInfiniteScroll } from '@/app/hooks/use-infinite-scroll';

dayjs.extend(relativeTime);

const ENTITY_TYPE_LABELS: Record<string, string> = {
  session: 'a session',
  climb: 'a climb',
  proposal: 'a proposal',
  tick: 'an ascent',
  comment: 'a comment',
  board: 'a board',
  gym: 'a gym',
  playlist_climb: 'a playlist climb',
};

type CommentFeedProps = {
  isAuthenticated: boolean;
  boardUuid?: string | null;
};

export default function CommentFeed({ isAuthenticated, boardUuid }: CommentFeedProps) {
  const { t } = useTranslation('feed');
  const { token, isLoading: authLoading } = useWsAuthToken();

  const queryKey = ['globalCommentFeed', boardUuid] as const;

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, error, refetch } = useInfiniteQuery<
    CommentConnection,
    Error
  >({
    queryKey,
    queryFn: async ({ pageParam }) => {
      const client = createGraphQLHttpClient(isAuthenticated ? token : null);
      const input = {
        limit: 20,
        cursor: pageParam as string | null,
        boardUuid: boardUuid || undefined,
      };

      const response = await client.request<GetGlobalCommentFeedResponse>(GET_GLOBAL_COMMENT_FEED, { input });
      return response.globalCommentFeed;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => {
      if (!lastPage.hasMore) return undefined;
      return lastPage.cursor ?? undefined;
    },
    enabled: isAuthenticated ? !!token : true,
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnMount: 'always',
    // Per-row userVote is viewer-specific, so persist per-user (the shared
    // store is not wiped on account switch and would leak vote state across
    // identities for the restored frame).
    meta: persistUser,
  });

  const comments: CommentType[] = useMemo(() => data?.pages.flatMap((p) => p.comments) ?? [], [data]);

  const { sentinelRef } = useInfiniteScroll({
    onLoadMore: fetchNextPage,
    hasMore: hasNextPage ?? false,
    isFetching: isFetchingNextPage,
  });

  if ((authLoading || isLoading) && comments.length === 0) {
    return (
      <Box data-testid="comment-feed" sx={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <FeedItemSkeleton />
        <FeedItemSkeleton />
        <FeedItemSkeleton />
      </Box>
    );
  }

  return (
    <Box data-testid="comment-feed" sx={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {error && (
        <EmptyState icon={<ErrorOutline fontSize="inherit" />} description={t('errors.loadComments')}>
          <MuiButton variant="contained" onClick={() => refetch()}>
            {t('common:actions.retry')}
          </MuiButton>
        </EmptyState>
      )}

      {!error && comments.length === 0 ? (
        <EmptyState icon={<ChatBubbleOutlineOutlined fontSize="inherit" />} description={t('commentFeed.empty')} />
      ) : (
        <>
          {comments.map((comment) => (
            <CommentFeedCard key={comment.uuid} comment={comment} />
          ))}
          <Box
            ref={sentinelRef}
            data-testid="comment-feed-sentinel"
            sx={{ display: 'flex', flexDirection: 'column', gap: '12px', py: 2, minHeight: 20 }}
          >
            {isFetchingNextPage && (
              <>
                <FeedItemSkeleton />
                <FeedItemSkeleton />
              </>
            )}
          </Box>
        </>
      )}
    </Box>
  );
}

function CommentFeedCard({ comment }: { comment: CommentType }) {
  const { t } = useTranslation('feed');
  const timeAgo = dayjs(comment.createdAt).fromNow();
  const entityLabel = ENTITY_TYPE_LABELS[comment.entityType] || comment.entityType;

  return (
    <Card data-testid="comment-feed-item" sx={{ borderRadius: 2 }}>
      <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
        {/* User header */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Avatar
            src={comment.userAvatarUrl ?? undefined}
            sx={{ width: 32, height: 32 }}
            component={LocaleLink}
            href={`/profile/${comment.userId}`}
          >
            {!comment.userAvatarUrl && <PersonOutlined sx={{ fontSize: 16 }} />}
          </Avatar>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              variant="body2"
              fontWeight={600}
              component={LocaleLink}
              href={`/profile/${comment.userId}`}
              sx={{ textDecoration: 'none', color: 'text.primary' }}
            >
              {comment.userDisplayName || 'User'}
            </Typography>
            <Typography variant="body2" component="span" color="text.secondary">
              {' '}
              {t('commentFeed.commentedOn', { entity: entityLabel })}
            </Typography>
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
            {timeAgo}
          </Typography>
        </Box>

        {/* Comment body */}
        {comment.body && (
          <Box
            sx={{
              bgcolor: 'action.hover',
              borderLeft: '3px solid',
              borderColor: 'divider',
              borderRadius: 1,
              px: 1.5,
              py: 1,
              mb: 1,
            }}
          >
            <Typography variant="body2" color="text.secondary">
              {comment.body}
            </Typography>
          </Box>
        )}

        {/* Vote + reply count */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
          <VoteButton
            entityType="comment"
            entityId={comment.uuid}
            initialUpvotes={comment.upvotes}
            initialDownvotes={comment.downvotes}
            initialUserVote={comment.userVote}
          />
          {comment.replyCount > 0 && (
            <Typography variant="caption" color="text.secondary">
              {comment.replyCount} {comment.replyCount === 1 ? 'reply' : 'replies'}
            </Typography>
          )}
        </Box>
      </CardContent>
    </Card>
  );
}
