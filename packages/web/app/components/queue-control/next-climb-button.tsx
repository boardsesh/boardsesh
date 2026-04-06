'use client';

import React from 'react';
import Link from 'next/link';
import { useQueueActions, useSessionData } from '../graphql-queue';
import { constructPlayUrlWithSlugs, getContextAwareClimbViewUrl } from '@/app/lib/url-utils';
import { BoardDetails } from '@/app/lib/types';
import { useResolvedBoardDetails } from '@/app/hooks/use-resolved-board-details';
import FastForwardOutlined from '@mui/icons-material/FastForwardOutlined';
import { track } from '@vercel/analytics';
import IconButton from '@mui/material/IconButton';
import type { IconButtonProps } from '@mui/material/IconButton';

type NextClimbButtonProps = {
  navigate: boolean;
  boardDetails?: BoardDetails;
};

const NextButton = (props: IconButtonProps) => (
  <IconButton {...props} aria-label="Next climb"><FastForwardOutlined /></IconButton>
);

export default function NextClimbButton({ navigate = false, boardDetails }: NextClimbButtonProps) {
  const { setCurrentClimbQueueItem, getNextClimbQueueItem } = useQueueActions();
  const { viewOnlyMode } = useSessionData();
  const { rawParams, angle, pathname, searchParams, isPlayPage, resolvedDetails } =
    useResolvedBoardDetails(boardDetails);

  const nextClimb = getNextClimbQueueItem();

  const buildClimbUrl = () => {
    if (!nextClimb) return '';
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
          nextClimb.climb.uuid,
          nextClimb.climb.name,
        );
      } else {
        climbUrl = `/${rawParams.board_name}/${rawParams.layout_id}/${rawParams.size_id}/${rawParams.set_ids}/${rawParams.angle}/play/${nextClimb.climb.uuid}`;
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
        nextClimb.climb.uuid,
        nextClimb.climb.name,
      );
    }

    return climbUrl;
  };

  const handleClick = () => {
    if (!nextClimb) return;
    setCurrentClimbQueueItem(nextClimb);
    track('Queue Navigation', {
      direction: 'next',
      boardLayout: boardDetails?.layout_name || '',
    });

    if (navigate && isPlayPage) {
      const url = buildClimbUrl();
      if (url) window.history.pushState(null, '', url);
    }
  };

  if (!viewOnlyMode && navigate && nextClimb) {
    if (isPlayPage) {
      return <NextButton onClick={handleClick} />;
    }

    const climbUrl = buildClimbUrl();
    return (
      <Link href={climbUrl} prefetch={false} onClick={handleClick}>
        <NextButton />
      </Link>
    );
  }
  return <NextButton onClick={handleClick} disabled={!nextClimb || viewOnlyMode} />;
}
