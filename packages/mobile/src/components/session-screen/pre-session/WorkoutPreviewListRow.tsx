import type { ClimbQueueItem } from '@boardsesh/queue';
import type { QueueItemRowBoard } from '../../QueueItemRow';
import { WorkoutPreviewRow } from './WorkoutPreviewRow';
import { WorkoutPreviewSectionHeading } from './WorkoutPreviewSectionHeading';
import { WorkoutPreviewStageHeading } from './WorkoutPreviewStageHeading';
import type { PreviewListRow } from './workout-preview-sections';

type WorkoutPreviewListRowProps = {
  row: PreviewListRow;
  /** Null until the board resolves: headings still render, climbs wait for it. */
  board: QueueItemRowBoard | null;
  /** The climb open in the play drawer, highlighted. Null when none is. */
  activeUuid: string | null;
  refreshingUuids: ReadonlySet<string>;
  /** Hold every row's refresh, e.g. while the list is being queued. */
  refreshLocked?: boolean;
  /** Left out where the play drawer can't open (the add-block sheet). */
  onPress?: (item: ClimbQueueItem) => void;
  onRefresh: (uuid: string) => void;
};

/**
 * One row of a workout preview list (`buildPreviewListRows`): a stage heading, a
 * section heading or a climb. Shared by the pre-session preview and the
 * mid-session "Add a block" sheet, so both read the same.
 */
export function WorkoutPreviewListRow({
  row,
  board,
  activeUuid,
  refreshingUuids,
  refreshLocked = false,
  onPress,
  onRefresh,
}: WorkoutPreviewListRowProps) {
  if (row.kind === 'stage') {
    return (
      <WorkoutPreviewStageHeading
        stageKind={row.stageKind}
        count={row.count}
        isCoolDown={row.isCoolDown}
        rounds={row.rounds}
      />
    );
  }
  if (row.kind === 'section') return <WorkoutPreviewSectionHeading section={row.section} count={row.count} />;
  if (!board) return null;
  const { item, knownStatus = null } = row.preview;
  const isRefreshing = refreshingUuids.has(item.uuid);
  return (
    <WorkoutPreviewRow
      item={item}
      board={board}
      isActive={item.uuid === activeUuid}
      isRefreshing={isRefreshing}
      // Refreshes run one at a time, so another row's refresh blocks this one.
      refreshDisabled={refreshLocked || (refreshingUuids.size > 0 && !isRefreshing)}
      knownStatus={knownStatus}
      onPress={onPress}
      onRefresh={onRefresh}
    />
  );
}
