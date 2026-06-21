// Renderer-agnostic queue mutations — a pure factory (no React) that owns the
// setCurrentClimb coalescer and issues all queue-session mutations over an
// injected GraphQL client. `useQueueMutations` is a thin React wrapper around
// this; tests target the factory directly (node env, no renderer).
//
// Extracted from web's
// `packages/web/app/components/persistent-session/hooks/use-queue-mutations.ts`
// so web and mobile share the coalescer and the cross-session-leak guards.
// Mobile currently wires only add / remove / setCurrent (its queue-provider);
// the party-control actions are web-only until the mobile party UI lands
// (tracked in #2414). They live here as siblings so that port is a thin diff.
//
// Two platform shapes are supported via the optional `ensureReady` seam:
//   - Web (no `ensureReady`): the session is already joined. Core mutations
//     THROW 'Not connected to session' when disconnected — preserving web's
//     exact behavior.
//   - Mobile (`ensureReady` provided): the seam resolves and joins the session
//     before mutating; returning null makes the action a silent no-op (mobile
//     keeps the solo queue purely local — sessions are created only by the
//     explicit Start button / an explicit join, never lazily here).
// Party / best-effort actions (confirmClimbOnWall, reportWallDisconnect,
// setSessionBoardSerial, setSessionBoardPath) no-op on BOTH platforms when
// there is no active session.

import type { Client } from '@boardsesh/graphql-client';
import { execute } from '@boardsesh/graphql-client';
import type { ClimbQueueItemInput } from '@boardsesh/shared-schema';
import { createSetCurrentClimbCoalescer } from '@boardsesh/queue-runtime';
import {
  ADD_QUEUE_ITEM,
  REMOVE_QUEUE_ITEM,
  REORDER_QUEUE_ITEM,
  SET_CURRENT_CLIMB,
  MIRROR_CURRENT_CLIMB,
  PUBLISH_PLAYBACK_STATE,
  SET_QUEUE,
  REPLACE_QUEUE_ITEM,
  CONFIRM_CLIMB_ON_WALL,
  REPORT_WALL_DISCONNECT,
  SET_SESSION_BOARD_SERIAL,
  SET_SESSION_BOARD_PATH,
} from '@boardsesh/graphql/operations/queue-session';

export type PublishPlaybackStateInput = {
  climbUuid: string;
  frameIndex: number;
  isPlaying: boolean;
  speed: number;
  paceMs: number;
  /**
   * Stable identifier for the publishing playback engine. Used by peers to
   * suppress echoes of their own publish broadcasts (the server stamps it
   * onto `PlaybackStateChanged.clientId`).
   */
  clientId: string;
};

const NOT_CONNECTED = 'Not connected to session';

export type QueueMutationsDeps<TItem> = {
  /** Live GraphQL client getter (web: clientRef.current; mobile: getWsClient()). */
  getClient: () => Client | null;
  /** Live active-session-id getter (web: session?.id; mobile: sessionIdRef.current). */
  getSessionId: () => string | null;
  /** Platform mapper: item -> wire input (web: toClimbQueueItemInput; mobile: thin {uuid,climb}). */
  toQueueItemInput: (item: TItem) => ClimbQueueItemInput;
  /**
   * Optional session-resolution seam. When provided (mobile), it resolves and
   * joins the session before mutating, returning the resolved id (or null to
   * no-op — mobile returns null for a null `capturedSessionId`, keeping the
   * solo queue local). When ABSENT (web), core actions throw on a
   * missing/flipped session. `capturedSessionId` is the id snapshotted at the
   * call's enqueue time; null means no session existed then.
   */
  ensureReady?: (capturedSessionId: string | null) => Promise<string | null>;
  /** Sink for swallowed transport errors (best-effort actions + coalescer drains). */
  onBestEffortError?: (action: string, error: unknown) => void;
};

