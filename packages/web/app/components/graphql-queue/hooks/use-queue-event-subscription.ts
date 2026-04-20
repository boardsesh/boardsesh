import { useEffect, Dispatch } from 'react';
import { SubscriptionQueueEvent, type BoardConfig } from '@boardsesh/shared-schema';
import type { ClimbQueueItem, QueueAction } from '../../queue-control/types';
import { normalizeQueueItem } from '@/app/lib/board-config';

interface UseQueueEventSubscriptionParams {
  isPersistentSessionActive: boolean;
  dispatch: Dispatch<QueueAction>;
  persistentSession: {
    clientId: string | null;
    subscribeToQueueEvents: (callback: (event: SubscriptionQueueEvent) => void) => () => void;
    triggerResync: () => void;
  };
  needsResync: boolean;
  /**
   * Fallback `BoardConfig` used by the ingress normalizer to backfill legacy
   * queue items (from older clients that didn't stamp `boardConfig`). Set this
   * to the current route's config or the session's primary board.
   */
  fallbackBoardConfig: BoardConfig | null;
}

/**
 * Subscribes to queue events from the persistent session (party mode)
 * and dispatches delta actions to the reducer. Also handles resync
 * when corrupted data is detected.
 */
export function useQueueEventSubscription({
  isPersistentSessionActive,
  dispatch,
  persistentSession,
  needsResync,
  fallbackBoardConfig,
}: UseQueueEventSubscriptionParams) {
  // Subscribe to queue events from persistent session
  useEffect(() => {
    if (!isPersistentSessionActive) return;

    // Ingress normalizer: ensure every incoming item carries `boardConfig`
    // and a populated `climb.boardType`/`climb.layoutId`. Legacy items from
    // older clients (or from sessions created before the multi-board queue
    // work shipped) fall through without `boardConfig` — we backfill with
    // the current route / session fallback so UI stays self-describing.
    const normalize = (item: ClimbQueueItem): ClimbQueueItem =>
      normalizeQueueItem(item, fallbackBoardConfig);
    const normalizeNullable = (item: ClimbQueueItem | null): ClimbQueueItem | null =>
      item ? normalize(item) : null;

    const unsubscribe = persistentSession.subscribeToQueueEvents((event: SubscriptionQueueEvent) => {
      switch (event.__typename) {
        case 'FullSync':
          dispatch({
            type: 'INITIAL_QUEUE_DATA',
            payload: {
              queue: (event.state.queue as ClimbQueueItem[]).map(normalize),
              currentClimbQueueItem: normalizeNullable(event.state.currentClimbQueueItem as ClimbQueueItem | null),
            },
          });
          break;
        case 'QueueItemAdded':
          dispatch({
            type: 'DELTA_ADD_QUEUE_ITEM',
            payload: {
              item: normalize(event.addedItem as ClimbQueueItem),
              position: event.position,
            },
          });
          break;
        case 'QueueItemRemoved':
          dispatch({
            type: 'DELTA_REMOVE_QUEUE_ITEM',
            payload: { uuid: event.uuid },
          });
          break;
        case 'QueueReordered':
          dispatch({
            type: 'DELTA_REORDER_QUEUE_ITEM',
            payload: {
              uuid: event.uuid,
              oldIndex: event.oldIndex,
              newIndex: event.newIndex,
            },
          });
          break;
        case 'CurrentClimbChanged':
          dispatch({
            type: 'DELTA_UPDATE_CURRENT_CLIMB',
            payload: {
              item: normalizeNullable(event.currentItem as ClimbQueueItem | null),
              shouldAddToQueue: (event.currentItem as ClimbQueueItem | null)?.suggested ?? false,
              isServerEvent: true,
              eventClientId: event.clientId || undefined,
              myClientId: persistentSession.clientId || undefined,
              serverCorrelationId: event.correlationId || undefined,
            },
          });
          break;
        case 'ClimbMirrored':
          dispatch({
            type: 'DELTA_MIRROR_CURRENT_CLIMB',
            payload: { mirrored: event.mirrored },
          });
          break;
      }
    });

    return unsubscribe;
  }, [isPersistentSessionActive, persistentSession, dispatch, fallbackBoardConfig]);

  // Trigger resync when corrupted data is detected
  useEffect(() => {
    if (!needsResync || !isPersistentSessionActive) return;

    console.log('[QueueContext] Corrupted data detected, triggering resync');
    dispatch({ type: 'CLEAR_RESYNC_FLAG' });
    persistentSession.triggerResync();
  }, [needsResync, isPersistentSessionActive, persistentSession, dispatch]);
}
