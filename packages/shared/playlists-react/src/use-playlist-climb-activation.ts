import { useCallback, useEffect, useRef } from 'react';
import {
  createPlaylistSuggestionSource,
  type Climb,
  type ClimbQueueItem,
  type PlaylistSuggestionSource,
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
  refreshPlaylistSuggestionSource: (source: PlaylistSuggestionSource) => void;
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
  /** Fetch the full ordered climb list for the target board, for the refreshed
   *  suggestion source. */
  fetchClimbsForBoard: (args: FetchActivationClimbsArgs) => Promise<Climb[]>;
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

      const initialSource = createPlaylistSuggestionSource({
        playlistUuid: sourceId,
        activatedClimb: climb,
        climbs: allClimbs,
        boardKey: target.boardKey,
        isClimbable: target.isClimbable,
        preparedClimbs,
      });

      const activeItem = await queueApi.setCurrentClimb(climb, { playlistSuggestionSource: initialSource });
      if (!activeItem) return;
      // Match the non-playlist browse-tap path so a playlist row tap surfaces
      // the play drawer rather than silently mutating state.
      onActivated?.(climb);

      refreshAbortRef.current?.abort();
      const abortController = new AbortController();
      refreshAbortRef.current = abortController;

      void (async () => {
        try {
          const fetchedClimbs = await fetchClimbsForBoard({
            target,
            activatedClimbUuid: climb.uuid,
            signal: abortController.signal,
          });
          if (abortController.signal.aborted) return;
          const refreshedSource = createPlaylistSuggestionSource({
            playlistUuid: sourceId,
            activatedClimb: climb,
            climbs: fetchedClimbs,
            boardKey: target.boardKey,
            isClimbable: target.isClimbable,
          });
          queueApi.refreshPlaylistSuggestionSource(refreshedSource);
        } catch (err: unknown) {
          if (isAbortError(err)) return;
          console.error(refreshErrorMessage, err);
        } finally {
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
      onActivated,
      refreshErrorMessage,
    ],
  );
}
