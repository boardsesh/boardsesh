'use client';

import React from 'react';

import Link from 'next/link';
import { useQueueActions, useSessionData } from '../graphql-queue';
import { constructPlayUrlWithSlugs, getContextAwareClimbViewUrl } from '@/app/lib/url-utils';
import { BoardDetails } from '@/app/lib/types';
import { useResolvedBoardDetails } from '@/app/hooks/use-resolved-board-details';
import { track } from '@vercel/analytics';
import FastRewindOutlined from '@mui/icons-material/FastRewindOutlined';
import IconButton from '@mui/material/IconButton';
import type { IconButtonProps } from '@mui/material/IconButton';

type PreviousClimbButtonProps = {
  navigate: boolean;
  boardDetails?: BoardDetails;
};

const PreviousButton = (props: IconButtonProps) => (
  <IconButton {...props} aria-label="Previous climb"><FastRewindOutlined /></IconButton>
);

export default function PreviousClimbButton({ navigate = false, boardDetails }: PreviousClimbButtonProps) {
  const { getPreviousClimbQueueItem, setCurrentClimbQueueItem } = useQueueActions();
  const { viewOnlyMode } = useSessionData();
  const { rawParams, angle, pathname, searchParams, isPlayPage, resolvedDetails } =
    useResolvedBoardDetails(boardDetails);

  const previousClimb = getPreviousClimbQueueItem();

  const buildClimbUrl = () => {
    if (!previousClimb) return '';
    let climbUrl = '';

    if (isPlayPage) {
      if (resolvedDetails.layout_name && resolvedDetails.size_name && resolvedDetails.set_names) {
        climbUrl = constructPlayUrlWithSlugs(
          resolvedDetails.board_name,
          resolvedDetails.layout_name,
          resolvedDetails.size_name,
          resolvedDetails.size_description,
          resolvedDetails.set_names,
          angle,
          previousClimb.climb.uuid,
          previousClimb.climb.name,
        );
      } else {
        climbUrl = `/${rawParams.board_name}/${rawParams.layout_id}/${rawParams.size_id}/${rawParams.set_ids}/${rawParams.angle}/play/${previousClimb.climb.uuid}`;
      }

      const queryString = searchParams.toString();
      if (queryString) {
        climbUrl = `${climbUrl}?${queryString}`;
      }
    } else {
      climbUrl = getContextAwareClimbViewUrl(
        pathname,
        resolvedDetails,
        angle,
        previousClimb.climb.uuid,
        previousClimb.climb.name,
      );
    }

    return climbUrl;
  };

  const handleClick = () => {
    if (!previousClimb) return;
    setCurrentClimbQueueItem(previousClimb);
    track('Queue Navigation', {
      direction: 'previous',
      boardLayout: boardDetails?.layout_name || '',
    });

    if (navigate && isPlayPage) {
      const url = buildClimbUrl();
      if (url) window.history.pushState(null, '', url);
    }
  };

  if (!viewOnlyMode && navigate && previousClimb) {
    if (isPlayPage) {
      return <PreviousButton onClick={handleClick} />;
    }

    const climbUrl = buildClimbUrl();
    return (
      <Link href={climbUrl} prefetch={false} onClick={handleClick}>
        <PreviousButton />
      </Link>
    );
  }
  return <PreviousButton onClick={handleClick} disabled={!previousClimb || viewOnlyMode} />;
}
