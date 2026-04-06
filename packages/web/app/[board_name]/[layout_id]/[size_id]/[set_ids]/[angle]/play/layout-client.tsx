'use client';

import React from 'react';
import { PropsWithChildren } from 'react';
import Badge from '@mui/material/Badge';
import MuiButton from '@mui/material/Button';
import Box from '@mui/material/Box';
import { DeleteOutlined } from '@mui/icons-material';
import { track } from '@vercel/analytics';
import { BoardDetails } from '@/app/lib/types';

import QueueList from '@/app/components/queue-control/queue-list';
import { useQueueActions, useQueueList } from '@/app/components/graphql-queue';
import { ConfirmPopover } from '@/app/components/ui/confirm-popover';
import styles from './layout-client.module.css';


interface PlayLayoutClientProps {
  boardDetails: BoardDetails;
}

const QueueSidebar: React.FC<{ boardDetails: BoardDetails }> = ({ boardDetails }) => {
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
            Queue
          </Badge>
        </h3>
        {queue.length > 0 && (
          <ConfirmPopover
            title="Clear queue"
            description="Are you sure you want to clear all items from the queue?"
            onConfirm={handleClearQueue}
            okText="Clear"
            cancelText="Cancel"
          >
            <MuiButton variant="text" startIcon={<DeleteOutlined />} size="small" sx={{ color: 'var(--neutral-400)' }}>
              Clear
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
      <Box component="main" className={styles.mainContent}>{children}</Box>
      <Box component="aside" className={styles.sider} sx={{ width: 400 }}>
        <QueueSidebar boardDetails={boardDetails} />
      </Box>
    </Box>
  );
};

export default PlayLayoutClient;
