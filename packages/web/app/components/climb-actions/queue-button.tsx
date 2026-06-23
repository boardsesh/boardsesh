'use client';

// TODO(queue-bar-pivot): exported but not rendered on any route — the
// `queueButton` source on the `Add to Queue` analytics event has produced
// zero hits in 3 months because nothing mounts this component. Either delete
// alongside the other follow-up cleanups or re-mount intentionally as a
// third entry point for "Add to Up next". See
// docs/queue-control-bar-pivot.md ("What shipped vs spec" appendix).
import React, { useState, useCallback } from 'react';
import AddCircleOutlined from '@mui/icons-material/AddCircleOutlined';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import MuiTooltip from '@mui/material/Tooltip';
import { track } from '@/app/lib/analytics';
import { useQueueActions, useQueueList } from '../graphql-queue';
import type { Climb, BoardDetails } from '@/app/lib/types';

type QueueButtonProps = {
  climb: Climb;
  boardDetails: BoardDetails;
  showLabel?: boolean;
  size?: 'small' | 'default';
  className?: string;
};

export default function QueueButton({
  climb,
  boardDetails,
  showLabel = false,
  size = 'default',
  className,
}: QueueButtonProps) {
  const { addToQueue } = useQueueActions();
  const { queue } = useQueueList();
  const [recentlyAdded, setRecentlyAdded] = useState(false);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();

      if (addToQueue && !recentlyAdded) {
        addToQueue(climb, 'search');

        track('Add to Queue', {
          source: 'queueButton',
          boardLayout: boardDetails.layout_name || '',
          queueLength: queue.length + 1,
        });

        setRecentlyAdded(true);

        setTimeout(() => {
          setRecentlyAdded(false);
        }, 5000);
      }
    },
    [addToQueue, recentlyAdded, climb, boardDetails.layout_name, queue.length],
  );

  const iconStyle: React.CSSProperties = {
    fontSize: size === 'small' ? 14 : 16,
    color: recentlyAdded ? 'var(--color-success)' : 'inherit',
    cursor: recentlyAdded ? 'not-allowed' : 'pointer',
  };

  const Icon = recentlyAdded ? CheckCircleOutlined : AddCircleOutlined;
  const label = recentlyAdded ? 'Added' : 'Queue';

  return (
    <MuiTooltip title={recentlyAdded ? 'Added to queue' : 'Add to queue'}>
      <span
        onClick={handleClick}
        className={className}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          cursor: recentlyAdded ? 'not-allowed' : 'pointer',
        }}
        role="button"
        aria-label={recentlyAdded ? 'Added to queue' : 'Add to queue'}
      >
        <Icon style={iconStyle} />
        {showLabel && <span style={{ marginLeft: 8 }}>{label}</span>}
      </span>
    </MuiTooltip>
  );
}
