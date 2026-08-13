'use client';

import React from 'react';
import CircularProgress from '@mui/material/CircularProgress';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/app/components/ui/empty-state';
import BoardImportPrompt from '@/app/components/board-entity/board-import-prompt';
import { AURORA_BOARDS, type AuroraBoardName } from '@boardsesh/shared-schema';
import type { LogbookEntry } from '../utils/profile-constants';
import styles from '../profile-page.module.css';

type BoardStatsSectionProps = {
  selectedBoard: string;
  loading: boolean;
  filteredLogbook: LogbookEntry[];
  isOwnProfile: boolean;
};

export default function BoardStatsSection({
  selectedBoard,
  loading,
  filteredLogbook,
  isOwnProfile,
}: BoardStatsSectionProps) {
  const { t } = useTranslation('profile');
  if (loading) {
    return (
      <div className={styles.loadingStats}>
        <CircularProgress />
      </div>
    );
  }

  if (filteredLogbook.length > 0) {
    return null;
  }

  if (isOwnProfile && selectedBoard !== 'all' && AURORA_BOARDS.includes(selectedBoard as AuroraBoardName)) {
    return <BoardImportPrompt boardType={selectedBoard as AuroraBoardName} />;
  }

  return <EmptyState description={t('empty.noClimbingData')} />;
}
