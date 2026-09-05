import { useEffect, useRef } from 'react';
import { isPlaylistPeekQueueItemUuid } from '@boardsesh/queue';
import type { ClimbQueueItem, ClimbRegradePatch, PlaylistSuggestionSource, QueueAction } from '@boardsesh/queue';
import { findNextQueueItemWithSuggestions, findPreviousQueueItemWithSuggestions } from '@boardsesh/play-view';
import type { UserBoard } from '@boardsesh/shared-schema';
import { offlineAwareRequest } from '../../lib/graphql/offline-request';
import { GET_CLIMB, type GetClimbQueryResponse } from '../../lib/graphql/operations';

type UseQueueRegradeParams = {
  /** The active board (angle source of truth). Undefined until the React Query cache hydrates. */
  activeBoard: UserBoard | null | undefined;
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  /** Read inside the effect for the displayed playlist peek — the effect deliberately reads the ref, not the raw value. */
  playlistSuggestionSourceRef: React.RefObject<PlaylistSuggestionSource | null>;
  /**
   * The raw value is ONLY here because it stays in the effect's dependency array
   * (even though the body reads the ref) — preserved verbatim from the original.
   */
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  dispatch: React.Dispatch<QueueAction>;
  setPlaylistSuggestionSourceState: React.Dispatch<React.SetStateAction<PlaylistSuggestionSource | null>>;
};

/**
 * Self-healing re-grade: a climb's difficulty/quality/sends are angle-specific
 * (stored per-angle server-side), but queue items carry the grade baked in for
 * the angle they were fetched at. Whenever the active angle differs from a
 * queued climb's display angle — the user changed the angle, or a server
 * FullSync re-staled the queue at the old angle — refetch that climb at the
 * live angle and patch it in. Local only: each client follows the angle and
 * re-grades its own queue, so nothing is sent to peers. Idempotent — after
 * patching, climb.angle === angle, so the effect no-ops on its own re-run.
 */
export function useQueueRegrade({
  activeBoard,
  queue,
  currentClimbQueueItem,
  playlistSuggestionSourceRef,
  playlistSuggestionSource,
  dispatch,
  setPlaylistSuggestionSourceState,
}: UseQueueRegradeParams): void {
  // Maps a climb uuid → the angle a re-grade fetch is currently in flight for.
  // Keyed by angle (not a plain Set) so a fetch already running for a STALE
  // angle doesn't block a fresh fetch when the angle changes again mid-flight —
  // otherwise that climb could strand at the old grade.
  const regradeInFlightRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!activeBoard) return undefined;
    const { boardType, layoutId, sizeId, setIds, angle } = activeBoard;
    const uuids = new Set<string>();
    const consider = (item: ClimbQueueItem | null | undefined) => {
      if (!item?.climb) return;
      // Re-grade when the display angle differs AND we aren't already fetching
      // this climb for the CURRENT angle (a fetch for a prior angle re-enqueues).
      if (item.climb.angle !== angle && regradeInFlightRef.current.get(item.climb.uuid) !== angle) {
        uuids.add(item.climb.uuid);
      }
    };
    // Only the current climb + upcoming items follow the live angle. History
    // items (everything before the current climb — the same split
    // buildQueueListModel uses) keep the grade for the angle they were CLIMBED
    // at, so we skip fetching for them. REGRADE_CLIMBS also guards this, but
    // skipping the fetch here avoids wasted GET_CLIMB round-trips for the past.
    const currentIndex = currentClimbQueueItem
      ? queue.findIndex((item) => item.uuid === currentClimbQueueItem.uuid)
      : -1;
    queue.forEach((item, index) => {
      if (index < currentIndex) return;
      consider(item);
    });
    consider(currentClimbQueueItem);
    // Also re-grade the displayed playlist peeks (the next-up suggestion shown
    // at the queue tail, and — since swipes went list-first (#4829) — the
    // previous-in-list climb a back swipe can land on). They live in
    // playlistSuggestionSource.climbs — NOT in state.queue — so the queue-only
    // pass above never touches them, and the bar/drawer would keep showing the
    // activation-angle grade until the peek is committed. Only those two are
    // ever displayed, so re-grade them alone; re-grading the whole source could
    // be hundreds of climbs.
    const nextPeek = findNextQueueItemWithSuggestions(
      queue,
      currentClimbQueueItem,
      playlistSuggestionSourceRef.current,
    );
    if (nextPeek && isPlaylistPeekQueueItemUuid(nextPeek.uuid)) consider(nextPeek);
    const prevPeek = findPreviousQueueItemWithSuggestions(
      queue,
      currentClimbQueueItem,
      playlistSuggestionSourceRef.current,
    );
    if (prevPeek && isPlaylistPeekQueueItemUuid(prevPeek.uuid)) consider(prevPeek);
    if (uuids.size === 0) return undefined;

    const targetUuids = [...uuids];
    targetUuids.forEach((uuid) => regradeInFlightRef.current.set(uuid, angle));

    let cancelled = false;
    void (async () => {
      const patches = await Promise.all(
        targetUuids.map(async (climbUuid) => {
          try {
            const response = await offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, {
              boardName: boardType,
              layoutId,
              sizeId,
              setIds,
              angle,
              climbUuid,
            });
            const climb = response.climb;
            if (!climb) return null;
            const patch: ClimbRegradePatch = {
              angle,
              difficulty: climb.difficulty,
              quality_average: climb.quality_average,
              ascensionist_count: climb.ascensionist_count,
              benchmark_difficulty: climb.benchmark_difficulty ?? null,
              difficulty_error: climb.difficulty_error,
              // Explicit nulls so an angle with no boardsesh grade row clears
              // the stale value from the climb's previous angle.
              boardseshDifficulty: climb.boardseshDifficulty ?? null,
              boardseshConfidence: climb.boardseshConfidence ?? null,
            };
            return [climbUuid, patch] as const;
          } catch {
            return null;
          } finally {
            // Only clear our own marker — a newer run may have re-targeted this
            // uuid to a different angle, and must keep its in-flight claim.
            if (regradeInFlightRef.current.get(climbUuid) === angle) {
              regradeInFlightRef.current.delete(climbUuid);
            }
          }
        }),
      );
      if (cancelled) return;
      const grades: Record<string, ClimbRegradePatch> = {};
      for (const entry of patches) {
        if (entry) grades[entry[0]] = entry[1];
      }
      if (Object.keys(grades).length > 0) {
        dispatch({ type: 'REGRADE_CLIMBS', payload: { grades } });
        // REGRADE_CLIMBS only patches the reducer's queue + current item. The
        // displayed peek lives in the provider-state suggestion source, so patch
        // its climbs here too (same patch map) — otherwise the next-up grade pill
        // keeps the old angle until the peek is committed. Idempotent: skips
        // climbs already at the live angle, and preserves the prev reference when
        // nothing changes so this never churns the source state.
        setPlaylistSuggestionSourceState((prev) => {
          if (!prev) return prev;
          let changed = false;
          const climbs = prev.climbs.map((climb) => {
            const patch = grades[climb.uuid];
            if (!patch || climb.angle === patch.angle) return climb;
            changed = true;
            return { ...climb, ...patch };
          });
          return changed ? { ...prev, climbs } : prev;
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [queue, currentClimbQueueItem, activeBoard, playlistSuggestionSource]);
}
