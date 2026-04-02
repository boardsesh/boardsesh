import React from 'react';
import type { BoardDetails, Climb } from '@/app/lib/types';
import PlayStyleClimbDetailClient from '@/app/components/climb-detail/play-style-climb-detail.client';

interface ClimbDetailPageServerProps {
  climb: Climb;
  boardDetails: BoardDetails;
  angle: number;
}

export default function ClimbDetailPageServer({
  climb,
  boardDetails,
  angle,
}: ClimbDetailPageServerProps) {
  return <PlayStyleClimbDetailClient climb={climb} boardDetails={boardDetails} angle={angle} />;
}