export type QueueMutationsActions<TItem> = {
  addQueueItem: (item: TItem, position?: number) => Promise<void>;
  removeQueueItem: (uuid: string) => Promise<void>;
  /**
   * Move a queued item from `oldIndex` to `newIndex` (positions in the full
   * queue array). Requires an existing session — never lazily creates one.
   * The server broadcasts a `QueueReordered` delta; callers optimistically
   * apply `DELTA_REORDER_QUEUE_ITEM` locally, whose uuid-at-oldIndex check
   * makes the echoed event a safe no-op.
   */
  reorderQueueItem: (uuid: string, oldIndex: number, newIndex: number) => Promise<void>;
  setCurrentClimb: (item: TItem | null, shouldAddToQueue?: boolean, correlationId?: string) => Promise<void>;
  mirrorCurrentClimb: (mirrored: boolean) => Promise<void>;
  /**
   * Broadcast a playback engine state change for a multi-frame climb so party
   * peers stay in sync. Best-effort; no-op in solo (no active session).
   */
  publishPlaybackState: (input: PublishPlaybackStateInput) => Promise<void>;
  setQueue: (queue: TItem[], currentClimbQueueItem?: TItem | null) => Promise<void>;
  replaceQueueItem: (uuid: string, item: TItem) => Promise<void>;
  /**
   * Tell the backend this client just relayed `climbUuid` to the wall over BLE
   * so it can broadcast `WallConfirmedClimb` to the other party members.
   * Best-effort: transport errors are swallowed (the BLE send already
   * succeeded). No-op in solo.
   */
  confirmClimbOnWall: (climbUuid: string) => Promise<void>;
  /**
   * Tell the backend this client's BLE link to the wall dropped, so it can
   * broadcast `WallDisconnected` and every party member turns the lightbulb
   * off. The current climb is preserved. Best-effort; no-op in solo.
   */
  reportWallDisconnect: () => Promise<void>;
  /**
   * Record the BLE serial this client paired to as the session's
   * `lastConnectedBoardSerial` so other members can auto-connect to the same
   * physical board. Best-effort; no-op in solo.
   */
  setSessionBoardSerial: (serial: string) => Promise<void>;
  /**
   * Broadcast the session's stored boardPath so every member follows the same
   * angle/route. The caller is expected to have already pushed the URL locally
   * for instant feedback. Best-effort; no-op in solo.
   */
  setSessionBoardPath: (boardPath: string) => Promise<void>;
};

