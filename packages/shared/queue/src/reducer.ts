/**
 * Pure queue state reducer. No React, no DOM — works in any JS runtime.
 * The React `useReducer` wrapper lives in the web app.
 */

import type {
  QueueState,
  QueueAction,
  QueueSearchParams,
  ClimbQueue,
  ClimbQueueItem,
  Climb,
  QueueClimbReadTarget,
  UnconfirmedQueueMove,
} from './types';
import { insertQueueItemIdempotent } from './event-utils';
import { playlistSuggestionSourceMatches, pruneSuggestedQueueItemsAfterCurrent } from './playlist-suggestions';

function hasCurrentClimbQueueItem(payload: { currentClimbQueueItem?: ClimbQueueItem | null }): boolean {
  return Object.prototype.hasOwnProperty.call(payload, 'currentClimbQueueItem');
}

function climbMatchesReadScope(climb: Climb, boardType?: string, layoutId?: number): boolean {
  return (
    (boardType === undefined || !climb.boardType || climb.boardType === boardType) &&
    (layoutId === undefined || climb.layoutId == null || climb.layoutId === layoutId)
  );
}

function isReadTargetCurrent(item: ClimbQueueItem, target: QueueClimbReadTarget | undefined, angle: number): boolean {
  return !!target && target.expectedClimb === item.climb && target.angle === angle;
}

/**
 * Bound on `UnconfirmedQueueMove.movedOff`: a chain of moves the session never
 * confirms. Past it the record is marked `movedOffTruncated` and protects nothing.
 */
const MAX_UNCONFIRMED_MOVED_OFF = 20;

/**
 * The record describes the move the wall is on. Once the current climb is
 * anything else (a peer's move, a local move that is not sent, a removal) it no
 * longer does, so a later snapshot must not bring it back.
 */
function retireStaleUnconfirmedMove<TSearchParams extends QueueSearchParams>(
  state: QueueState<TSearchParams>,
): QueueState<TSearchParams> {
  const move = state.unconfirmedMove;
  if (!move || state.currentClimbQueueItem?.uuid === move.itemUuid) return state;
  return { ...state, unconfirmedMove: null };
}

/**
 * Re-apply an unconfirmed move on top of a snapshot that predates it, the same
 * way the local DELTA_UPDATE_CURRENT_CLIMB applied it: a climb the move added
 * goes back in right after the snapshot's current climb, which is where the
 * server inserts it when the move lands (#2217).
 */
function replayUnconfirmedMove(
  queue: ClimbQueue,
  snapshotCurrentUuid: string | null,
  move: UnconfirmedQueueMove,
  item: ClimbQueueItem,
): ClimbQueue {
  if (!move.shouldAddToQueue || queue.some((queueItem) => queueItem.uuid === item.uuid)) return queue;
  const anchorIndex =
    move.insertAfterCurrent && snapshotCurrentUuid !== null
      ? queue.findIndex((queueItem) => queueItem.uuid === snapshotCurrentUuid)
      : -1;
  if (anchorIndex === -1) return [...queue, item];
  return [...queue.slice(0, anchorIndex + 1), item, ...queue.slice(anchorIndex + 1)];
}

export const initialState = <TSearchParams extends QueueSearchParams>(
  initialSearchParams: TSearchParams,
): QueueState<TSearchParams> => ({
  queue: [],
  currentClimbQueueItem: null,
  climbSearchParams: initialSearchParams,
  playlistSuggestionSource: null,
  hasDoneFirstFetch: false,
  pendingCurrentClimbUpdates: [],
  needsResync: false,
  unconfirmedMove: null,
});

export function queueReducer<TSearchParams extends QueueSearchParams>(
  state: QueueState<TSearchParams>,
  action: QueueAction<TSearchParams>,
): QueueState<TSearchParams> {
  const nextState = retireStaleUnconfirmedMove(reduceQueue(state, action));
  return action.serverSequence === undefined ? nextState : { ...nextState, serverSequence: action.serverSequence };
}

