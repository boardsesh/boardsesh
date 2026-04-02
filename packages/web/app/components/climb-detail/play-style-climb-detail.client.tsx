'use client';

import React, { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import BackButton from '@/app/components/back-button';
import ClimbDetailShellClient from '@/app/components/climb-detail/climb-detail-shell.client';
import { useBuildClimbDetailSections } from '@/app/components/climb-detail/build-climb-detail-sections';
import PlayClimbAboveFold from '@/app/components/play-view/play-climb-above-fold';
import { LogAscentDrawer } from '@/app/components/logbook/log-ascent-drawer';
import { constructClimbListWithSlugs } from '@/app/lib/url-utils';
import type { BoardDetails, Climb } from '@/app/lib/types';

interface PlayStyleClimbDetailClientProps {
  climb: Climb;
  boardDetails: BoardDetails;
  angle: number;
}

export default function PlayStyleClimbDetailClient({ climb, boardDetails, angle }: PlayStyleClimbDetailClientProps) {
  const [tickOpen, setTickOpen] = useState(false);

  const sections = useBuildClimbDetailSections({
    climb,
    climbUuid: climb.uuid,
    boardType: boardDetails.board_name,
    angle,
    currentClimbDifficulty: climb.difficulty ?? undefined,
    boardName: boardDetails.board_name,
  });

  const backUrl = useMemo(() => {
    const { board_name, layout_name, size_name, size_description, set_names } = boardDetails;

    if (layout_name && size_name && set_names) {
      return constructClimbListWithSlugs(board_name, layout_name, size_name, size_description, set_names, angle);
    }

    return `/${board_name}/${boardDetails.layout_id}/${boardDetails.size_id}/${boardDetails.set_ids.join(',')}/${angle}/list`;
  }, [boardDetails, angle]);

  return (
    <>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, pb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', pt: 1 }}>
          <BackButton fallbackUrl={backUrl} />
        </Box>
        <ClimbDetailShellClient
          mode="play"
          aboveFold={(
            <PlayClimbAboveFold
              climb={climb}
              boardDetails={boardDetails}
              angle={angle}
              onOpenTick={() => setTickOpen(true)}
              showPrevNextButtons={false}
            />
          )}
          sections={sections}
        />
      </Box>
      <LogAscentDrawer
        open={tickOpen}
        onClose={() => setTickOpen(false)}
        currentClimb={climb}
        boardDetails={boardDetails}
      />
    </>
  );
}
