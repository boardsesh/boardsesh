import { useCallback, useRef } from 'react';
import { type Client, execute } from '../../graphql-queue/graphql-client';
import {
  ADD_QUEUE_ITEM,
  REMOVE_QUEUE_ITEM,
  SET_CURRENT_CLIMB,
  MIRROR_CURRENT_CLIMB,
  SET_QUEUE,
  REPLACE_QUEUE_ITEM,
  REORDER_QUEUE_ITEM,
  SET_MY_PICK,
  CLAIM_TURN,
  YIELD_TURN,
  CLEAR_MY_PICK,
} from '@boardsesh/shared-schema';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import { type Session, toClimbQueueItemInput } from '../types';

type UseQueueMutationsArgs = {
  client: Client | null;
  session: Session | null;
};

export type QueueMutationsActions = {
  addQueueItem: (item: LocalClimbQueueItem, position?: number) => Promise<void>;
  removeQueueItem: (uuid: string) => Promise<void>;
  setCurrentClimb: (
    item: LocalClimbQueueItem | null,
    shouldAddToQueue?: boolean,
    correlationId?: string,
  ) => Promise<void>;
  mirrorCurrentClimb: (mirrored: boolean) => Promise<void>;
  setQueue: (queue: LocalClimbQueueItem[], currentClimbQueueItem?: LocalClimbQueueItem | null) => Promise<void>;
  replaceQueueItem: (uuid: string, item: LocalClimbQueueItem) => Promise<void>;
  reorderQueueItem: (uuid: string, oldIndex: number, newIndex: number) => Promise<void>;
  setMyPick: (item: LocalClimbQueueItem, correlationId?: string) => Promise<void>;
  claimTurn: (correlationId?: string) => Promise<void>;
  yieldTurn: (toUserId: string, correlationId?: string) => Promise<void>;
  clearMyPick: () => Promise<void>;
};

/**
 * Serialize-and-supersede pattern: at most one mutation in-flight at a time.
 * If a new call arrives while one is in-flight, it supersedes any previously
 * queued args. When the in-flight mutation completes, the pending one is sent.
 * The returned promise resolves/rejects when the actual server call finishes
 * (or immediately if superseded by a later call).
 */
type LatestWinsRefs<TArgs> = {
  inFlight: boolean;
  pending: TArgs | null;
};

async function executeWithLatestWins<TArgs>(
  refs: LatestWinsRefs<TArgs>,
  args: TArgs,
  executeFn: (args: TArgs) => Promise<void>,
  onSupersede?: (superseded: TArgs) => void,
): Promise<void> {
  if (refs.inFlight) {
    if (refs.pending !== null && onSupersede) {
      onSupersede(refs.pending);
    }
    refs.pending = args;
    return;
  }

  refs.inFlight = true;
  try {
    await executeFn(args);
  } finally {
    // Drain: send the latest pending call if one exists
    while (refs.pending !== null) {
      const next = refs.pending;
      refs.pending = null;
      try {
        await executeFn(next);
      } catch (error) {
        console.error('Failed to send coalesced mutation:', error);
      }
    }
    refs.inFlight = false;
  }
}

