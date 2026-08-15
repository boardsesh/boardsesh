'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from 'next-auth/react';
import { FOLLOW_GYM, UNFOLLOW_GYM } from '@boardsesh/graphql/operations';
import { gymPageCtaClicked } from '@boardsesh/analytics';
import FollowButton from '@/app/components/ui/follow-button';
import { trackGymFunnelEvent } from '@/app/lib/gym-funnel-analytics';

type GymFollowButtonProps = {
  gymUuid: string;
  ownerId: string;
  isFollowedByMe: boolean;
};

/**
 * Client island: the Follow control on the public gym page. Reuses the same
 * FollowButton the preview sheet mounts, so the state, optimistic toggle, and
 * copy stay identical. Hidden for the gym's owner (you don't follow your own
 * gym) and, via FollowButton itself, for signed-out visitors.
 */
export default function GymFollowButton({ gymUuid, ownerId, isFollowedByMe }: GymFollowButtonProps) {
  const { t } = useTranslation('boards');
  const { data: session } = useSession();
  const currentUserId = session?.user?.id ?? null;

  if (currentUserId && currentUserId === ownerId) {
    return null;
  }

  return (
    <FollowButton
      entityId={gymUuid}
      initialIsFollowing={isFollowedByMe}
      followMutation={FOLLOW_GYM}
      unfollowMutation={UNFOLLOW_GYM}
      entityLabel={t('gymEntity.follow.entityLabel')}
      getFollowVariables={(id) => ({ input: { gymUuid: id } })}
      // One event per accepted click. NOT onFollowChange — that fires again on
      // rollback, so a failed follow would also report an unfollow.
      onToggleClick={() => trackGymFunnelEvent(gymPageCtaClicked({ cta: 'follow', gymUuid }))}
    />
  );
}
