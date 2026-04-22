'use client';

import React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import type { Climb, BoardDetails } from '@/app/lib/types';
import styles from './climb-view-actions.module.css';
import { constructClimbListWithSlugs } from '@/app/lib/url-utils';
import BackButton from '../back-button';
import { ClimbActions } from '../climb-actions';

type ClimbViewActionsProps = {
  climb: Climb;
  boardDetails: BoardDetails;
  auroraAppUrl?: string;
  angle: number;
};

const ClimbViewActions = ({ climb, boardDetails, auroraAppUrl, angle }: ClimbViewActionsProps) => {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const getBackToListUrl = () => {
    const { board_name, layout_name, size_name, size_description, set_names } = boardDetails;

    // If a returnUrl was embedded in the URL when navigating here, use it.
    // Validate it is a relative same-origin path to prevent open-redirect.
    const returnUrl = searchParams.get('returnUrl');
    if (returnUrl && returnUrl.startsWith('/')) {
      return returnUrl;
    }

    // Use slug-based URL construction if slug names are available
    if (layout_name && size_name && set_names) {
      return constructClimbListWithSlugs(board_name, layout_name, size_name, size_description, set_names, angle);
    }

    // Fallback to numeric format
    return `/${board_name}/${boardDetails.layout_id}/${boardDetails.size_id}/${boardDetails.set_ids.join(',')}/${angle}/list`;
  };

  return (
    <div className={styles.container}>
      {/* Mobile view: Show back button + key actions + overflow menu */}
      <div className={styles.mobileActions}>
        <div className={styles.mobileLeft}>
          <BackButton fallbackUrl={getBackToListUrl()} />
        </div>

        <div className={styles.mobileRight}>
          <ClimbActions
            climb={climb}
            boardDetails={boardDetails}
            angle={angle}
            currentPathname={pathname}
            viewMode="button"
            include={['favorite', 'queue']}
            size="default"
            auroraAppUrl={auroraAppUrl}
          />
          <ClimbActions
            climb={climb}
            boardDetails={boardDetails}
            angle={angle}
            currentPathname={pathname}
            viewMode="dropdown"
            include={['instagram', 'tick', 'share', 'openInApp']}
            auroraAppUrl={auroraAppUrl}
          />
        </div>
      </div>

      {/* Desktop view: Show all buttons */}
      <div className={styles.desktopActions}>
        <BackButton fallbackUrl={getBackToListUrl()} className={styles.backButton} />

        <div className={styles.actionButtons}>
          <ClimbActions
            climb={climb}
            boardDetails={boardDetails}
            angle={angle}
            currentPathname={pathname}
            viewMode="button"
            include={['favorite', 'instagram', 'tick', 'queue', 'share', 'openInApp']}
            auroraAppUrl={auroraAppUrl}
          />
        </div>
      </div>
    </div>
  );
};

export default ClimbViewActions;
