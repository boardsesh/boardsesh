'use client';

import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import FollowButton from '@/app/components/ui/follow-button';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_SETTER_PROFILE,
  FOLLOW_SETTER,
  UNFOLLOW_SETTER,
  type GetSetterProfileQueryVariables,
  type GetSetterProfileQueryResponse,
} from '@boardsesh/graphql/operations';

const countSx = { display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' };

type SetterFollowIslandProps = {
  username: string;
  /** Server-rendered follower count — the initial value, kept live from here on. */
  initialFollowerCount: number;
};

/**
 * The follower count, and the one piece of this page that is viewer-specific.
 *
 * `/setter/*` is a shared, crawlable URL, so anything the *server* resolves is
 * a candidate for a shared CDN entry. Reading "you follow this setter" on the
 * server would be one viewer's state cached for everyone the moment these URLs
 * join the TTL list (#4580). Fetching it here instead means the server pass
 * reads no session at all, and an anonymous crawler pays nothing:
 * `FollowButton` returns null with no session, and the effect below never runs.
 *
 * The count lives here rather than in the server component so a follow or
 * unfollow moves it, and so a signed-in viewer picks up the live number the
 * follow-state fetch already returns — the component this replaced kept it in local state, and
 * a hero showing the pre-click number until a refresh is a regression. It is
 * still in the crawlable HTML: a client component's first render happens on the
 * server, and `initialFollowerCount` is a server-resolved prop.
 */
export default function SetterFollowIsland({ username, initialFollowerCount }: SetterFollowIslandProps) {
  const { status } = useSession();
  const { t } = useTranslation('profile');
  // The credential the button WRITES with, so the read and the write speak for
  // the same viewer: `useFollowToggle` takes its token from here too. This read
  // used to cast the session to `{ authToken?: string }`, a field NextAuth's
  // `session` callback never sets and `Session` never declares — so it resolved
  // to `undefined`, every request went out anonymous, and `isFollowedByMe` came
  // back the way it does for a stranger. A follower was shown "Follow".
  //
  // `enabled` keeps an anonymous visitor paying nothing, which is the rule this
  // island exists to keep: no session, no token fetch, no follow-state read,
  // and `FollowButton` renders null regardless.
  const { token: authToken } = useWsAuthToken(status === 'authenticated');
  const [isFollowing, setIsFollowing] = useState<boolean | null>(null);
  const [followerCount, setFollowerCount] = useState(initialFollowerCount);

  useEffect(() => {
    // Whose answer this is matters. Signing out, signing back in as somebody
    // else and routing to another setter all re-run this effect, and state kept
    // from the last run renders the PREVIOUS viewer's button. "Following" shown
    // to a stranger is the expensive direction: `useFollowToggle` sends
    // UNFOLLOW from that state and takes the count down.
    setIsFollowing(null);

    if (!authToken) return;

    let cancelled = false;

    void createGraphQLHttpClient(authToken)
      .request<GetSetterProfileQueryResponse, GetSetterProfileQueryVariables>(GET_SETTER_PROFILE, {
        input: { username },
      })
      .then((response) => {
        if (cancelled) return;
        setIsFollowing(response.setterProfile?.isFollowedByMe ?? false);
        // The same response already carries the live count, so discarding it
        // and rendering the server snapshot until the viewer follows somebody
        // is a stale number for no saving. Safe to overwrite: the button is
        // not rendered until `isFollowing` resolves, so there is no click this
        // can land behind.
        const liveCount = response.setterProfile?.followerCount;
        if (typeof liveCount === 'number') setFollowerCount(liveCount);
      })
      .catch((error: unknown) => {
        console.error('Failed to read setter follow state:', error);
        // Leave the state unknown, which renders no button — the same rule the
        // pending state follows, for the same reason. Falling back to `false`
        // showed "Follow" to a climber who already follows this setter, and the
        // click that follows is not merely a redundant mutation: `FollowButton`
        // reports it through `onFollowChange`, so the count below ticks up to a
        // number this setter does not have. Losing the affordance until a
        // reload is the smaller cost.
      });

    return () => {
      cancelled = true;
    };
  }, [authToken, username]);

  // The COUNT renders unconditionally — including in the server pass, since a
  // client component's first render happens on the server — so the crawlable
  // HTML still carries it. Only the button waits, and `null` means waiting
  // whether the read is still in flight or has failed: a button is worth
  // rendering only once it can name the viewer's real state, since one shown as
  // "Follow" to somebody who already follows costs a click that inflates the
  // count rather than changing anything.
  return (
    <Box sx={countSx}>
      <span>
        {followerCount} {t('setter.follower', { count: followerCount })}
      </span>
      {isFollowing !== null && (
        <FollowButton
          entityId={username}
          initialIsFollowing={isFollowing}
          followMutation={FOLLOW_SETTER}
          unfollowMutation={UNFOLLOW_SETTER}
          entityLabel="setter"
          getFollowVariables={(id) => ({ input: { setterUsername: id } })}
          onFollowChange={(following) => {
            setIsFollowing(following);
            // The server-rendered count is a snapshot; without this the hero
            // keeps showing the pre-click number until a refresh, which the
            // component this replaced did keep in step.
            setFollowerCount((current) => current + (following ? 1 : -1));
          }}
        />
      )}
    </Box>
  );
}