export function useQueueMutations({ client, session }: UseQueueMutationsArgs): QueueMutationsActions {
  // Use refs so callbacks have stable identity (never recreate)
  const clientRef = useRef(client);
  const sessionRef = useRef(session);
  clientRef.current = client;
  sessionRef.current = session;

  const setCurrentClimbRefs = useRef<
    LatestWinsRefs<{
      item: LocalClimbQueueItem | null;
      shouldAddToQueue?: boolean;
      correlationId?: string;
    }>
  >({ inFlight: false, pending: null });
  const setMyPickRefs = useRef<LatestWinsRefs<{ item: LocalClimbQueueItem; correlationId?: string }>>({
    inFlight: false,
    pending: null,
  });

  const addQueueItem = useCallback(async (item: LocalClimbQueueItem, position?: number) => {
    if (!clientRef.current || !sessionRef.current) throw new Error('Not connected to session');
    await execute(clientRef.current, {
      query: ADD_QUEUE_ITEM,
      variables: { item: toClimbQueueItemInput(item), position },
    });
  }, []);

  const removeQueueItem = useCallback(async (uuid: string) => {
    if (!clientRef.current || !sessionRef.current) throw new Error('Not connected to session');
    await execute(clientRef.current, {
      query: REMOVE_QUEUE_ITEM,
      variables: { uuid },
    });
  }, []);

  const setCurrentClimb = useCallback(
    async (item: LocalClimbQueueItem | null, shouldAddToQueue?: boolean, correlationId?: string) => {
      if (!clientRef.current || !sessionRef.current) throw new Error('Not connected to session');
      await executeWithLatestWins(
        setCurrentClimbRefs.current,
        { item, shouldAddToQueue, correlationId },
        async (args) => {
          if (!clientRef.current || !sessionRef.current) throw new Error('Not connected to session');
          await execute(clientRef.current, {
            query: SET_CURRENT_CLIMB,
            variables: {
              item: args.item ? toClimbQueueItemInput(args.item) : null,
              shouldAddToQueue: args.shouldAddToQueue,
              correlationId: args.correlationId,
            },
          });
        },
        (superseded) => {
          // The setCurrentClimb is correctly dropped (only latest matters),
          // but if it carried shouldAddToQueue, the queue-add must still reach the server.
          if (superseded.shouldAddToQueue && superseded.item && clientRef.current) {
            execute(clientRef.current, {
              query: ADD_QUEUE_ITEM,
              variables: { item: toClimbQueueItemInput(superseded.item) },
            }).catch((err: unknown) => console.error('Failed to add superseded queue item:', err));
          }
        },
      );
    },
    [],
  );

  const mirrorCurrentClimb = useCallback(async (mirrored: boolean) => {
    if (!clientRef.current || !sessionRef.current) throw new Error('Not connected to session');
    await execute(clientRef.current, {
      query: MIRROR_CURRENT_CLIMB,
      variables: { mirrored },
    });
  }, []);

  const setQueue = useCallback(
    async (newQueue: LocalClimbQueueItem[], newCurrentClimbQueueItem?: LocalClimbQueueItem | null) => {
      if (!clientRef.current || !sessionRef.current) throw new Error('Not connected to session');
      await execute(clientRef.current, {
        query: SET_QUEUE,
        variables: {
          queue: newQueue.map(toClimbQueueItemInput),
          currentClimbQueueItem: newCurrentClimbQueueItem ? toClimbQueueItemInput(newCurrentClimbQueueItem) : undefined,
        },
      });
    },
    [],
  );

  const replaceQueueItem = useCallback(async (uuid: string, item: LocalClimbQueueItem) => {
    if (!clientRef.current || !sessionRef.current) throw new Error('Not connected to session');
    await execute(clientRef.current, {
      query: REPLACE_QUEUE_ITEM,
      variables: { uuid, item: toClimbQueueItemInput(item) },
    });
  }, []);

  const reorderQueueItem = useCallback(async (uuid: string, oldIndex: number, newIndex: number) => {
    if (!clientRef.current || !sessionRef.current) throw new Error('Not connected to session');
    await execute(clientRef.current, {
      query: REORDER_QUEUE_ITEM,
      variables: { uuid, oldIndex, newIndex },
    });
  }, []);

  const setMyPick = useCallback(async (item: LocalClimbQueueItem, correlationId?: string) => {
    if (!clientRef.current || !sessionRef.current) throw new Error('Not connected to session');
    await executeWithLatestWins(setMyPickRefs.current, { item, correlationId }, async (args) => {
      if (!clientRef.current || !sessionRef.current) throw new Error('Not connected to session');
      await execute(clientRef.current, {
        query: SET_MY_PICK,
        variables: { item: toClimbQueueItemInput(args.item), correlationId: args.correlationId },
      });
    });
  }, []);

  const claimTurn = useCallback(async (correlationId?: string) => {
    if (!clientRef.current || !sessionRef.current) throw new Error('Not connected to session');
    await execute(clientRef.current, {
      query: CLAIM_TURN,
      variables: { correlationId },
    });
  }, []);

  const yieldTurn = useCallback(async (toUserId: string, correlationId?: string) => {
    if (!clientRef.current || !sessionRef.current) throw new Error('Not connected to session');
    await execute(clientRef.current, {
      query: YIELD_TURN,
      variables: { toUserId, correlationId },
    });
  }, []);

  const clearMyPick = useCallback(async () => {
    if (!clientRef.current || !sessionRef.current) throw new Error('Not connected to session');
    await execute(clientRef.current, {
      query: CLEAR_MY_PICK,
      variables: {},
    });
  }, []);

  return {
    addQueueItem,
    removeQueueItem,
    setCurrentClimb,
    mirrorCurrentClimb,
    setQueue,
    replaceQueueItem,
    reorderQueueItem,
    setMyPick,
    claimTurn,
    yieldTurn,
    clearMyPick,
  };
}
