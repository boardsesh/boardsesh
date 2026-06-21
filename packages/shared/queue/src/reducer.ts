/**
 * Pure queue state reducer. No React, no DOM — works in any JS runtime.
 * The React `useReducer` wrapper lives in the web app.
 */

import type { QueueState, QueueAction, QueueSearchParams, ClimbQueueItem } from './types';
import { insertQueueItemIdempotent } from './event-utils';
import { playlistSuggestionSourceMatches, pruneSuggestedQueueItemsAfterCurrent } from './playlist-suggestions';

function hasCurrentClimbQueueItem(payload: { currentClimbQueueItem?: ClimbQueueItem | null }): boolean {
  return Object.prototype.hasOwnProperty.call(payload, 'currentClimbQueueItem');
}

export const initialState = <TSearchParams extends QueueSearchParams>(
  initialSearchParams: TSearchParams,
): QueueState<TSearchParams> => ({
  queue: [],
  currentClimbQueueItem: null,
  climbSearchParams: initialSearchParams,
  playlistSuggestionSource: null,
  hasDoneFirstFetch: false,
  initialQueueDataReceivedFromPeers: false,
  pendingCurrentClimbUpdates: [],
  lastReceivedSequence: null,
  lastReceivedStateHash: null,
  needsResync: false,
});

export function queueReducer<TSearchParams extends QueueSearchParams>(
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

      return {
        ...state,
        queue: filteredQueue,
        currentClimbQueueItem: hasCurrentClimbQueueItem(action.payload)
          ? (action.payload.currentClimbQueueItem ?? null)
          : state.currentClimbQueueItem,
        initialQueueDataReceivedFromPeers: true,
        playlistSuggestionSource: null,
        // Clear pending updates on full sync since we're getting complete server state
        pendingCurrentClimbUpdates: [],
        // Request resync if we filtered out corrupted data
        needsResync: hadCorruptedData,
      };
    }

    case 'UPDATE_QUEUE': {
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
      } = action.payload;

      // NO MORE TIMESTAMP FILTERING - reducer is now pure!
      let pendingUpdates = state.pendingCurrentClimbUpdates;

      // For server events, check if this is an echo of our own update
      if (isServerEvent && item) {
        // Primary: Correlation ID matching (most precise)
        if (serverCorrelationId && pendingUpdates.includes(serverCorrelationId)) {
          // This is our own update echoed back - skip it and remove from pending
          return {
            ...state,
            pendingCurrentClimbUpdates: pendingUpdates.filter((id) => id !== serverCorrelationId),
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
        return state;
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

      return {
        ...state,
        queue: playlistSuggestionSource && item ? pruneSuggestedQueueItemsAfterCurrent(newQueue, item) : newQueue,
        currentClimbQueueItem: item,
        playlistSuggestionSource:
          playlistSuggestionSource === undefined ? state.playlistSuggestionSource : playlistSuggestionSource,
        pendingCurrentClimbUpdates: pendingUpdates,
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
      return {
        ...state,
        pendingCurrentClimbUpdates: state.pendingCurrentClimbUpdates.filter(
          (id) => id !== action.payload.correlationId,
        ),
      };
    }

    case 'CLEANUP_PENDING_UPDATES_BATCH': {
      // Batch cleanup to avoid multiple re-renders
      const idsToRemove = new Set(action.payload.correlationIds);
      return {
        ...state,
        pendingCurrentClimbUpdates: state.pendingCurrentClimbUpdates.filter((id) => !idsToRemove.has(id)),
      };
    }

    case 'DELTA_MIRROR_CURRENT_CLIMB': {
      const { mirrored, mirroredUuid } = action.payload;
      if (!state.currentClimbQueueItem) return state;
      // Server-sourced events carry the uuid of the climb that was actually
      // mirrored on the server, or null when the server had no current
      // climb at publish time (a pre-B7 no-op event from history replay).
      // Suppress both cases:
      //   - null uuid: the server intentionally mirrored "nothing", so
      //     applying it to whatever the local current climb happens to be
      //     would mirror an unrelated climb until the next FullSync.
      //   - uuid mismatch: peer navigated to a different climb between the
      //     mirror mutation firing and the broadcast reaching us.
      // Local-origin dispatches always pass the local current climb's
      // uuid, so neither branch fires there.
      if (mirroredUuid === null || state.currentClimbQueueItem.uuid !== mirroredUuid) {
        return state;
      }

      const updatedCurrentItem = {
        ...state.currentClimbQueueItem,
        climb: {
          ...state.currentClimbQueueItem.climb,
          mirrored,
        },
      };

      // Update the item in the queue as well if it exists
      const updatedQueue = state.queue.map((item) =>
        item.uuid === state.currentClimbQueueItem?.uuid ? updatedCurrentItem : item,
      );

      return {
        ...state,
        queue: updatedQueue,
        currentClimbQueueItem: updatedCurrentItem,
      };
    }

    case 'DELTA_REPLACE_QUEUE_ITEM': {
      const { uuid, item } = action.payload;
      const itemIndex = state.queue.findIndex((qItem) => qItem.uuid === uuid);

      if (itemIndex === -1) {
        return state;
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

    case 'REGRADE_CLIMBS': {
      // Patch the per-angle grade fields onto climbs already in the queue /
      // current item when the board angle changes. Keyed by climb.uuid (the
      // SAME climb can appear multiple times — e.g. re-added after a tick — so
      // every occurrence is patched). Local-only: the caller re-fetches each
      // climb's grade for the new angle and dispatches this; nothing is sent to
      // peers (each client follows the angle and re-grades its own queue).
      const { grades } = action.payload;
      let changed = false;
      const regrade = (item: ClimbQueueItem): ClimbQueueItem => {
        const patch = grades[item.climb.uuid];
        // Skip if there's no patch, or the climb already carries this angle
        // (idempotent — re-running after a patch / on a stale FullSync no-ops).
        if (!patch || item.climb.angle === patch.angle) return item;
        changed = true;
        return { ...item, climb: { ...item.climb, ...patch } };
      };

      const newQueue = state.queue.map(regrade);
      const newCurrent = state.currentClimbQueueItem ? regrade(state.currentClimbQueueItem) : null;

      // Preserve the original state reference when nothing matched, so the
      // self-healing effect that dispatches this can't churn renders.
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
