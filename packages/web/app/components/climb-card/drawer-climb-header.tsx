import React from 'react';
import { usePathname } from 'next/navigation';
import { Climb, BoardDetails } from '@/app/lib/types';
import { themeTokens } from '@/app/theme/theme-config';
import ClimbThumbnail from './climb-thumbnail';
import ClimbTitle from './climb-title';
import styles from './climb-list-item.module.css';

type DrawerClimbHeaderProps = {
  climb: Climb;
  boardDetails: BoardDetails;
};

export default function DrawerClimbHeader({ climb, boardDetails }: DrawerClimbHeaderProps) {
  const pathname = usePathname();

  return (
    <div className={styles.drawerHeader}>
      <div style={{ flexShrink: 0, width: 56 }}>
        <ClimbThumbnail boardDetails={boardDetails} currentClimb={climb} pathname={pathname} maxHeight="80px" />
      </div>
      <ClimbTitle climb={climb} gradePosition="right" titleFontSize={themeTokens.typography.fontSize.xl} showSetterInfo />
    </div>
  );
}
