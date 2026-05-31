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
//   - Mobile (`ensureReady` provided): the seam resolves/lazily-creates and
//     joins the session before mutating; returning null makes the action a
//     silent no-op.
// Party / best-effort actions (takeControl, releaseControl, confirmClimbOnWall,
// setSessionBoardSerial, setSessionBoardPath) no-op on BOTH platforms when
// there is no active session.

import type { Client } from '@boardsesh/graphql-client';
import { execute } from '@boardsesh/graphql-client';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { ClimbQueueItemInput } from '@boardsesh/shared-schema';
import { createSetCurrentClimbCoalescer } from '@boardsesh/queue-runtime';
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

const NOT_CONNECTED = 'Not connected to session';

export type QueueMutationsDeps<TItem> = {
  /** Live GraphQL client getter (web: clientRef.current; mobile: getWsClient()). */
  getClient: () => Client | null;
  /** Live active-session-id getter (web: session?.id; mobile: sessionIdRef.current). */
  getSessionId: () => string | null;
  /** Platform mapper: item -> wire input (web: toClimbQueueItemInput; mobile: thin {uuid,climb}). */
  toQueueItemInput: (item: TItem) => ClimbQueueItemInput;
  /**
   * Optional session-resolution seam. When provided (mobile), it resolves /
   * lazily-creates and joins the session before mutating, returning the
   * resolved id (or null to no-op). When ABSENT (web), core actions throw on a
   * missing/flipped session. `capturedSessionId` is the id snapshotted at the
   * call's enqueue time; null means "no session yet — create one if allowed".
   */
  ensureReady?: (capturedSessionId: string | null) => Promise<string | null>;
  /** Sink for swallowed transport errors (best-effort actions + coalescer drains). */
  onBestEffortError?: (action: string, error: unknown) => void;
};

export type QueueMutationsActions<TItem> = {
  addQueueItem: (item: TItem, position?: number) => Promise<void>;
  removeQueueItem: (uuid: string) => Promise<void>;
  setCurrentClimb: (item: TItem | null, shouldAddToQueue?: boolean, correlationId?: string) => Promise<void>;
  mirrorCurrentClimb: (mirrored: boolean) => Promise<void>;
  setQueue: (queue: TItem[], currentClimbQueueItem?: TItem | null) => Promise<void>;
  replaceQueueItem: (uuid: string, item: TItem) => Promise<void>;
  /**
   * Claim wall-control authority in the current party session, optionally
   * broadcasting a climb. Yank-on-press server-side. In solo (no active
   * session) it's a backend no-op that still resolves, so callers can use
   * `takeControl(climb)` as a drop-in for `setCurrentClimb(climb)`.
   */
  takeControl: (climb?: TItem | null) => Promise<void>;
  /**
   * Release wall-control authority. Idempotent — no-op when the local user
   * isn't the driver. Backend no-op in solo.
   */
  releaseControl: () => Promise<void>;
  /**
   * Tell the backend this client just relayed `climbUuid` to the wall over BLE
   * so it can broadcast `WallConfirmedClimb` to the other party members.
   * Best-effort: transport errors are swallowed (the BLE send already
   * succeeded). No-op in solo.
   */
  confirmClimbOnWall: (climbUuid: string) => Promise<void>;
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
  // controls whether mobile may lazily create a session (add / setCurrent) vs
  // requires an existing one (remove / mirror / setQueue / replace).
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
  const coalescer = createSetCurrentClimbCoalescer<string | null>({
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
        // Mobile: a null captured id means "no session yet" — ensureReady
        // creates one. A concrete captured id that no longer matches the live
        // session means it flipped mid-flight; drop rather than apply a stale
        // setCurrent to the new session.
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
          // The coalescer is typed on the shared @boardsesh/queue ClimbQueueItem,
          // but only TItem is ever enqueued here, so casting back to TItem before
          // the platform mapper is sound (web's LocalClimbQueueItem and mobile's
          // shared item are both structurally compatible with that type).
          item: args.item ? toQueueItemInput(args.item as unknown as TItem) : null,
          shouldAddToQueue: args.shouldAddToQueue,
          correlationId: args.correlationId,
        },
      });
    },
    sendSupersededQueueAdd: async (item, capturedSessionId) => {
      const client = getClient();
      if (!client || !capturedSessionId || getSessionId() !== capturedSessionId) return;
      // capturedSessionId is concrete here, so ensureReady only joins (no create).
      if (ensureReady) await ensureReady(capturedSessionId);
      // Same enqueue-only-TItem invariant as sendArgs — the cast is sound.
      await execute(client, {
        query: ADD_QUEUE_ITEM,
        variables: { item: toQueueItemInput(item as unknown as TItem) },
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

    setCurrentClimb: async (item, shouldAddToQueue, correlationId) => {
      // Web throws upfront when disconnected (no ensureReady); mobile enqueues
      // and lets the coalescer's sendArgs resolve / create the session.
      if (!ensureReady && (!getClient() || !getSessionId())) {
        throw new Error(NOT_CONNECTED);
      }
      await coalescer.enqueue({
        item: item as unknown as ClimbQueueItem | null,
        shouldAddToQueue,
        correlationId,
      });
    },

    mirrorCurrentClimb: async (mirrored) => {
      const ready = await resolveCore({ allowCreate: false });
      if (!ready) return;
      await execute(ready.client, { query: MIRROR_CURRENT_CLIMB, variables: { mirrored } });
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

    takeControl: async (climb) => {
      const ready = await resolveCurrent();
      if (!ready) return;
      await execute(ready.client, {
        query: TAKE_CONTROL,
        variables: { climb: climb ? toQueueItemInput(climb) : null },
      });
    },

    releaseControl: async () => {
      const ready = await resolveCurrent();
      if (!ready) return;
      await execute(ready.client, { query: RELEASE_CONTROL, variables: {} });
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
