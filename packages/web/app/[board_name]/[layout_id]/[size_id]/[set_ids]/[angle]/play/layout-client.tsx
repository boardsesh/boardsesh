'use client';

import React, { type PropsWithChildren } from 'react';
import Badge from '@mui/material/Badge';
import MuiButton from '@mui/material/Button';
import Box from '@mui/material/Box';
import { DeleteOutlined } from '@mui/icons-material';
import { track } from '@/app/lib/analytics';
import { useTranslation } from 'react-i18next';
import type { BoardDetails } from '@/app/lib/types';

import QueueList from '@/app/components/queue-control/queue-list';
import { useQueueActions, useQueueList } from '@/app/components/graphql-queue';
import { ConfirmPopover } from '@/app/components/ui/confirm-popover';
import styles from './layout-client.module.css';

type PlayLayoutClientProps = {
  boardDetails: BoardDetails;
};

const QueueSidebar: React.FC<{ boardDetails: BoardDetails }> = ({ boardDetails }) => {
  const { t } = useTranslation('session');
  const { queue } = useQueueList();
  const { setQueue } = useQueueActions();

  const handleClearQueue = () => {
    setQueue([]);
    track('Queue Cleared', {
      boardLayout: boardDetails.layout_name || '',
      itemsCleared: queue.length,
    });
  };

  return (
    <div className={styles.sidebarContent}>
      <div className={styles.sidebarHeader}>
        <h3 className={styles.sidebarTitle}>
          <Badge
            badgeContent={queue.length}
            max={99}
            invisible={queue.length === 0}
            color="primary"
            sx={{ '& .MuiBadge-badge': { right: -8, top: 0 } }}
          >
            {t('queueDrawer.title')}
          </Badge>
        </h3>
        {queue.length > 0 && (
          <ConfirmPopover
            title={t('queueDrawer.clearTitle')}
            description={t('queueDrawer.clearDescription')}
            onConfirm={handleClearQueue}
            okText={t('queueDrawer.clearConfirm')}
            cancelText={t('common:actions.cancel')}
          >
            <MuiButton variant="text" startIcon={<DeleteOutlined />} size="small" sx={{ color: 'var(--neutral-400)' }}>
              {t('queueDrawer.clear')}
            </MuiButton>
          </ConfirmPopover>
        )}
      </div>
      <div className={styles.queueListWrapper}>
        <QueueList boardDetails={boardDetails} />
      </div>
    </div>
  );
};

const PlayLayoutClient: React.FC<PropsWithChildren<PlayLayoutClientProps>> = ({ boardDetails, children }) => {
  return (
    <Box className={styles.playLayout}>
      <Box component="main" className={styles.mainContent}>
        {children}
      </Box>
      <Box component="aside" className={styles.sider} sx={{ width: 400 }}>
        <QueueSidebar boardDetails={boardDetails} />
      </Box>
    </Box>
  );
};

export default PlayLayoutClient;
