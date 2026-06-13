import type { ConnectionContext, ClimbQueueItem, SessionUser } from '@boardsesh/shared-schema';
import { roomManager } from '../../../services/room-manager';
import type { Session as SessionDbRow } from '../../../db/schema';

/**
 * The trimmed `queueState` shape that every Session-returning resolver
 * embeds. Matches the GraphQL `QueueState` type; deliberately omits the
 * RoomManager-internal `version` field which never flows to the wire.
 */
type SessionQueueState = {
  sequence: number;
  stateHash: string;
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
};

/**
 * Optional pre-resolved values that callers pass in to skip the helper's
 * internal Redis lookups. Used when the resolver already knows a field —
 * `joinSession` has fresh `users`/`queueState`/`name`; `takeControl` knows
 * the driver it just wrote; `releaseControl` knows `null` after a successful
 * clear.
 *
 * Convention: an explicit `null` (or any value) is a real override and skips
 * the fetch. `undefined` (or key absent) triggers the fetch. So pre-resolved
 * but legitimately-null values like `driverParticipantId: null` from
 * `releaseControl` are honoured, while `name: undefined` still defers to
 * `sessionData.name`.
 */
export type SessionPayloadInputs = {
  users?: SessionUser[];
  queueState?: SessionQueueState;
  sessionData?: SessionDbRow | null;
  driverParticipantId?: string | null;
  wallConnections?: { boardId: number; holderParticipantId: string }[];
  lastConnectedBoardSerial?: string | null;
  leaderConnectionId?: string | null;
  name?: string | null;
  boardPath?: string;
  isLeader?: boolean;
  clientId?: string | null;
  participantId?: string;
};

/**
 * Use the caller-supplied override when present (including legitimate-null
 * values like a freshly-cleared driver), otherwise lazily run the fetcher.
 * Keeps `Promise.all` callsites readable — `inputs.X !== undefined ?
 * Promise.resolve(inputs.X) : roomManager.getX(...)` repeated six times is
 * mostly punctuation.
 */
function override<T>(value: T | undefined, fetch: () => Promise<T>): Promise<T> {
  return value !== undefined ? Promise.resolve(value) : fetch();
}

/**
 * Build the 17-field Session GraphQL payload, fanning the four-to-seven
 * independent Redis reads into a single `Promise.all`. Replaces the verbatim
 * `id`/`name`/`boardPath`/`users`/`queueState`/`isLeader`/...-shaped return
 * objects in every Session-returning resolver. Pass `inputs.X` to short-
 * circuit a specific lookup when the caller already has the value.
 */
export async function buildSessionPayload(
  sessionId: string,
  ctx: ConnectionContext,
  inputs: SessionPayloadInputs = {},
) {
  // `leaderConnectionId` only feeds the `isLeader` computation. When the
  // caller already knows `isLeader` (joinSession, queries.session), the
  // fetched value would be discarded — short-circuit to skip the Redis
  // round-trip entirely. Otherwise fall through to the standard override
  // path (with `inputs.leaderConnectionId` honoured if supplied).
  const leaderFetch =
    inputs.isLeader !== undefined
      ? Promise.resolve<string | null>(null)
      : override(inputs.leaderConnectionId, () => roomManager.getSessionLeaderConnectionId(sessionId));

  const [
    users,
    queueState,
    sessionData,
    driverParticipantId,
    lastConnectedBoardSerial,
    leaderConnectionId,
    wallConnections,
  ] = await Promise.all([
    override(inputs.users, () => roomManager.getSessionUsers(sessionId)),
    override(inputs.queueState, () => roomManager.getQueueState(sessionId)),
    override(inputs.sessionData, () => roomManager.getSessionById(sessionId)),
    override(inputs.driverParticipantId, () => roomManager.getSessionDriverParticipantId(sessionId)),
    override(inputs.lastConnectedBoardSerial, () => roomManager.getSessionBoardSerial(sessionId)),
    leaderFetch,
    override(inputs.wallConnections, () =>
      roomManager
        .getWallConnections(sessionId)
        .then((map) => Array.from(map, ([boardId, holderParticipantId]) => ({ boardId, holderParticipantId }))),
    ),
  ]);

  return {
    id: sessionId,
    // `|| null` (not `??`) on the nullable-string fallback keeps parity with
    // the pre-helper resolvers, which all coerced empty string to null.
    // Treats `sessionData.name === ''` the same as `name === null` —
    // consistent with the `goal` / `color` fields a few lines below.
    name: inputs.name !== undefined ? inputs.name : sessionData?.name || null,
    boardPath: inputs.boardPath !== undefined ? inputs.boardPath : sessionData?.boardPath || '',
    users,
    queueState: {
      sequence: queueState.sequence,
      stateHash: queueState.stateHash,
      queue: queueState.queue,
      currentClimbQueueItem: queueState.currentClimbQueueItem,
    },
    isLeader: inputs.isLeader !== undefined ? inputs.isLeader : leaderConnectionId === ctx.connectionId,
    driverParticipantId,
    wallConnections,
    lastConnectedBoardSerial,
    clientId: inputs.clientId !== undefined ? inputs.clientId : ctx.connectionId,
    participantId: inputs.participantId ?? ctx.participantId ?? ctx.connectionId ?? '',
    goal: sessionData?.goal || null,
    // `isPublic` defaults to `true` when `sessionData` is null. The null path
    // is a brief race during session cleanup (the in-memory session still
    // exists but the DB row has just been deleted) — defaulting open here
    // matches the pre-helper behaviour every Session-returning resolver used.
    // Don't "fix" this to `false`: it would flip visibility for any live
    // subscriber that observes a Session payload during the cleanup window.
    isPublic: sessionData?.isPublic ?? true,
    startedAt: sessionData?.startedAt?.toISOString() || null,
    endedAt: sessionData?.endedAt?.toISOString() || null,
    isPermanent: sessionData?.isPermanent ?? false,
    color: sessionData?.color || null,
  };
}
