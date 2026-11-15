import { memo } from 'react';
import { useClimbRowDisplay } from '../../lib/climb-row-display-preference';
import { useQueueSessionId } from '../../providers/queue-provider';
import { usePartyProfile } from '../../providers/party-profile-provider';
import { useAuth } from '../../providers/auth-provider';
import { useBoardContinuationFeed } from '../../providers/queue/use-board-continuation-feed';
import { QueueItemRow } from '../QueueItemRow';
import { ClimbListItemContent } from '../ClimbListItemContent';
import { QueueListView, type QueueListProps } from './QueueListView';
export const QueueList = memo(function QueueList(props: QueueListProps) {
  const rowDisplay = useClimbRowDisplay();
  const { sessionId } = useQueueSessionId();
  const { authenticatedUserId, isAuthenticated } = usePartyProfile();
  const { isLoading: isAuthLoading } = useAuth();
  const { climbs } = useBoardContinuationFeed(props.board, props.active);
  return (
    <QueueListView
      {...props}
      rowDisplay={rowDisplay}
      showAddedBy={sessionId != null && !isAuthLoading && (!isAuthenticated || !!authenticatedUserId)}
      viewerUserId={isAuthenticated ? authenticatedUserId : null}
      boardContinuationClimbs={climbs}
      RowComponent={QueueItemRow}
      ContentComponent={ClimbListItemContent}
    />
  );
});
