import React, { Suspense } from 'react';
import ClimbViewActions from '@/app/components/climb-view/climb-view-actions';
import ClimbDetailInfoShellClient from '@/app/components/climb-detail/climb-detail-info-shell.client';
import { constructClimbInfoUrl } from '@/app/lib/url-utils';
import type { BoardDetails, Climb } from '@/app/lib/types';
import styles from '@/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/view/[climb_uuid]/climb-view.module.css';

type ClimbDetailPageServerProps = {
  climb: Climb;
  boardDetails: BoardDetails;
  climbUuid: string;
  boardType: string;
  angle: number;
  currentClimbDifficulty?: string;
  boardName?: string;
};

export default function ClimbDetailPageServer({
  climb,
  boardDetails,
  climbUuid,
  boardType,
  angle,
  currentClimbDifficulty,
  boardName,
}: ClimbDetailPageServerProps) {
  const auroraAppUrl = constructClimbInfoUrl(boardDetails, climb.uuid) ?? undefined;

  return (
    <div className={styles.pageContainer}>
      <div className={styles.actionsSection}>
        <Suspense>
          <ClimbViewActions climb={climb} boardDetails={boardDetails} auroraAppUrl={auroraAppUrl} angle={angle} />
        </Suspense>
      </div>

      <div className={styles.contentWrapper}>
        <div className={styles.climbSection}>
          <ClimbDetailInfoShellClient
            climb={climb}
            boardDetails={boardDetails}
            climbUuid={climbUuid}
            boardType={boardType}
            angle={angle}
            currentClimbDifficulty={currentClimbDifficulty}
            boardName={boardName}
          />
        </div>
      </div>
    </div>
  );
}
