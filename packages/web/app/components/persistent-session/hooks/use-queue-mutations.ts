import { useCallback, useMemo, useRef } from 'react';
import { createSetCurrentClimbCoalescer } from '@boardsesh/queue-runtime';
import { type Client, execute } from '../../graphql-queue/graphql-client';
import {
  ADD_QUEUE_ITEM,
  REMOVE_QUEUE_ITEM,
  SET_CURRENT_CLIMB,
  MIRROR_CURRENT_CLIMB,
  SET_QUEUE,
  REPLACE_QUEUE_ITEM,
  TAKE_CONTROL,
  RELEASE_CONTROL,
  CONFIRM_CLIMB_ON_WALL,
  SET_SESSION_BOARD_SERIAL,
  SET_SESSION_BOARD_PATH,
} from '@boardsesh/graphql/operations/queue-session';
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
  /**
   * Claim wall-control authority in the current party session, optionally
   * broadcasting a climb. Yank-on-press server-side. In solo (no active party
   * session) the call is a backend no-op — the helper still resolves so callers
   * can use `takeControl(climb)` as a drop-in for `setCurrentClimb(climb)`.
   */
  takeControl: (climb?: LocalClimbQueueItem | null) => Promise<void>;
  /**
   * Release wall-control authority. Idempotent — no-op when the local user
   * isn't currently the driver. In solo, also a backend no-op.
   */
  releaseControl: () => Promise<void>;
  /**
   * Tell the backend that this client's phone has just relayed `climbUuid` to
   * the wall over BLE. The server broadcasts a `WallConfirmedClimb` event so
   * other party participants can flip their lightbulb to "confirmed" and
   * dismiss their fallback timer. No-op in solo (no session) — solo drives the
   * local wall-confirm bus directly from `BluetoothAutoSender`.
   */
  confirmClimbOnWall: (climbUuid: string) => Promise<void>;
  /**
   * Record the BLE serial this client just paired to as the session's
   * `lastConnectedBoardSerial`. Other mobile participants can use the
   * broadcast `SessionBoardSerialChanged` to auto-connect to the same
   * physical board. No-op in solo.
   */
  setSessionBoardSerial: (serial: string) => Promise<void>;
  /**
   * Update the session's stored boardPath so every member follows the
   * same angle (and any future presentational route-segment changes).
   * The local caller is expected to have already pushed the URL
   * optimistically via `router.push` for instant feedback; this
   * broadcasts the change to the rest of the session. No-op in solo.
   */
  setSessionBoardPath: (boardPath: string) => Promise<void>;
};

