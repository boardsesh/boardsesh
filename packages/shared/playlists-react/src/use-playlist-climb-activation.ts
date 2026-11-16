import { useCallback, useEffect, useRef } from 'react';
import {
  createPlaylistSuggestionSource,
  type Climb,
  type ClimbQueueItem,
  type PlaylistSuggestionSource,
  type PlaylistTrackContinuation,
  type PreparedPlaylistClimbs,
} from '@boardsesh/queue';
import { isAbortError } from './fetch-playlist-suggestion-climbs';

/**
 * The two queue operations the activation flow drives. Web wires these to its
 * queue actions; mobile wires its queue provider. Decoupled so this package
 * never imports a platform queue context.
 */
export type PlaylistActivationQueueApi = {
  setCurrentClimb: (
    climb: Climb,
    options: { playlistSuggestionSource: PlaylistSuggestionSource | null },
  ) => Promise<ClimbQueueItem | null>;
  /** True when the source replaced the active one; false when it was stale and ignored. */
  refreshPlaylistSuggestionSource: (source: PlaylistSuggestionSource) => boolean;
};

/** The board a playlist activation is bound to, resolved per-climb by the caller. */
export type PlaylistActivationBoardTarget = {
  /** Stable board key (see `getQueueBoardKey`) keying the suggestion source. */
  boardKey: string;
  boardName: string;
  angle: number;
  /** Predicate deciding whether a suggested climb is climbable on this board. */
  isClimbable: (climb: Climb) => boolean;
};

export type FetchActivationClimbsArgs = {
  target: PlaylistActivationBoardTarget;
  activatedClimbUuid: string;
  signal: AbortSignal;
};

/**
 * The first load of the track, from the top of the list. `total` is the list's
 * count when the caller knows it for this exact list; `continuation` is how the
 * player asks for the page after the last one loaded, absent when the list
 * ended inside this load.
 */
export type ActivationTrackLoad = {
  climbs: Climb[];
  total?: number;
  continuation?: PlaylistTrackContinuation;
};

export type UsePlaylistClimbActivationOptions = {
  /** Queue operations. When null/undefined, activation is a no-op. */
  queueApi: PlaylistActivationQueueApi | null | undefined;
  /** Stable id for the playlist this activation belongs to (the suggestion
   *  source's `playlistUuid`). */
  sourceId: string;
  /** All currently-loaded climbs, used to build the initial suggestion source. */
  allClimbs: Climb[];
  /** Prepared against the loaded snapshot and target predicate before taps. */
  preparedClimbs?: PreparedPlaylistClimbs;
  /** Resolve the board a climb activates onto. Return null to fall back to a
   *  plain activation (no suggestion source). */
  resolveTarget: (climb: Climb) => PlaylistActivationBoardTarget | null;
  /** Fetch the ordered climb list for the target board, for the refreshed
   *  suggestion source. */
  fetchClimbsForBoard: (args: FetchActivationClimbsArgs) => Promise<ActivationTrackLoad>;
  /** What the player calls this list ("From {label}"). */
  label?: string;
  /**
   * How the first track, built from the loaded rows, says more of the list is
   * on its way while the refresh runs (issue #6664). Handed a promise that
   * settles when the refresh is done: true when it handed the queue the fuller
   * track, false when it did not (failed, cancelled, or the activation never
   * committed). Omit it and the first track says nothing about what is coming.
   */
  pendingContinuation?: (refreshSettled: Promise<boolean>) => PlaylistTrackContinuation;
  /** Optional post-activation side-effect (e.g. open the play drawer). */
  onActivated?: (climb: Climb) => void;
  /** Message logged when the async suggestion refresh fails (non-abort). */
  refreshErrorMessage: string;
};

