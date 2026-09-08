import { useEffect } from 'react';
import { prefetchClimbStatsForClimbs, useBoardAdapter } from '@boardsesh/board-react';
import type { BoardName } from '@boardsesh/shared-schema';

/**
 * Screenshot mode only: read canonical climb stats for the WHOLE loaded list in
 * one go, instead of leaving it to the per-row batcher.
 *
 * `useEffectiveClimbStats` queues one read per mounted row and the coordinator
 * flushes whatever queued by the end of the microtask, so a
 * `ClimbStatsForClimbs` batch's id list is "the rows FlashList had mounted just
 * then". A replay backend answers instantly, so the list mounts further than it
 * did while recording against a live backend, and the batch asks for climbs no
 * recorded batch ever covered — three kilter and eight tension ids on Android
 * run 34248313427, all of them rows further down a `SearchClimbs` page whose
 * content is byte-identical to the recording's.
 *
 * Membership is therefore timing-dependent at the source, and the replay
 * composer (`BATCHED_OPERATIONS` in `scripts/lib/screenshot-fixtures.ts`) can
 * only re-assemble ids that were recorded SOMEWHERE. Asking for the whole
 * loaded page makes the recorded set cover every id the capture can ask for,
 * whatever the draw distance does — and with the page cap
 * (`screenshotModeNextPageParam`) pinning the list to page one, "the whole
 * loaded page" is itself the same set every run. The composer stays as the
 * safety net for the per-row sub-batches that still fire.
 *
 * A no-op in every normal build: the inline `process.env` comparison folds to
 * `false` and the branch dead-strips (see `lib/screenshot-mode.ts`).
 */
export function useScreenshotClimbStatsPrefetch({
  boardName,
  layoutId,
  angle,
  climbUuids,
}: {
  boardName: string;
  layoutId: number;
  angle: number;
  climbUuids: readonly string[];
}): void {
  const adapter = useBoardAdapter();
  // The effect keys on the SET of ids, not the array's identity: the caller
  // rebuilds the list on every page/filter change, and re-prefetching an
  // unchanged list would just re-enter the coordinator's read cooldown.
  const climbUuidKey = climbUuids.join(',');

  useEffect(() => {
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1') return;
    if (!boardName || climbUuidKey.length === 0) return;
    void prefetchClimbStatsForClimbs(
      adapter,
      { boardType: boardName as BoardName, layoutId, angle },
      climbUuidKey.split(','),
    );
  }, [adapter, boardName, layoutId, angle, climbUuidKey]);
}
