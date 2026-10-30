import { useEffect, useRef, useState } from 'react';
import type { BoardHandoffRequest } from '@boardsesh/board-presence-react';
import type { BoardHandoffRequester } from '@boardsesh/shared-schema';

/**
 * How long this phone treats the board as the asker's after it let go (#7113):
 * their release wait (12 s) plus a full Bluetooth scan (15 s), rounded up. It
 * ends sooner once presence names the asker (or anyone else) as the holder.
 */
export const HANDOFF_TAKEN_OVER_HOLD_MS = 30_000;

/**
 * Request ids this app has already answered, kept across provider remounts (a
 * board switch remounts the Bluetooth provider while the presence reducer can
 * still carry the last request), so an old request never disconnects a link
 * made after it. In memory: a relaunch starts with an empty presence feed too.
 */
const answeredRequestIds = new Set<string>();

/** Tests only. */
export function resetAnsweredHandoffRequestsForTests(): void {
  answeredRequestIds.clear();
}

/**
 * Whether this phone lets go of the board for `request`. All of:
 *
 * - it is a request this app hasn't answered yet;
 * - this phone holds the Bluetooth link now;
 * - the request names the account this phone holds the board as (presence's
 *   holder while linked). The server already sends it to that account only;
 *   this keeps a second phone on the same account, which isn't linked, out;
 * - the asker is someone else, and a member of this phone's party session (the
 *   server checked that too).
 */
export function shouldReleaseForHandoff({
  request,
  isConnected,
  localHolderUserId,
  sessionMemberUserIds,
}: {
  request: BoardHandoffRequest | null;
  isConnected: boolean;
  localHolderUserId: string | null;
  sessionMemberUserIds: ReadonlySet<string> | null | undefined;
}): boolean {
  if (!request || answeredRequestIds.has(request.requestId)) return false;
  if (!isConnected || localHolderUserId === null) return false;
  if (request.holderUserId !== localHolderUserId) return false;
  if (request.requester.userId === localHolderUserId) return false;
  return sessionMemberUserIds?.has(request.requester.userId) === true;
}

export type UseBoardHandoffReleaseInput = {
  /** The latest request presence delivered to this account, or null. */
  request: BoardHandoffRequest | null;
  isConnected: boolean;
  /** The account this phone holds the board as (`useLocalBluetoothHolder`). */
  localHolderUserId: string | null;
  sessionMemberUserIds: ReadonlySet<string> | null | undefined;
  /** Presence's holder now, to see the asker take the board. */
  holderUserId: string | null;
  boardId: number | null;
  sessionId: string | null;
  /**
   * Let go of the board for `requester`: end the drive, disconnect the link
   * with the `taken_over` reason (its release report frees the board), buzz and
   * announce. The provider owns the Bluetooth side.
   */
  release: (requester: BoardHandoffRequester) => void;
};

/**
 * The holder's half of the hand-off (#7113). Answers a request once, through
 * `release`, and returns who took the board while it is still on its way to
 * them: until presence names a holder other than this account, the board or
 * session changes, this phone links again, or {@link HANDOFF_TAKEN_OVER_HOLD_MS}
 * passes.
 *
 * While it is set the board reads as the asker's, so this phone's controls relay
 * or wait instead of offering a connect that would race the asker for the radio.
 * Nothing here ever connects: the release is a deliberate teardown, which keeps
 * native adoption suppressed until the climber connects by hand.
 */
export function useBoardHandoffRelease({
  request,
  isConnected,
  localHolderUserId,
  sessionMemberUserIds,
  holderUserId,
  boardId,
  sessionId,
  release,
}: UseBoardHandoffReleaseInput): BoardHandoffRequester | null {
  const [takenOver, setTakenOver] = useState<{
    requester: BoardHandoffRequester;
    boardId: number | null;
    sessionId: string | null;
    previousHolderUserId: string;
    /** The link has gone down since; a link after that settles it. */
    linkDropped: boolean;
  } | null>(null);
  const releaseRef = useRef(release);
  releaseRef.current = release;

  useEffect(() => {
    if (!request) return;
    const releasing = shouldReleaseForHandoff({ request, isConnected, localHolderUserId, sessionMemberUserIds });
    // Answered once, acted on or not: a request that found this phone unlinked
    // must not disconnect a link made later.
    answeredRequestIds.add(request.requestId);
    if (!releasing || localHolderUserId === null) return;
    setTakenOver({
      requester: request.requester,
      boardId,
      sessionId,
      previousHolderUserId: localHolderUserId,
      linkDropped: false,
    });
    releaseRef.current(request.requester);
    // Only a new request answers; the other inputs are read at its arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // The link is still up for a beat after the release starts: only a link that
  // comes back after it went down means this phone connected again.
  useEffect(() => {
    if (takenOver && !takenOver.linkDropped && !isConnected) {
      setTakenOver({ ...takenOver, linkDropped: true });
    }
  }, [takenOver, isConnected]);

  // The asker (or anyone) holds it now, or this phone's scope changed, or it
  // linked again (a deliberate connect: nothing here connects).
  const settled =
    takenOver !== null &&
    ((holderUserId !== null && holderUserId !== takenOver.previousHolderUserId) ||
      boardId !== takenOver.boardId ||
      sessionId !== takenOver.sessionId ||
      (takenOver.linkDropped && isConnected));
  useEffect(() => {
    if (settled) setTakenOver(null);
  }, [settled]);

  const takenOverSince = takenOver?.requester ?? null;
  useEffect(() => {
    if (!takenOverSince) return undefined;
    const timer = setTimeout(() => setTakenOver(null), HANDOFF_TAKEN_OVER_HOLD_MS);
    return () => clearTimeout(timer);
  }, [takenOverSince]);

  return takenOver && !settled ? takenOver.requester : null;
}
