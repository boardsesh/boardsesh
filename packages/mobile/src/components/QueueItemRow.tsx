import { memo, useMemo, useRef } from 'react';
import { useClimbRowField } from '../lib/climb-row-display-preference';
import { resolveClimbRenderBoard } from '../lib/boards/climb-render-board';
import { useClimbMenu } from './climb-actions/ClimbActionsMenu';
import { ClimbListItemContent } from './ClimbListItemContent';
import { QueueItemRowView, type QueueItemRowProps } from './QueueItemRowView';
export { POSITION_SLOT_WIDTH, QUEUE_ROW_LEADING_INSET } from './QueueItemRowView';
export type { QueueItemRowBoard, QueueItemRowProps } from './QueueItemRowView';
export const QueueItemRow = memo(function QueueItemRow(props: QueueItemRowProps) {
  const { item, board, isEditMode, onOpenActions } = props;
  const hasThumbnail = useClimbRowField('thumbnail');
  const itemRef = useRef(item);
  itemRef.current = item;
  const rowClimb = item.climb;
  const rowBoard = useMemo(() => resolveClimbRenderBoard(rowClimb, board)?.boardConfig ?? board, [rowClimb, board]);
  const menuTarget = useMemo(() => {
    const resolved = isEditMode ? null : (onOpenActions?.(itemRef.current) ?? null);
    return resolved ? { ...resolved, boardConfig: rowBoard } : null;
  }, [isEditMode, onOpenActions, item.uuid, rowClimb, rowBoard]);
  const menu = useClimbMenu(menuTarget);
  return (
    <QueueItemRowView {...props} menu={menu} hasThumbnail={hasThumbnail} ContentComponent={ClimbListItemContent} />
  );
});
