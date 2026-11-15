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

/** A per-call capture is synchronous and belongs to one admitted local intent. */
type CapturedPlaylistActivation = Readonly<{
  options: UsePlaylistClimbActivationOptions;
  signal: AbortSignal;
  assertCurrent: () => void;
  decorateSource: (source: PlaylistSuggestionSource | null) => PlaylistSuggestionSource | null;
  publishRefresh: (source: PlaylistSuggestionSource, expected: PlaylistSuggestionSource) => Promise<boolean>;
  isHeld: (error: unknown) => boolean;
}>;

/** The ordinary path retains its unmount cancellation. A captured handoff has
 * its own lifetime and never recaptures options after the local dispatch. */
export function usePlaylistClimbActivation(
  options: UsePlaylistClimbActivationOptions,
): (climb: Climb, captureInvocation?: () => CapturedPlaylistActivation) => Promise<void> {
  const refreshAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => refreshAbortRef.current?.abort(), []);
  const {
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
  } = options;

  return useCallback(
    async (climb: Climb, captureInvocation?: () => CapturedPlaylistActivation): Promise<void> => {
      // This factory runs before target resolution or any external callback.
      const captured = captureInvocation?.();
      const invocation = captured?.options ?? {
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
      };
      const assertCurrent = () => {
        if (captured?.signal.aborted)
          throw captured.signal.reason ?? Object.assign(new Error('Cancelled'), { name: 'AbortError' });
        captured?.assertCurrent();
      };
      assertCurrent();
      if (!invocation.queueApi) return;
      const target = invocation.resolveTarget(climb);
      assertCurrent();
      if (!target) {
        assertCurrent();
        const activated = await invocation.queueApi.setCurrentClimb(climb, { playlistSuggestionSource: null });
        assertCurrent();
        if (activated) invocation.onActivated?.(climb);
        assertCurrent();
        return;
      }

      let settleRefresh: (refreshed: boolean) => void = () => {};
      const refreshSettled = new Promise<boolean>((resolve) => {
        settleRefresh = resolve;
      });
      let initialSource: PlaylistSuggestionSource | null;
      try {
        const continuation = invocation.pendingContinuation?.(refreshSettled);
        assertCurrent();
        initialSource = createPlaylistSuggestionSource({
          playlistUuid: invocation.sourceId,
          activatedClimb: climb,
          climbs: invocation.allClimbs,
          boardKey: target.boardKey,
          isClimbable: target.isClimbable,
          preparedClimbs: invocation.preparedClimbs,
          label: invocation.label,
          continuation,
        });
        assertCurrent();
        if (captured) initialSource = captured.decorateSource(initialSource);
        assertCurrent();
        const activeItem = await invocation.queueApi.setCurrentClimb(climb, {
          playlistSuggestionSource: initialSource,
        });
        assertCurrent();
        if (!activeItem) {
          settleRefresh(false);
          return;
        }
        invocation.onActivated?.(climb);
        assertCurrent();
      } catch (error: unknown) {
        settleRefresh(false);
        throw error;
      }

      const abortController = captured ? null : new AbortController();
      if (abortController) {
        refreshAbortRef.current?.abort();
        refreshAbortRef.current = abortController;
      }
      const signal = captured?.signal ?? abortController!.signal;
      // Keep this exact initial object across the asynchronous phase.
      const expectedSource = initialSource;
      void (async () => {
        let refreshed = false;
        try {
          assertCurrent();
          const trackLoad = await invocation.fetchClimbsForBoard({
            target,
            activatedClimbUuid: climb.uuid,
            signal,
          });
          if (signal.aborted) return;
          assertCurrent();
          let refreshedSource: PlaylistSuggestionSource | null = createPlaylistSuggestionSource({
            playlistUuid: invocation.sourceId,
            activatedClimb: climb,
            climbs: trackLoad.climbs,
            boardKey: target.boardKey,
            isClimbable: target.isClimbable,
            label: invocation.label,
            total: trackLoad.total,
            continuation: trackLoad.continuation,
          });
          assertCurrent();
          if (captured) refreshedSource = captured.decorateSource(refreshedSource);
          assertCurrent();
          if (refreshedSource) {
            refreshed = captured
              ? !!expectedSource && (await captured.publishRefresh(refreshedSource, expectedSource))
              : invocation.queueApi!.refreshPlaylistSuggestionSource(refreshedSource);
          }
          assertCurrent();
        } catch (error: unknown) {
          if (isAbortError(error) || captured?.isHeld(error)) return;
          // Recheck at the actual diagnostic sink after arbitrary callbacks.
          try {
            assertCurrent();
          } catch {
            return;
          }
          console.error(invocation.refreshErrorMessage, error);
        } finally {
          settleRefresh(refreshed);
          if (abortController && refreshAbortRef.current === abortController) refreshAbortRef.current = null;
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
