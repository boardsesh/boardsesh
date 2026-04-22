'use client';

import React, { useMemo } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { EmptyState } from '@/app/components/ui/empty-state';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_FOLLOWING_CLIMB_ASCENTS,
  type GetFollowingClimbAscentsQueryResponse,
  type GetFollowingClimbAscentsQueryVariables,
} from '@/app/lib/graphql/operations';
import type { Climb } from '@/app/lib/types';
import { VoteSummaryProvider } from '@/app/components/social/vote-summary-context';
import { LogbookEntryCard } from './logbook-entry-card';

// Matches BulkVoteSummaryInputSchema.entityIds.max(100) on the backend. A
// request with more than 100 IDs is rejected outright, so we slice before
// handing the list to VoteSummaryProvider. Entries beyond this cap still
// render their social footer, but the current-user vote state on those
// rows won't be hydrated (VoteButton falls back to a 0 display, not an
// error).
const VOTE_SUMMARY_BATCH_LIMIT = 100;

interface CrewLogbookViewProps {
  currentClimb: Climb;
  boardType: string;
}

export const CrewLogbookView: React.FC<CrewLogbookViewProps> = ({ currentClimb, boardType }) => {
  const { token, isAuthenticated, isLoading: authLoading } = useWsAuthToken();
  const { data: session } = useSession();
  const userId = session?.user?.id ?? null;

  const enabled = isAuthenticated && !!token && !!boardType && !!currentClimb.uuid;

  const { data, isLoading, isError } = useQuery({
    // Scope the cache per signed-in user so a user switch can't serve
    // cached ticks from the previous identity.
    queryKey: ['followingClimbAscents', userId, boardType, currentClimb.uuid],
    queryFn: async () => {
      const client = createGraphQLHttpClient(token);
      const response = await client.request<
        GetFollowingClimbAscentsQueryResponse,
        GetFollowingClimbAscentsQueryVariables
      >(GET_FOLLOWING_CLIMB_ASCENTS, {
        input: { boardType, climbUuid: currentClimb.uuid },
      });
      return response.followingClimbAscents;
    },
    enabled,
    staleTime: 60 * 1000,
  });

  const items = useMemo(() => data?.items ?? [], [data]);
  const tickUuids = useMemo(() => items.map((item) => item.uuid).slice(0, VOTE_SUMMARY_BATCH_LIMIT), [items]);

  if (authLoading || (enabled && isLoading)) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  if (!isAuthenticated) {
    return <EmptyState description="Sign in to see your crew's logbook for this climb" />;
  }

  if (isError) {
    return <EmptyState description="Couldn't load your crew's logbook. Try again in a bit." />;
  }

  if (items.length === 0) {
    return <EmptyState description="None of your crew have logged this climb yet" />;
  }

  const showMirrorTag = boardType === 'tension';

  return (
    <VoteSummaryProvider entityType="tick" entityIds={tickUuids}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {items.map((item) => (
          <LogbookEntryCard
            key={item.uuid}
            entry={{
              climbedAt: item.climbedAt,
              angle: item.angle,
              isMirror: !!item.isMirror,
              status: item.status,
              attemptCount: item.attemptCount,
              quality: item.quality ?? null,
              comment: item.comment,
              tickUuid: item.uuid,
              upvotes: item.upvotes,
              downvotes: item.downvotes,
              commentCount: item.commentCount,
            }}
            currentClimbAngle={currentClimb.angle}
            showMirrorTag={showMirrorTag}
            user={{
              userId: item.userId,
              displayName: item.userDisplayName ?? null,
              avatarUrl: item.userAvatarUrl ?? null,
            }}
          />
        ))}
      </Box>
    </VoteSummaryProvider>
  );
};