export function useQueueMutations({ client, session }: UseQueueMutationsArgs): QueueMutationsActions {
  // Use refs so callbacks have stable identity (never recreate)
  const clientRef = useRef(client);
  const sessionRef = useRef(session);
  clientRef.current = client;
  sessionRef.current = session;

  const addQueueItem = useCallback(async (item: LocalClimbQueueItem, position?: number) => {
    if (!clientRef.current || !sessionRef.current?.id) throw new Error('Not connected to session');
    await execute(clientRef.current, {
      query: ADD_QUEUE_ITEM,
      variables: { item: toClimbQueueItemInput(item), position },
    });
  }, []);

  const removeQueueItem = useCallback(async (uuid: string) => {
    if (!clientRef.current || !sessionRef.current?.id) throw new Error('Not connected to session');
    await execute(clientRef.current, {
      query: REMOVE_QUEUE_ITEM,
      variables: { uuid },
    });
  }, []);

  // Coalescer is stable for the hook's lifetime; it reads clientRef/sessionRef
  // at send time so locale changes (or any other rerender) don't reset the
  // inFlight/pending state mid-session.
  const setCurrentClimbCoalescer = useMemo(
    () =>
      createSetCurrentClimbCoalescer({
        sendArgs: async (args) => {
          if (!clientRef.current || !sessionRef.current?.id) throw new Error('Not connected to session');
          await execute(clientRef.current, {
            query: SET_CURRENT_CLIMB,
            variables: {
              item: args.item ? toClimbQueueItemInput(args.item) : null,
              shouldAddToQueue: args.shouldAddToQueue,
              correlationId: args.correlationId,
            },
          });
        },
        sendSupersededQueueAdd: async (item) => {
          if (!clientRef.current) return;
          await execute(clientRef.current, {
            query: ADD_QUEUE_ITEM,
            variables: { item: toClimbQueueItemInput(item) },
          });
        },
      }),
    [],
  );

  const setCurrentClimb = useCallback(
    async (item: LocalClimbQueueItem | null, shouldAddToQueue?: boolean, correlationId?: string) => {
      if (!clientRef.current || !sessionRef.current?.id) throw new Error('Not connected to session');
      await setCurrentClimbCoalescer.enqueue({ item, shouldAddToQueue, correlationId });
    },
    [setCurrentClimbCoalescer],
  );

  const mirrorCurrentClimb = useCallback(async (mirrored: boolean) => {
    if (!clientRef.current || !sessionRef.current?.id) throw new Error('Not connected to session');
    await execute(clientRef.current, {
      query: MIRROR_CURRENT_CLIMB,
      variables: { mirrored },
    });
  }, []);

  const setQueue = useCallback(
    async (newQueue: LocalClimbQueueItem[], newCurrentClimbQueueItem?: LocalClimbQueueItem | null) => {
      if (!clientRef.current || !sessionRef.current?.id) throw new Error('Not connected to session');
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
    if (!clientRef.current || !sessionRef.current?.id) throw new Error('Not connected to session');
    await execute(clientRef.current, {
      query: REPLACE_QUEUE_ITEM,
      variables: { uuid, item: toClimbQueueItemInput(item) },
    });
  }, []);

  const takeControl = useCallback(async (climb?: LocalClimbQueueItem | null) => {
    if (!clientRef.current || !sessionRef.current?.id) {
      // Solo (no active party session). The backend has nothing to track —
      // resolve silently so the QueueContext takeControl helper can degrade
      // cleanly to setCurrentClimb's local-only path.
      return;
    }
    await execute(clientRef.current, {
      query: TAKE_CONTROL,
      variables: { climb: climb ? toClimbQueueItemInput(climb) : null },
    });
  }, []);

  const releaseControl = useCallback(async () => {
    if (!clientRef.current || !sessionRef.current?.id) return;
    await execute(clientRef.current, {
      query: RELEASE_CONTROL,
      variables: {},
    });
  }, []);

  const confirmClimbOnWall = useCallback(async (climbUuid: string) => {
    const session = sessionRef.current;
    // Solo or pre-connect: nothing to broadcast to. The local wall-confirm bus
    // is fed directly by `BluetoothAutoSender` for solo's drawer timer.
    if (!clientRef.current || !session?.id) return;
    try {
      // The mutation now resolves session identity from the WebSocket context
      // (WS-implicit pattern shared with takeControl / releaseControl) and
      // returns the resolved Session. We discard the response — future tracks
      // can wire it up for optimistic UI.
      await execute(clientRef.current, {
        query: CONFIRM_CLIMB_ON_WALL,
        variables: { climbUuid },
      });
    } catch (error) {
      // Confirmation is best-effort — the BLE send already succeeded by the
      // time we get here, so swallow transport errors rather than surfacing
      // them to the user.
      console.error('Failed to broadcast wall confirmation:', error);
    }
  }, []);

  const setSessionBoardSerial = useCallback(async (serial: string) => {
    const session = sessionRef.current;
    if (!clientRef.current || !session?.id) return;
    try {
      // WS-implicit pattern: session identity comes from the connection
      // context, not an explicit argument. Returns Session! which we discard
      // here (optimistic-UI wiring is a follow-up).
      await execute(clientRef.current, {
        query: SET_SESSION_BOARD_SERIAL,
        variables: { serial },
      });
    } catch (error) {
      console.error('Failed to set session board serial:', error);
    }
  }, []);

  const setSessionBoardPath = useCallback(async (boardPath: string) => {
    const session = sessionRef.current;
    if (!clientRef.current || !session?.id) return;
    try {
      // WS-implicit pattern. Best-effort: the local router.push has already
      // happened for instant feedback; this only affects other members.
      // Swallow errors rather than disrupting the user's local navigation.
      await execute(clientRef.current, {
        query: SET_SESSION_BOARD_PATH,
        variables: { boardPath },
      });
    } catch (error) {
      console.error('Failed to set session board path:', error);
    }
  }, []);

  return {
    addQueueItem,
    removeQueueItem,
    setCurrentClimb,
    mirrorCurrentClimb,
    setQueue,
    replaceQueueItem,
    takeControl,
    releaseControl,
    confirmClimbOnWall,
    setSessionBoardSerial,
    setSessionBoardPath,
  };
}