export function createQueueMutations<TItem>(deps: QueueMutationsDeps<TItem>): QueueMutationsActions<TItem> {
  const { getClient, getSessionId, toQueueItemInput, ensureReady, onBestEffortError } = deps;

  type Ready = { client: Client; sessionId: string };

  // Core mutating actions. Web (no ensureReady) THROWS when disconnected;
  // mobile (ensureReady) silently no-ops by returning null. `allowCreate`
  // historically let mobile lazily create a session on add / setCurrent;
  // mobile's seam no longer creates (solo stays local), so today the flag only
  // controls whether ensureReady is consulted at all on a null captured id.
  async function resolveCore({ allowCreate }: { allowCreate: boolean }): Promise<Ready | null> {
    const client = getClient();
    const captured = getSessionId();
    if (!ensureReady) {
      if (!client || !captured) throw new Error(NOT_CONNECTED);
      return { client, sessionId: captured };
    }
    if (!client) return null;
    if (!allowCreate && !captured) return null;
    const sessionId = await ensureReady(captured);
    if (!sessionId) return null;
    return { client, sessionId };
  }

  // Party / best-effort actions: no-op on BOTH platforms when there's no active
  // session (never lazily create just to take control / confirm a wall send).
  async function resolveCurrent(): Promise<Ready | null> {
    const client = getClient();
    const captured = getSessionId();
    if (!client || !captured) return null;
    if (!ensureReady) return { client, sessionId: captured };
    const sessionId = await ensureReady(captured);
    return sessionId ? { client, sessionId } : null;
  }

  // Serialize-and-supersede SET_CURRENT_CLIMB. `getContext` snapshots the
  // session id at enqueue; the captured value flows through sendArgs /
  // sendSupersededQueueAdd so a session that flips mid-flight neither resurrects
  // a stale climb nor fires a queue-add against the wrong session.
  const coalescer = createSetCurrentClimbCoalescer<string | null, TItem>({
    getContext: () => getSessionId(),
    sendArgs: async (args, capturedSessionId) => {
      // Web intentionally broadcasts a null item to clear the current climb;
      // mobile never does, and must not lazily create a session just to send a
      // null — so only the ensureReady (mobile) path short-circuits on null.
      if (ensureReady && !args.item) return;
      const client = getClient();
      if (!client) {
        if (ensureReady) return;
        throw new Error(NOT_CONNECTED);
      }
      if (ensureReady) {
        // Mobile: a null captured id means "no session" — the seam returns
        // null and the send is dropped (solo stays local). A concrete captured
        // id that no longer matches the live session means it flipped
        // mid-flight; drop rather than apply a stale setCurrent to the new
        // session.
        const sessionId = await ensureReady(capturedSessionId);
        if (!sessionId) return;
        if (capturedSessionId !== null && getSessionId() !== capturedSessionId) return;
      } else if (!capturedSessionId || getSessionId() !== capturedSessionId) {
        // Web: already-joined, never creates — a missing OR flipped captured
        // session is fatal (throws), unlike mobile which lazily creates above.
        throw new Error(NOT_CONNECTED);
      }
      await execute(client, {
        query: SET_CURRENT_CLIMB,
        variables: {
          item: args.item ? toQueueItemInput(args.item) : null,
          shouldAddToQueue: args.shouldAddToQueue,
          correlationId: args.correlationId,
        },
      });
    },
    sendSupersededQueueAdd: async (item, capturedSessionId) => {
      const client = getClient();
      if (!client || !capturedSessionId || getSessionId() !== capturedSessionId) return;
      if (ensureReady) {
        // capturedSessionId is concrete, so this only joins — but honour a null
        // return (session ended between supersede and drain) and bail rather
        // than fire an ADD against a dead session, mirroring the sendArgs path.
        const sessionId = await ensureReady(capturedSessionId);
        if (!sessionId) return;
      }
      await execute(client, {
        query: ADD_QUEUE_ITEM,
        variables: { item: toQueueItemInput(item) },
      });
    },
    onDrainError: (error) => onBestEffortError?.('setCurrentClimb', error),
    onSupersededQueueAddError: (error) => onBestEffortError?.('addQueueItem', error),
  });

  return {
    addQueueItem: async (item, position) => {
      const ready = await resolveCore({ allowCreate: true });
      if (!ready) return;
      await execute(ready.client, {
        query: ADD_QUEUE_ITEM,
        variables: { item: toQueueItemInput(item), position },
      });
    },

    removeQueueItem: async (uuid) => {
      const ready = await resolveCore({ allowCreate: false });
      if (!ready) return;
      await execute(ready.client, { query: REMOVE_QUEUE_ITEM, variables: { uuid } });
    },

    reorderQueueItem: async (uuid, oldIndex, newIndex) => {
      const ready = await resolveCore({ allowCreate: false });
      if (!ready) return;
      await execute(ready.client, { query: REORDER_QUEUE_ITEM, variables: { uuid, oldIndex, newIndex } });
    },

    setCurrentClimb: async (item, shouldAddToQueue, correlationId) => {
      // Web throws upfront when disconnected (no ensureReady); mobile enqueues
      // and lets the coalescer's sendArgs resolve / create the session.
      if (!ensureReady && (!getClient() || !getSessionId())) {
        throw new Error(NOT_CONNECTED);
      }
      await coalescer.enqueue({ item, shouldAddToQueue, correlationId });
    },

    mirrorCurrentClimb: async (mirrored) => {
      const ready = await resolveCore({ allowCreate: false });
      if (!ready) return;
      await execute(ready.client, { query: MIRROR_CURRENT_CLIMB, variables: { mirrored } });
    },

    publishPlaybackState: async (input) => {
      // Solo (no active session): the playback engine runs entirely on the
      // local client, so there's nothing to broadcast. Silently no-op so the
      // engine can call this unconditionally on every state change.
      const ready = await resolveCurrent();
      if (!ready) return;
      try {
        await execute(ready.client, { query: PUBLISH_PLAYBACK_STATE, variables: { input } });
      } catch (error) {
        // Best-effort — losing one broadcast just means peers briefly run out
        // of sync until the next event. Don't surface to user.
        onBestEffortError?.('publishPlaybackState', error);
      }
    },

    setQueue: async (queue, currentClimbQueueItem) => {
      const ready = await resolveCore({ allowCreate: false });
      if (!ready) return;
      await execute(ready.client, {
        query: SET_QUEUE,
        variables: {
          queue: queue.map(toQueueItemInput),
          currentClimbQueueItem: currentClimbQueueItem ? toQueueItemInput(currentClimbQueueItem) : undefined,
        },
      });
    },

    replaceQueueItem: async (uuid, item) => {
      const ready = await resolveCore({ allowCreate: false });
      if (!ready) return;
      await execute(ready.client, {
        query: REPLACE_QUEUE_ITEM,
        variables: { uuid, item: toQueueItemInput(item) },
      });
    },

    confirmClimbOnWall: async (climbUuid) => {
      const ready = await resolveCurrent();
      if (!ready) return;
      try {
        await execute(ready.client, { query: CONFIRM_CLIMB_ON_WALL, variables: { climbUuid } });
      } catch (error) {
        onBestEffortError?.('confirmClimbOnWall', error);
      }
    },

    reportWallDisconnect: async () => {
      const ready = await resolveCurrent();
      if (!ready) return;
      try {
        await execute(ready.client, { query: REPORT_WALL_DISCONNECT, variables: {} });
      } catch (error) {
        onBestEffortError?.('reportWallDisconnect', error);
      }
    },

    setSessionBoardSerial: async (serial) => {
      const ready = await resolveCurrent();
      if (!ready) return;
      try {
        await execute(ready.client, { query: SET_SESSION_BOARD_SERIAL, variables: { serial } });
      } catch (error) {
        onBestEffortError?.('setSessionBoardSerial', error);
      }
    },

    setSessionBoardPath: async (boardPath) => {
      const ready = await resolveCurrent();
      if (!ready) return;
      try {
        await execute(ready.client, { query: SET_SESSION_BOARD_PATH, variables: { boardPath } });
      } catch (error) {
        onBestEffortError?.('setSessionBoardPath', error);
      }
    },
  };
}