/**
 * Two-phase playlist climb activation:
 *  1. Synchronously activate the tapped climb with a suggestion source built
 *     from the currently-loaded climbs, then run `onActivated`.
 *  2. Asynchronously fetch the full ordered board climb list and replace the
 *     suggestion source with the richer one, aborting on unmount or re-tap.
 *
 * When `resolveTarget` returns null, degrade to a plain activation with no
 * suggestion source (still runs `onActivated`).
 */
export function usePlaylistClimbActivation({
  queueApi,
  sourceId,
  allClimbs,
  preparedClimbs,
  resolveTarget,
  fetchClimbsForBoard,
  label,
  pendingContinuation,
  onActivated,
  refreshErrorMessage,
}: UsePlaylistClimbActivationOptions): (climb: Climb) => Promise<void> {
  const refreshAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      refreshAbortRef.current?.abort();
    };
  }, []);

  return useCallback(
    async (climb: Climb): Promise<void> => {
      if (!queueApi) return;

      const target = resolveTarget(climb);

      // Defence-in-depth: incompatible climbs should already be filtered at the
      // tap target, but if a row tap reaches the hook without a resolvable
      // board (e.g. user owns no boards), degrade to a plain activation rather
      // than failing silently. setCurrentClimb still surfaces an error via its
      // validator when the active board can't accept the climb.
      if (!target) {
        const activated = await queueApi.setCurrentClimb(climb, { playlistSuggestionSource: null });
        if (activated) onActivated?.(climb);
        return;
      }

      // Settled exactly once, by whichever way this activation ends.
      let settleRefresh: (refreshed: boolean) => void = () => {};
      const refreshSettled = new Promise<boolean>((resolve) => {
        settleRefresh = resolve;
      });
      const continuation = pendingContinuation?.(refreshSettled);
      const initialSource = createPlaylistSuggestionSource({
        playlistUuid: sourceId,
        activatedClimb: climb,
        climbs: allClimbs,
        boardKey: target.boardKey,
        isClimbable: target.isClimbable,
        preparedClimbs,
        label,
        continuation,
      });

      let activeItem: ClimbQueueItem | null;
      try {
        activeItem = await queueApi.setCurrentClimb(climb, { playlistSuggestionSource: initialSource });
      } catch (error: unknown) {
        settleRefresh(false);
        throw error;
      }
      if (!activeItem) {
        settleRefresh(false);
        return;
      }
      // Match the non-playlist browse-tap path so a playlist row tap surfaces
      // the play drawer rather than silently mutating state.
      onActivated?.(climb);

      refreshAbortRef.current?.abort();
      const abortController = new AbortController();
      refreshAbortRef.current = abortController;

      void (async () => {
        let refreshed = false;
        try {
          const trackLoad = await fetchClimbsForBoard({
            target,
            activatedClimbUuid: climb.uuid,
            signal: abortController.signal,
          });
          if (abortController.signal.aborted) return;
          const refreshedSource = createPlaylistSuggestionSource({
            playlistUuid: sourceId,
            activatedClimb: climb,
            climbs: trackLoad.climbs,
            boardKey: target.boardKey,
            isClimbable: target.isClimbable,
            label,
            total: trackLoad.total,
            continuation: trackLoad.continuation,
          });
          // Settled as refreshed only when the provider took it. A queue-sheet tap
          // can re-anchor the track on another climb meanwhile, keeping this
          // activation's pending continuation; the provider then ignores this
          // refresh, and that surviving track must end where it is rather than
          // wait on a load that will never land on it.
          refreshed = queueApi.refreshPlaylistSuggestionSource(refreshedSource);
        } catch (err: unknown) {
          if (isAbortError(err)) return;
          console.error(refreshErrorMessage, err);
        } finally {
          settleRefresh(refreshed);
          if (refreshAbortRef.current === abortController) {
            refreshAbortRef.current = null;
          }
        }
      })();
    },
    [
      queueApi,
      sourceId,
      allClimbs,
      preparedClimbs,
      resolveTarget,
      fetchClimbsForBoard,
      label,
      pendingContinuation,
      onActivated,
      refreshErrorMessage,
    ],
  );
}
