import { getPrivacyRevocationGeneration } from '../../lib/privacy/privacy-cache';
import { useLayoutEffect } from 'react';
import { historyLine, isPlaylistPeekQueueItemUuid } from '@boardsesh/queue';
import type {
  ClimbQueueItem,
  ClimbRegradePatch,
  PlaylistSuggestionSource,
  QueueAction,
  QueueClimbReadTarget,
} from '@boardsesh/queue';
import { findNextQueueItemWithSuggestions, findPreviousQueueItemWithSuggestions } from '@boardsesh/play-view';
import type { UserBoard } from '@boardsesh/shared-schema';
import { isClimbResolved } from '../../lib/queue-climb-resolution';
import type { QueueClimbReads, QueueClimbReadDemand } from './use-queue-climb-reads';

type UseQueueRegradeParams = {
  privacyRevocationGeneration?: number;
  activeBoard: UserBoard | null | undefined;
  queue: ClimbQueueItem[];
  /** F3 now-slot mode: the line while nothing is current; null in legacy mode. */
  historyCount?: number | null;
  currentClimbQueueItem: ClimbQueueItem | null;
  playlistSuggestionSourceRef: React.RefObject<PlaylistSuggestionSource | null>;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  /** The backing activation may have different ids from the normalized display source. */
  rawPlaylistSuggestionSource?: PlaylistSuggestionSource | null;
  climbReads: QueueClimbReads;
  dispatch: React.Dispatch<QueueAction>;
  setPlaylistSuggestionSourceState: React.Dispatch<React.SetStateAction<PlaylistSuggestionSource | null>>;
};

/** Current/upcoming grades and displayed playlist peeks follow the live angle. */
export function useQueueRegrade({
  privacyRevocationGeneration,
  activeBoard,
  queue,
  historyCount = null,
  currentClimbQueueItem,
  playlistSuggestionSourceRef,
  playlistSuggestionSource,
  rawPlaylistSuggestionSource = playlistSuggestionSource,
  climbReads,
  dispatch,
  setPlaylistSuggestionSourceState,
}: UseQueueRegradeParams): void {
  useLayoutEffect(() => {
    const demands: QueueClimbReadDemand[] = [];
    if (activeBoard) {
      const generation = getPrivacyRevocationGeneration();
      const { boardType, layoutId, sizeId, setIds, angle } = activeBoard;
      const boardKey = `${boardType}:${layoutId}:${sizeId}:${setIds}`;
      const source = playlistSuggestionSourceRef.current;
      const backingSource = rawPlaylistSuggestionSource;
      const patchFor = (climb: Parameters<QueueClimbReadDemand['apply']>[0]): ClimbRegradePatch => ({
        angle,
        difficulty: climb.difficulty,
        quality_average: climb.quality_average,
        ascensionist_count: climb.ascensionist_count,
        benchmark_difficulty: climb.benchmark_difficulty ?? null,
        difficulty_error: climb.difficulty_error,
        boardseshDifficulty: climb.boardseshDifficulty ?? null,
        boardseshConfidence: climb.boardseshConfidence ?? null,
      });
      const consider = (item: ClimbQueueItem | null | undefined, role: QueueClimbReadTarget['role'] | 'playlist') => {
        const climb = item?.climb;
        if (!item || !climb?.uuid || !isClimbResolved(climb) || climb.angle === angle) return;
        if (
          (climb.boardType && climb.boardType !== boardType) ||
          (climb.layoutId != null && climb.layoutId !== layoutId)
        )
          return;
        const target: QueueClimbReadTarget | null =
          role === 'playlist' ? null : { role, uuid: item.uuid, expectedClimb: climb, angle };
        demands.push({
          climbUuid: climb.uuid,
          angle,
          expectedClimb: climb,
          targetKey: JSON.stringify(
            role === 'playlist'
              ? [
                  role,
                  backingSource?.boardKey,
                  backingSource?.playlistUuid,
                  backingSource?.activatedClimbUuid,
                  climb.uuid,
                ]
              : [role, item.uuid],
          ),
          apply: (resolvedClimb) => {
            const patch = patchFor(resolvedClimb);
            if (target) {
              dispatch({
                type: 'REGRADE_CLIMBS',
                payload: { grades: { [climb.uuid]: patch }, targets: [target], boardType, layoutId },
              });
            } else if (backingSource) {
              setPlaylistSuggestionSourceState((previous) => {
                if (
                  generation !== getPrivacyRevocationGeneration() ||
                  !previous ||
                  previous.boardKey !== boardKey ||
                  previous.boardKey !== backingSource.boardKey ||
                  previous.playlistUuid !== backingSource.playlistUuid ||
                  previous.activatedClimbUuid !== backingSource.activatedClimbUuid
                )
                  return previous;
                let changed = false;
                const climbs = previous.climbs.map((currentClimb) => {
                  if (currentClimb !== climb || currentClimb.angle === angle) return currentClimb;
                  changed = true;
                  return { ...currentClimb, ...patch };
                });
                return changed ? { ...previous, climbs } : previous;
              });
            }
          },
        });
      };
      // History keeps its climbed-at angle: everything before the current climb,
      // or before the line while nothing is current (F3 now-slot mode; 0 in
      // legacy mode, so nothing is frozen there, as before).
      const historyEnd = historyLine({ queue, currentClimbQueueItem: currentClimbQueueItem ?? null, historyCount });
      queue.forEach((item, index) => {
        if (index >= historyEnd) consider(item, 'queue');
      });
      consider(currentClimbQueueItem, 'current');
      if (source?.boardKey === boardKey) {
        const nextPeek = findNextQueueItemWithSuggestions(queue, currentClimbQueueItem, source);
        if (nextPeek && isPlaylistPeekQueueItemUuid(nextPeek.uuid)) consider(nextPeek, 'playlist');
        const previousPeek = findPreviousQueueItemWithSuggestions(queue, currentClimbQueueItem, source);
        if (previousPeek && isPlaylistPeekQueueItemUuid(previousPeek.uuid)) consider(previousPeek, 'playlist');
      }
    }
    climbReads.register('regrade', demands);
    return () => climbReads.unregister('regrade');
  }, [
    queue,
    historyCount,
    currentClimbQueueItem,
    activeBoard,
    playlistSuggestionSource,
    rawPlaylistSuggestionSource,
    privacyRevocationGeneration,
    playlistSuggestionSourceRef,
    climbReads,
    dispatch,
    setPlaylistSuggestionSourceState,
  ]);
}
