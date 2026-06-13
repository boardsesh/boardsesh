/**
 * Wall-driver derivation shared by web and mobile.
 *
 * Session driver ids are stable session participant ids. They are not
 * necessarily database user ids and should never be compared to a connection id
 * or feed participant user id without first mapping through the session roster.
 */
export function deriveIsDriver(args: {
  isPersistentSessionActive: boolean;
  participantId: string | null;
  driverParticipantId: string | null;
}): boolean {
  if (!args.isPersistentSessionActive) return true;
  return args.participantId !== null && args.driverParticipantId === args.participantId;
}

/**
 * Whether queue mutations should be gated to a local preview instead of
 * touching the shared session queue.
 *
 * Preview-only is a party concept: it requires at least one OTHER live
 * participant. A solo occupant always keeps full control of their own queue —
 * including a roster of 0, which happens before the JOIN resolves (e.g. an
 * offline cold-start restore that never reaches the server). The flip side of
 * that choice: a joiner whose JOIN hasn't resolved yet can mutate the party
 * queue for the sub-second window before the roster seeds.
 *
 * In a roster of 2+, a released driver (driverParticipantId null) leaves
 * everyone preview-only until someone takes wall control.
 */
export function derivePreviewOnly(args: {
  isSessionActive: boolean;
  participantId: string | null;
  driverParticipantId: string | null;
  /** Live roster size, including self. */
  sessionUserCount: number;
}): boolean {
  if (!args.isSessionActive) return false;
  if (args.sessionUserCount <= 1) return false;
  return !deriveIsDriver({
    isPersistentSessionActive: true,
    participantId: args.participantId,
    driverParticipantId: args.driverParticipantId,
  });
}

/**
 * Whether the session currently has a live BLE connection to a board — drives
 * the shared "wall connected" indicator. False when solo, no board is resolved,
 * or nobody holds the connection.
 */
export function deriveSessionWallConnected(args: {
  isPersistentSessionActive: boolean;
  wallConnectionsByBoard: Record<number, string> | null | undefined;
  boardId: number | null;
}): boolean {
  if (!args.isPersistentSessionActive || args.boardId === null) return false;
  return Boolean(args.wallConnectionsByBoard?.[args.boardId]);
}

/**
 * Whether THIS client should physically write frames to the board. The BLE
 * connection is the writer token, so:
 *  - solo (no session) or no resolved board → always write (no election);
 *  - in a session with a resolved board, write only when this client holds the
 *    connection slot. Until a holder is recorded, fall back to "write" so a
 *    session whose holder hasn't propagated yet never goes write-less.
 */
export function deriveIsWallWriter(args: {
  isPersistentSessionActive: boolean;
  participantId: string | null;
  wallConnectionsByBoard: Record<number, string> | null | undefined;
  boardId: number | null;
}): boolean {
  if (!args.isPersistentSessionActive || args.boardId === null) return true;
  const holder = args.wallConnectionsByBoard?.[args.boardId];
  if (!holder) return true;
  return args.participantId !== null && holder === args.participantId;
}
