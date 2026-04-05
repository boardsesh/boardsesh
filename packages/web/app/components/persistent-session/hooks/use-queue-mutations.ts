import { useCallback } from 'react';
import { execute, Client } from '../../graphql-queue/graphql-client';
import { NativeWSClient } from '../../graphql-queue/native-ws-client';
import {
  ADD_QUEUE_ITEM,
  REMOVE_QUEUE_ITEM,
  SET_CURRENT_CLIMB,
  MIRROR_CURRENT_CLIMB,
  SET_QUEUE,
} from '@boardsesh/shared-schema';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import type { Session } from '../types';
import { toClimbQueueItemInput } from '../types';

type TransportClient = Client | NativeWSClient;

/** Execute an operation on either a graphql-ws Client or NativeWSClient. */
function executeOnTransport<T>(client: TransportClient, operation: { query: string; variables?: Record<string, unknown> }): Promise<T> {
  if (client instanceof NativeWSClient) {
    return client.execute<T>(operation);
  }
  return execute<T>(client, operation);
}

interface UseQueueMutationsArgs {
  client: TransportClient | null;
  session: Session | null;
}

export interface QueueMutationsActions {
  addQueueItem: (item: LocalClimbQueueItem, position?: number) => Promise<void>;
  removeQueueItem: (uuid: string) => Promise<void>;
  setCurrentClimb: (item: LocalClimbQueueItem | null, shouldAddToQueue?: boolean, correlationId?: string) => Promise<void>;
  mirrorCurrentClimb: (mirrored: boolean) => Promise<void>;
  setQueue: (queue: LocalClimbQueueItem[], currentClimbQueueItem?: LocalClimbQueueItem | null) => Promise<void>;
}

export function useQueueMutations({ client, session }: UseQueueMutationsArgs): QueueMutationsActions {
  const addQueueItem = useCallback(
    async (item: LocalClimbQueueItem, position?: number) => {
      if (!client || !session) throw new Error('Not connected to session');
      await executeOnTransport(client, {
        query: ADD_QUEUE_ITEM,
        variables: { item: toClimbQueueItemInput(item), position },
      });
    },
    [client, session],
  );

  const removeQueueItem = useCallback(
    async (uuid: string) => {
      if (!client || !session) throw new Error('Not connected to session');
      await executeOnTransport(client, {
        query: REMOVE_QUEUE_ITEM,
        variables: { uuid },
      });
    },
    [client, session],
  );

  const setCurrentClimb = useCallback(
    async (item: LocalClimbQueueItem | null, shouldAddToQueue?: boolean, correlationId?: string) => {
      if (!client || !session) throw new Error('Not connected to session');
      await executeOnTransport(client, {
        query: SET_CURRENT_CLIMB,
        variables: {
          item: item ? toClimbQueueItemInput(item) : null,
          shouldAddToQueue,
          correlationId,
        },
      });
    },
    [client, session],
  );

  const mirrorCurrentClimb = useCallback(
    async (mirrored: boolean) => {
      if (!client || !session) throw new Error('Not connected to session');
      await executeOnTransport(client, {
        query: MIRROR_CURRENT_CLIMB,
        variables: { mirrored },
      });
    },
    [client, session],
  );

  const setQueue = useCallback(
    async (newQueue: LocalClimbQueueItem[], newCurrentClimbQueueItem?: LocalClimbQueueItem | null) => {
      if (!client || !session) throw new Error('Not connected to session');
      await executeOnTransport(client, {
        query: SET_QUEUE,
        variables: {
          queue: newQueue.map(toClimbQueueItemInput),
          currentClimbQueueItem: newCurrentClimbQueueItem ? toClimbQueueItemInput(newCurrentClimbQueueItem) : undefined,
        },
      });
    },
    [client, session],
  );

  return {
    addQueueItem,
    removeQueueItem,
    setCurrentClimb,
    mirrorCurrentClimb,
    setQueue,
  };
}
