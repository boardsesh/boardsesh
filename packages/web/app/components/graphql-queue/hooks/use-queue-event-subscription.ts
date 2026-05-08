import { type Dispatch, useEffect } from 'react';
import type { SubscriptionQueueEvent } from '@boardsesh/shared-schema';
import type { BoardSend, ClimbQueueItem, QueueAction, UserPick } from '../../queue-control/types';

type UseQueueEventSubscriptionParams = {
  isPersistentSessionActive: boolean;
  dispatch: Dispatch<QueueAction>;
  persistentSession: {
    clientId: string | null;
    subscribeToQueueEvents: (callback: (event: SubscriptionQueueEvent) => void) => () => void;
    triggerResync: () => void;
  };
  needsResync: boolean;
};

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
}: UseQueueEventSubscriptionParams) {
  // Subscribe to queue events from persistent session
  useEffect(() => {
    if (!isPersistentSessionActive) return;

    const unsubscribe = persistentSession.subscribeToQueueEvents((event: SubscriptionQueueEvent) => {
      switch (event.__typename) {
        case 'FullSync':
          dispatch({
            type: 'INITIAL_QUEUE_DATA',
            payload: {
              queue: event.state.queue as ClimbQueueItem[],
              currentClimbQueueItem: event.state.currentClimbQueueItem as ClimbQueueItem | null,
              picks: event.state.picks as UserPick[],
              activeClimberUserId: event.state.activeClimberUserId,
            },
          });
          break;
        case 'QueueItemAdded':
          dispatch({
            type: 'DELTA_ADD_QUEUE_ITEM',
            payload: {
              item: event.addedItem as ClimbQueueItem,
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
              item: event.currentItem as ClimbQueueItem | null,
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
        case 'PickChanged':
          dispatch({
            type: 'DELTA_PICK_CHANGED',
            payload: {
              userId: event.userId,
              pick: event.pick as ClimbQueueItem | null,
            },
          });
          break;
        case 'ActiveClimberChanged':
          dispatch({
            type: 'DELTA_ACTIVE_CLIMBER_CHANGED',
            payload: { userId: event.activeClimberUserId },
          });
          break;
        case 'BoardSendAdded':
          dispatch({
            type: 'DELTA_BOARD_SEND_ADDED',
            payload: { boardSend: event.boardSend as BoardSend },
          });
          break;
      }
    });

    return unsubscribe;
  }, [isPersistentSessionActive, persistentSession, dispatch]);

  // Trigger resync when corrupted data is detected
  useEffect(() => {
    if (!needsResync || !isPersistentSessionActive) return;

    console.info('[QueueContext] Corrupted data detected, triggering resync');
    dispatch({ type: 'CLEAR_RESYNC_FLAG' });
    persistentSession.triggerResync();
  }, [needsResync, isPersistentSessionActive, persistentSession, dispatch]);
}