function reduceQueue<TSearchParams extends QueueSearchParams>(
  state: QueueState<TSearchParams>,
  action: QueueAction<TSearchParams>,
): QueueState<TSearchParams> {
  switch (action.type) {
    case 'SET_CURRENT_CLIMB': {
      const currentIndex = state.currentClimbQueueItem
        ? state.queue.findIndex(({ uuid }) => uuid === state.currentClimbQueueItem?.uuid)
        : -1;

      return {
        ...state,
        currentClimbQueueItem: action.payload,
        queue:
          currentIndex === -1
            ? [...state.queue, action.payload]
            : [...state.queue.slice(0, currentIndex + 1), action.payload, ...state.queue.slice(currentIndex + 1)],
      };
    }

    case 'SET_CURRENT_CLIMB_QUEUE_ITEM':
      return {
        ...state,
        currentClimbQueueItem: action.payload,
        queue:
          action.payload.suggested && !state.queue.find(({ uuid }) => uuid === action.payload.uuid)
            ? [...state.queue, action.payload]
            : state.queue,
      };

    case 'SET_CLIMB_SEARCH_PARAMS':
      return {
        ...state,
        climbSearchParams: action.payload,
      };
    case 'INITIAL_QUEUE_DATA': {
      // Filter out any undefined/null items that could corrupt queue operations
      // This handles edge cases from corrupted IndexedDB or WebSocket data
      const filteredQueue = action.payload.queue.filter(
        (item): item is NonNullable<typeof item> => item != null && item.climb != null,
      );
      const hadCorruptedData = filteredQueue.length !== action.payload.queue.length;

      if (hadCorruptedData) {
        console.warn('[QueueReducer] Filtered corrupted items from INITIAL_QUEUE_DATA, requesting resync');
      }

      const snapshotState: QueueState<TSearchParams> = {
        ...state,
        queue: filteredQueue,
        currentClimbQueueItem: hasCurrentClimbQueueItem(action.payload)
          ? (action.payload.currentClimbQueueItem ?? null)
          : state.currentClimbQueueItem,
        playlistSuggestionSource: null,
        // Clear pending updates on full sync since we're getting complete server state
        pendingCurrentClimbUpdates: [],
        // Request resync if we filtered out corrupted data
        needsResync: hadCorruptedData,
        unconfirmedMove: null,
        serverSequenceSessionId: action.payload.sessionId ?? null,
      };

      // A snapshot can be older than this client's latest move: a reconnect's
      // FullSync is read before the re-sent move lands, an HTTP resync can race
      // it. See UnconfirmedQueueMove for the three outcomes.
      const move = state.unconfirmedMove;
      const movedItem = state.currentClimbQueueItem;
      if (
        !move ||
        move.sessionId !== action.payload.sessionId ||
        !hasCurrentClimbQueueItem(action.payload) ||
        movedItem?.uuid !== move.itemUuid
      ) {
        return snapshotState;
      }
      const snapshotCurrentUuid = action.payload.currentClimbQueueItem?.uuid ?? null;
      // The snapshot predates the move only if nothing at all happened in the
      // session since this client last heard from it: same sequence as the
      // last one it applied in this same session, and on a climb it moved off. A higher sequence
      // means events it never saw, and a climb it moved off then proves
      // nothing: its own move may have landed and a crewmate moved the wall
      // back. Every event it did see either confirmed the move, retired it (a
      // crewmate's move) or left the wall alone.
      const nothingHappenedSince =
        action.serverSequence !== undefined &&
        state.serverSequenceSessionId === move.sessionId &&
        action.serverSequence === state.serverSequence;
      // A chain longer than `movedOff` keeps may have dropped the climb the
      // session still holds: no proof either way, so the snapshot wins.
      if (
        snapshotCurrentUuid === move.itemUuid ||
        !nothingHappenedSince ||
        move.movedOffTruncated ||
        !move.movedOff.includes(snapshotCurrentUuid)
      ) {
        return snapshotState;
      }
      // The session has not seen the move yet. Keep the wall where the climber
      // put it, and keep the pending correlation ids so the move's echo is still
      // recognised as this client's own instead of re-applied. The local copy of
      // the climb is the freshest one (hydrated, regraded, mirrored).
      return {
        ...snapshotState,
        queue: replayUnconfirmedMove(filteredQueue, snapshotCurrentUuid, move, movedItem),
        currentClimbQueueItem: movedItem,
        pendingCurrentClimbUpdates: state.pendingCurrentClimbUpdates,
        // A send that missed the session was waiting for exactly this: the
        // opening snapshot of a live stream that still predates the move. From
        // here every crewmate's move reaches this client as an event and
        // retires the record, so the provider can re-send now. A point read
        // (HTTP) keeps the wall but releases nothing.
        unconfirmedMove:
          move.resend === 'awaiting-snapshot' && action.payload.live === true ? { ...move, resend: 'ready' } : move,
      };
    }

    case 'UPDATE_QUEUE': {
      // A local replacement, never a server snapshot: the climber's own queue
      // replace, a reorder rolled back, a privacy scrub, a cold-start restore.
      // When it changes the current climb, retireStaleUnconfirmedMove retires
      // the move without a word, as for any local move that is not sent; the
      // last two keep the current climb. Server state reaches the reducer as
      // INITIAL_QUEUE_DATA tagged with its session (the stream's FullSync and
      // the HTTP resync both), which is where a move is weighed against it.
      // Filter out any undefined/null items that could corrupt queue operations
      const filteredQueue = action.payload.queue.filter(
        (item): item is NonNullable<typeof item> => item != null && item.climb != null,
      );
      const hadCorruptedData = filteredQueue.length !== action.payload.queue.length;

      if (hadCorruptedData) {
        console.warn('[QueueReducer] Filtered corrupted items from UPDATE_QUEUE, requesting resync');
      }

      return {
        ...state,
        queue: filteredQueue,
        currentClimbQueueItem: hasCurrentClimbQueueItem(action.payload)
          ? (action.payload.currentClimbQueueItem ?? null)
          : state.currentClimbQueueItem,
        playlistSuggestionSource: null,
        // Request resync if we filtered out corrupted data
        needsResync: state.needsResync || hadCorruptedData,
      };
    }

    case 'ADD_TO_QUEUE':
      return {
        ...state,
        queue: [...state.queue, action.payload],
      };

    case 'REMOVE_FROM_QUEUE':
      return {
        ...state,
        queue: [...action.payload],
      };

    case 'SET_FIRST_FETCH':
      return {
        ...state,
        hasDoneFirstFetch: action.payload,
      };

    case 'MIRROR_CLIMB':
      if (!state.currentClimbQueueItem) return state;
      return {
        ...state,
        currentClimbQueueItem: {
          ...state.currentClimbQueueItem,
          climb: {
            ...state.currentClimbQueueItem.climb,
            mirrored: !state.currentClimbQueueItem.climb.mirrored,
          },
        },
      };

    // Delta-specific reducers
    case 'DELTA_ADD_QUEUE_ITEM': {
      const { item, position } = action.payload;

      // Skip if item or its climb is undefined
      if (!item || !item.climb) {
        return state;
      }

      // Idempotent insert: checks by item.uuid (NOT climb.uuid - the same climb CAN appear
      // multiple times in the queue, e.g., user adds it again after completing it)
      const newQueue = insertQueueItemIdempotent(state.queue, item, position);
      if (newQueue === state.queue) {
        return state;
      }

      return {
        ...state,
        queue: newQueue,
      };
    }

    case 'DELTA_REMOVE_QUEUE_ITEM': {
      const { uuid } = action.payload;
      return {
        ...state,
        queue: state.queue.filter((item) => item.uuid !== uuid),
        // Clear current climb if it was removed
        currentClimbQueueItem: state.currentClimbQueueItem?.uuid === uuid ? null : state.currentClimbQueueItem,
      };
    }

    case 'DELTA_REORDER_QUEUE_ITEM': {
      const { uuid, oldIndex, newIndex } = action.payload;
      const newQueue = [...state.queue];

      // Validate indices
      if (oldIndex < 0 || oldIndex >= newQueue.length || newIndex < 0 || newIndex >= newQueue.length) {
        return state;
      }

      // Verify the item at oldIndex has the expected UUID
      if (newQueue[oldIndex].uuid !== uuid) {
        return state;
      }

      // Perform the reorder
      const [movedItem] = newQueue.splice(oldIndex, 1);
      newQueue.splice(newIndex, 0, movedItem);

      return {
        ...state,
        queue: newQueue,
      };
    }

    case 'DELTA_UPDATE_CURRENT_CLIMB': {
      const {
        item,
        shouldAddToQueue,
        insertAfterCurrent,
        isServerEvent,
        eventClientId,
        myClientId,
        correlationId,
        serverCorrelationId,
        playlistSuggestionSource,
        pruneSuggestedAfterCurrent = true,
        sessionId,
      } = action.payload;

      // NO MORE TIMESTAMP FILTERING - reducer is now pure!
      let pendingUpdates = state.pendingCurrentClimbUpdates;

      // For server events, check if this is an echo of our own update
      if (isServerEvent && item) {
        // Primary: Correlation ID matching (most precise)
        if (serverCorrelationId && pendingUpdates.includes(serverCorrelationId)) {
          // This is our own update echoed back - skip it and remove from pending.
          // When it is the latest send of the unconfirmed move, the session now
          // holds that move: nothing left to protect.
          return {
            ...state,
            pendingCurrentClimbUpdates: pendingUpdates.filter((id) => id !== serverCorrelationId),
            unconfirmedMove:
              state.unconfirmedMove?.correlationId === serverCorrelationId ? null : state.unconfirmedMove,
          };
        }

        // Fallback 1: ClientId-based detection
        const isOurOwnEcho = eventClientId && myClientId && eventClientId === myClientId;
        if (isOurOwnEcho) {
          // Our echo, but without correlation ID - keep pending as-is (will be cleaned by effect)
          return {
            ...state,
            pendingCurrentClimbUpdates: pendingUpdates,
          };
        }

        // Note: UUID-based fallback was removed because it was incorrectly skipping
        // legitimate server updates. Without correlation ID or clientId from the server,
        // we cannot reliably detect echoes. The UI may briefly flash on legacy servers,
        // but state will converge correctly.
      }

      // Skip own-tap re-dispatches (same QueueItem from same local code path
      // firing twice without a server round-trip). Only applies to LOCAL
      // updates — server events that landed here passed the correlationId /
      // clientId echo guards above, so they're legitimate peer broadcasts and
      // need to flow through (the BLE-paired phone re-sends the climb to the
      // board on every broadcast, even when the wall climb's uuid hasn't
      // changed — e.g. a member re-asserting the same climb to re-light the wall).
      if (!isServerEvent && item && state.currentClimbQueueItem?.uuid === item.uuid) {
        // Nothing about the current climb changes, but when this local
        // re-dispatch carries a correlationId a server mutation IS being sent for
        // it (re-asserting the current climb to re-light a peer's wall, or the
        // #3868 re-broadcast of a now-hydrated current). Record the id so the
        // echoed CurrentClimbChanged is suppressed by the correlationId guard
        // above instead of re-applied — an unsuppressed echo would revert a newer
        // navigation back onto this climb. The seeding block below is unreachable
        // from this early return, so seed here. No id ⇒ a pure local re-tap with
        // no broadcast: leave state untouched.
        if (!correlationId) return state;
        // A re-assert of the move still waiting for confirmation is that move's
        // newest send: its echo is the one that confirms it now, and it replaces
        // any re-send the earlier send was waiting for.
        const move = state.unconfirmedMove;
        return {
          ...state,
          pendingCurrentClimbUpdates: [...state.pendingCurrentClimbUpdates, correlationId].slice(-50),
          unconfirmedMove:
            move && sessionId && move.sessionId === sessionId ? { ...move, correlationId, resend: 'none' } : move,
        };
      }

      let newQueue = state.queue;

      // Add to queue if requested and this queue item doesn't already exist
      // Check by item.uuid for idempotency - the same climb CAN appear multiple times
      // (e.g., user adds it again after completing it)
      if (item && item.climb && shouldAddToQueue && !state.queue.find((qItem) => qItem?.uuid === item.uuid)) {
        if (insertAfterCurrent && state.currentClimbQueueItem) {
          const currentIndex = state.queue.findIndex((q) => q.uuid === state.currentClimbQueueItem?.uuid);
          if (currentIndex >= 0) {
            newQueue = [...state.queue.slice(0, currentIndex + 1), item, ...state.queue.slice(currentIndex + 1)];
          } else {
            newQueue = [...state.queue, item];
          }
        } else {
          newQueue = [...state.queue, item];
        }
      }

      // For local updates, track correlation ID (no timestamp!)
      if (!isServerEvent && item && correlationId) {
        pendingUpdates = [...pendingUpdates, correlationId].slice(-50); // Still bound to 50 items for safety
      }

      // A server event that got this far moved the wall for someone else, so
      // any unconfirmed local move is history. A local move that is sent to a
      // session becomes the new unconfirmed move, chained onto the previous one
      // when that one was never confirmed either: the session may still hold
      // any climb along the chain. A local move that is not sent changes the
      // current climb, which retires the record (retireStaleUnconfirmedMove).
      let unconfirmedMove = isServerEvent ? null : state.unconfirmedMove;
      if (!isServerEvent && item && correlationId && sessionId) {
        const chainedMove = state.unconfirmedMove?.sessionId === sessionId ? state.unconfirmedMove : null;
        const movedOffUuid = state.currentClimbQueueItem?.uuid ?? null;
        const movedOff = [...(chainedMove?.movedOff ?? []), movedOffUuid].filter(
          (uuid, index, all) => uuid !== item.uuid && all.lastIndexOf(uuid) === index,
        );
        unconfirmedMove = {
          sessionId,
          correlationId,
          itemUuid: item.uuid,
          shouldAddToQueue: !!shouldAddToQueue,
          insertAfterCurrent: !!insertAfterCurrent,
          movedOff: movedOff.slice(-MAX_UNCONFIRMED_MOVED_OFF),
          movedOffTruncated: (chainedMove?.movedOffTruncated ?? false) || movedOff.length > MAX_UNCONFIRMED_MOVED_OFF,
          resend: 'none',
        };
      }

      return {
        ...state,
        queue:
          playlistSuggestionSource && item && pruneSuggestedAfterCurrent
            ? pruneSuggestedQueueItemsAfterCurrent(newQueue, item)
            : newQueue,
        currentClimbQueueItem: item,
        playlistSuggestionSource:
          playlistSuggestionSource === undefined ? state.playlistSuggestionSource : playlistSuggestionSource,
        pendingCurrentClimbUpdates: pendingUpdates,
        unconfirmedMove,
      };
    }

    case 'SET_PLAYLIST_SUGGESTION_SOURCE': {
      return {
        ...state,
        playlistSuggestionSource: action.payload,
      };
    }

    case 'REFRESH_PLAYLIST_SUGGESTION_SOURCE': {
      if (!playlistSuggestionSourceMatches(state.playlistSuggestionSource, action.payload)) {
        return state;
      }
      return {
        ...state,
        playlistSuggestionSource: action.payload,
      };
    }

    case 'CLEANUP_PENDING_UPDATE': {
      // The id's echo never came within the TTL. If it was the unconfirmed
      // move's latest send, stop protecting the move too: the next snapshot is
      // the truth again.
      return {
        ...state,
        pendingCurrentClimbUpdates: state.pendingCurrentClimbUpdates.filter(
          (id) => id !== action.payload.correlationId,
        ),
        unconfirmedMove:
          state.unconfirmedMove?.correlationId === action.payload.correlationId ? null : state.unconfirmedMove,
      };
    }

    case 'CLEANUP_PENDING_UPDATES_BATCH': {
      // Batch cleanup to avoid multiple re-renders
      const idsToRemove = new Set(action.payload.correlationIds);
      return {
        ...state,
        pendingCurrentClimbUpdates: state.pendingCurrentClimbUpdates.filter((id) => !idsToRemove.has(id)),
        unconfirmedMove:
          state.unconfirmedMove && idsToRemove.has(state.unconfirmedMove.correlationId) ? null : state.unconfirmedMove,
      };
    }

    case 'UNCONFIRMED_MOVE_NOT_SENT': {
      const move = state.unconfirmedMove;
      const { correlationId, serverViewIsLive } = action.payload;
      if (!move || move.correlationId !== correlationId || move.resend !== 'none') return state;
      return {
        ...state,
        unconfirmedMove: { ...move, resend: serverViewIsLive ? 'ready' : 'awaiting-snapshot' },
      };
    }

    case 'UNCONFIRMED_MOVE_RESENT': {
      const move = state.unconfirmedMove;
      if (!move || move.correlationId !== action.payload.correlationId || move.resend !== 'ready') return state;
      return { ...state, unconfirmedMove: { ...move, resend: 'resent' } };
    }

    case 'UNCONFIRMED_MOVE_DROPPED': {
      const move = state.unconfirmedMove;
      const { correlationId } = action.payload;
      if (!move || (correlationId !== undefined && move.correlationId !== correlationId)) return state;
      return { ...state, unconfirmedMove: null };
    }

    case 'DELTA_MIRROR_CURRENT_CLIMB': {
      const { mirrored, mirroredUuid } = action.payload;
      if (mirroredUuid === null) return state;
      const mirrorsCurrent = state.currentClimbQueueItem?.uuid === mirroredUuid;
      if (!mirrorsCurrent && !state.queue.some((item) => item.uuid === mirroredUuid)) return state;
      const mirrorItem = (item: ClimbQueueItem) => ({ ...item, climb: { ...item.climb, mirrored } });
      // Optimistic navigation may already point elsewhere. The event still
      // updates its exact queue slot so returning to it preserves the flip.
      return {
        ...state,
        queue: state.queue.map((item) => (item.uuid === mirroredUuid ? mirrorItem(item) : item)),
        currentClimbQueueItem:
          mirrorsCurrent && state.currentClimbQueueItem
            ? mirrorItem(state.currentClimbQueueItem)
            : state.currentClimbQueueItem,
      };
    }

    case 'DELTA_REPLACE_QUEUE_ITEM': {
      const { uuid, item } = action.payload;
      const itemIndex = state.queue.findIndex((qItem) => qItem.uuid === uuid);

      if (itemIndex === -1) {
        return state.currentClimbQueueItem?.uuid === uuid ? { ...state, currentClimbQueueItem: item } : state;
      }

      const newQueue = [...state.queue];
      newQueue[itemIndex] = item;

      return {
        ...state,
        queue: newQueue,
        // Update current climb if it was the replaced item
        currentClimbQueueItem: state.currentClimbQueueItem?.uuid === uuid ? item : state.currentClimbQueueItem,
      };
    }

    case 'HYDRATE_CLIMBS': {
      const { climb, targets, boardType, layoutId, activeAngle } = action.payload;
      if (!climb.uuid || !climb.name || !climb.frames || !climbMatchesReadScope(climb, boardType, layoutId))
        return state;
      const queuedTargets = new Map(
        targets.filter((target) => target.role === 'queue').map((target) => [target.uuid, target]),
      );
      const currentTarget = targets.find(
        (target) => target.role === 'current' && target.uuid === state.currentClimbQueueItem?.uuid,
      );
      const currentIndex = state.currentClimbQueueItem
        ? state.queue.findIndex((item) => item.uuid === state.currentClimbQueueItem?.uuid)
        : -1;
      let changed = false;
      const hydrate = (
        item: ClimbQueueItem,
        target: QueueClimbReadTarget | undefined,
        targetAngle: number,
      ): ClimbQueueItem => {
        if (
          !isReadTargetCurrent(item, target, targetAngle) ||
          item.climb.uuid !== climb.uuid ||
          climb.angle !== targetAngle ||
          (item.climb.name && item.climb.frames) ||
          !climbMatchesReadScope(item.climb, boardType, layoutId)
        )
          return item;
        changed = true;
        return { ...item, climb: { ...item.climb, ...climb, mirrored: item.climb.mirrored } };
      };
      const queue = state.queue.map((item, index) =>
        hydrate(item, queuedTargets.get(item.uuid), index < currentIndex ? item.climb.angle : activeAngle),
      );
      const currentClimbQueueItem = state.currentClimbQueueItem
        ? hydrate(state.currentClimbQueueItem, currentTarget, activeAngle)
        : null;
      return changed ? { ...state, queue, currentClimbQueueItem } : state;
    }

    case 'REGRADE_CLIMBS': {
      // Patch the per-angle grade fields onto the CURRENT + UPCOMING climbs when
      // the board angle changes. Keyed by climb.uuid (the SAME climb can appear
      // multiple times — e.g. re-added after a tick — so every occurrence in the
      // regraded range is patched). Local-only: the caller re-fetches each
      // climb's grade for the new angle and dispatches this; nothing is sent to
      // peers (each client follows the angle and re-grades its own queue).
      //
      // History items (everything before the current climb — the same split
      // buildQueueListModel uses) are deliberately NOT re-graded: they keep the
      // grade for the angle they were CLIMBED at. A V6 send at 40° must not turn
      // into a V8 when the rest of the session moves to 35°. Because current +
      // upcoming continuously track the live angle, a climb's angle is already
      // the live angle at the moment it advances into history, so freezing it
      // there pins the climbed-at angle for free — no separate `sentAtAngle`.
      const { grades, targets, boardType, layoutId } = action.payload;
      const queuedTargets = targets
        ? new Map(targets.filter((target) => target.role === 'queue').map((target) => [target.uuid, target]))
        : undefined;
      const currentTarget = targets?.find(
        (target) => target.role === 'current' && target.uuid === state.currentClimbQueueItem?.uuid,
      );
      let changed = false;
      const regrade = (item: ClimbQueueItem, role: 'queue' | 'current'): ClimbQueueItem => {
        const patch = grades[item.climb.uuid];
        // Skip if there's no patch, or the climb already carries this angle
        // (idempotent — re-running after a patch / on a stale FullSync no-ops).
        if (!patch || item.climb.angle === patch.angle) return item;
        if (
          !climbMatchesReadScope(item.climb, boardType, layoutId) ||
          (targets &&
            (!item.climb.name ||
              !item.climb.frames ||
              !isReadTargetCurrent(
                item,
                role === 'queue' ? queuedTargets?.get(item.uuid) : currentTarget,
                patch.angle,
              )))
        )
          return item;
        changed = true;
        return { ...item, climb: { ...item.climb, ...patch } };
      };

      // Index of the current climb in the flat queue. When there's no current
      // item (-1) the whole queue is "upcoming" per buildQueueListModel, so the
      // `index < currentIndex` guard is never true and everything is re-graded.
      const currentIndex = state.currentClimbQueueItem
        ? state.queue.findIndex(({ uuid }) => uuid === state.currentClimbQueueItem?.uuid)
        : -1;

      // History items (index < currentIndex) are returned by reference, so the
      // reference-equality / no-churn guarantees hold for them too.
      const newQueue = state.queue.map((item, index) => (index < currentIndex ? item : regrade(item, 'queue')));
      const newCurrent = state.currentClimbQueueItem ? regrade(state.currentClimbQueueItem, 'current') : null;

      // Preserve the original state reference when nothing matched, so the
      // self-healing effect that dispatches this can't churn renders.
      if (!changed) return state;

      return {
        ...state,
        queue: newQueue,
        currentClimbQueueItem: newCurrent,
      };
    }

    case 'REFRESH_AUTHORED_CLIMB': {
      // The setter saved this climb again, so every copy already in the queue is
      // out of date: its name, its holds, whether it is still a draft.
      //
      // This is its own action, NOT a relaxation of DELTA_UPDATE_CURRENT_CLIMB's
      // same-uuid short-circuit. That branch is what keeps a re-tap from
      // churning state and what seeds the correlationId that suppresses the
      // server echo; both stay exactly as they are. A save that re-asserts the
      // current climb still goes through it (and still broadcasts), and this
      // action then corrects the payload the short-circuit left alone.
      //
      // Local-only, like REGRADE_CLIMBS. Nothing here changes the queue's order
      // or its item uuids, which is all the session state hash covers, so it
      // cannot trip the drift watchdog. Peers get the new payload for the
      // current climb from the CurrentClimbChanged broadcast, as before.
      //
      // Keyed by climb.uuid, so a climb queued twice is corrected in both slots,
      // history included: a climb that was published is published everywhere.
      const { climbUuid, patch } = action.payload;
      const patchKeys = Object.keys(patch) as Array<keyof typeof patch>;
      let changed = false;
      const refresh = (item: ClimbQueueItem): ClimbQueueItem => {
        if (item.climb.uuid !== climbUuid) return item;
        if (patchKeys.every((key) => item.climb[key] === patch[key])) return item;
        changed = true;
        // The holds version describes the holds the item was queued with
        // (#6023). New holds make it stale, so drop it: an unknown holds
        // version lets the sent glyph count every tick on the climb.
        const versions = item.climb.frames === patch.frames ? {} : { holdsRevisionNumber: null };
        return { ...item, climb: { ...item.climb, ...patch, ...versions } };
      };

      const newQueue = state.queue.map(refresh);
      const newCurrent = state.currentClimbQueueItem ? refresh(state.currentClimbQueueItem) : null;

      // Same state reference when nothing matched or nothing differs, so a save
      // of a climb that is not queued re-renders no queue consumer.
      if (!changed) return state;

      return {
        ...state,
        queue: newQueue,
        currentClimbQueueItem: newCurrent,
      };
    }

    case 'CLEAR_RESYNC_FLAG':
      return {
        ...state,
        needsResync: false,
      };

    case 'CLEAR_QUEUE':
      return {
        ...state,
        queue: [],
        currentClimbQueueItem: null,
        playlistSuggestionSource: null,
      };

    default:
      return state;
  }
}
