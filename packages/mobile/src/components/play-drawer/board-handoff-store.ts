/**
 * The asking phone's half of taking a crewmate's board (#7113): after
 * `requestBoardHandoff`, wait for presence to show the board let go before
 * connecting. Aurora and MoonBoard boxes stop advertising once linked, and
 * Android refuses a second phone, so a connect before the holder's phone lets
 * go only scans for 15 s and fails.
 *
 * In memory, one wait at a time. `DriveModeWatcher` (app root) feeds it
 * presence's holder, so the wait resolves with the player closed too, and
 * cancels it when the drive ends for another reason.
 */

/**
 * How long the asking phone waits for the holder's phone to let go. Their phone
 * answers in well under a second when it is online; past this it is offline,
 * backgrounded with its socket suspended, or on an app that doesn't know the
 * request, and the swipe springs back with "Couldn't reach the board".
 */
export const HANDOFF_RELEASE_TIMEOUT_MS = 12_000;

export type BoardReleaseOutcome = 'released' | 'timed_out' | 'cancelled';

/** Presence's holder as `DriveModeWatcher` last saw it, with its connection seq. */
export type NotedBoardHolder = {
  holder: { userId?: string | null } | null;
  /** `lastConnectionSeq`: 0 until a holder event (live or catch-up) arrived. */
  connectionSeq: number;
};

/**
 * The board counts as let go once presence has heard a holder event (so a
 * `null` holder means free, not "not seeded yet") and its holder is no longer
 * the account that was asked: free, or anyone else.
 */
export function isBoardReleasedBy(askedHolderUserId: string, noted: NotedBoardHolder | null): boolean {
  if (noted === null || noted.connectionSeq <= 0) return false;
  return noted.holder === null || noted.holder.userId !== askedHolderUserId;
}

type PendingRelease = {
  holderUserId: string;
  resolve: (outcome: BoardReleaseOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
};

let pending: PendingRelease | null = null;
/**
 * What `DriveModeWatcher` last saw. Read when a wait starts, so a release that
 * landed while the request was in flight (and so never changes the holder
 * again) still counts.
 */
let lastNoted: NotedBoardHolder | null = null;

function settle(outcome: BoardReleaseOutcome): void {
  const waiting = pending;
  if (!waiting) return;
  pending = null;
  clearTimeout(waiting.timer);
  waiting.resolve(outcome);
}

/**
 * Wait for `holderUserId` to let go of the board. Resolves at once when
 * presence already shows it gone. A newer wait cancels an older one.
 */
export function waitForBoardRelease({
  holderUserId,
  timeoutMs = HANDOFF_RELEASE_TIMEOUT_MS,
}: {
  holderUserId: string;
  timeoutMs?: number;
}): Promise<BoardReleaseOutcome> {
  settle('cancelled');
  if (isBoardReleasedBy(holderUserId, lastNoted)) return Promise.resolve('released');
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle('timed_out'), timeoutMs);
    pending = { holderUserId, resolve, timer };
  });
}

/** Presence's holder or its connection seq changed: release the wait once the asked holder is gone. */
export function noteBoardHolder(noted: NotedBoardHolder): void {
  lastNoted = noted;
  if (pending && isBoardReleasedBy(pending.holderUserId, noted)) settle('released');
}

/** The drive ended some other way: stop waiting. */
export function cancelBoardReleaseWait(): void {
  settle('cancelled');
}

export function isWaitingForBoardRelease(): boolean {
  return pending !== null;
}

/** Tests only: no wait, no holder seen. */
export function resetBoardHandoffStoreForTests(): void {
  settle('cancelled');
  lastNoted = null;
}
