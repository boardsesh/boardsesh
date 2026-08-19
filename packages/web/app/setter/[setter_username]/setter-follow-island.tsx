'use client';

import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import { useSession } from 'next-auth/react';
import FollowButton from '@/app/components/ui/follow-button';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_SETTER_PROFILE,
  FOLLOW_SETTER,
  UNFOLLOW_SETTER,
  type GetSetterProfileQueryVariables,
  type GetSetterProfileQueryResponse,
} from '@boardsesh/graphql/operations';

type SetterFollowIslandProps = {
  username: string;
};

/**
 * The one piece of this page that is viewer-specific, kept off the server
 * render on purpose.
 *
 * `/setter/*` is a shared, crawlable URL, so anything the server emits is a
 * candidate for a shared CDN entry. Server-rendering "you follow this setter"
 * would be one viewer's state cached for everyone the moment these URLs join
 * the TTL list. Fetching it here instead means the server pass reads no
 * session at all, and an anonymous crawler gets nothing: `FollowButton`
 * already returns null when there is no session, so no request is made either.
 */
export default function SetterFollowIsland({ username }: SetterFollowIslandProps) {
  const { data: session, status } = useSession();
  const [isFollowing, setIsFollowing] = useState<boolean | null>(null);

  useEffect(() => {
    if (status !== 'authenticated') return;

    let cancelled = false;
    const authToken = (session as { authToken?: string } | null)?.authToken ?? null;

    void createGraphQLHttpClient(authToken)
      .request<GetSetterProfileQueryResponse, GetSetterProfileQueryVariables>(GET_SETTER_PROFILE, {
        input: { username },
      })
      .then((response) => {
        if (!cancelled) setIsFollowing(response.setterProfile?.isFollowedByMe ?? false);
      })
      .catch((error: unknown) => {
        console.error('Failed to read setter follow state:', error);
      });

    return () => {
      cancelled = true;
    };
  }, [status, session, username]);

  // Until the state is known the button is not rendered at all, rather than
  // rendered as "Follow": a signed-in follower briefly told they don't follow
  // this setter will click it and unfollow them.
  if (isFollowing === null) return null;

  return (
    <Box>
      <FollowButton
        entityId={username}
        initialIsFollowing={isFollowing}
        followMutation={FOLLOW_SETTER}
        unfollowMutation={UNFOLLOW_SETTER}
        entityLabel="setter"
        getFollowVariables={(id) => ({ input: { setterUsername: id } })}
        onFollowChange={setIsFollowing}
      />
    </Box>
  );
}
