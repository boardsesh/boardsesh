/**
 * How this phone's last link to the wall ended, as `BluetoothProvider` saw it:
 * this phone let go of it, or it went on its own (board plan item 8).
 *
 * The provider notes every end before it drops the link, so by the time
 * `DriveModeWatcher` sees the link go and ends a drive as `link_dropped`, the
 * note says which kind of end it was. A hang-up or a board switch mid-drive
 * ends the drive the same way as a radio dropout, and only the dropout (or a
 * wall with no lights another climber took) is said out loud
 * (`use-board-lets-go.ts`).
 *
 * - A Bluetooth link: `deliberate` is the end's `reason === 'user'` (a hang-up,
 *   freeing the board as a drive ends, a board switch, a new connect replacing
 *   it). An unexpected drop is not deliberate.
 * - A wall with no lights: a hand-back, a board switch or the provider going
 *   away is deliberate; another climber's later hold (`taken_by_peer`) is not,
 *   and says so (`takenByPeer`).
 *
 * In memory only, and read once (`takeLinkEnd`).
 */
export type LinkEnd = {
  /** This phone let go of the link, or the app did for the climber. */
  deliberate: boolean;
  /** A wall with no lights whose hold another climber took. */
  takenByPeer: boolean;
  /** `Date.now()` when it ended. */
  at: number;
};

/**
 * How long a note answers for the link edge that follows it. The provider
 * notes the end in the same tick it drops the link, so the watcher reads it
 * within a render; a note older than this belongs to some earlier link.
 */
export const LINK_END_FRESH_MS = 5_000;

let lastLinkEnd: LinkEnd | null = null;

/** The provider's note of a link end, before it drops the link. */
export function noteLinkEnded(
  { deliberate, takenByPeer = false }: { deliberate: boolean; takenByPeer?: boolean },
  now = Date.now(),
): void {
  lastLinkEnd = { deliberate, takenByPeer, at: now };
}

/** The last link end, once: null with no note, or one older than {@link LINK_END_FRESH_MS}. */
export function takeLinkEnd(now = Date.now()): LinkEnd | null {
  const end = lastLinkEnd;
  lastLinkEnd = null;
  if (!end || now - end.at > LINK_END_FRESH_MS) return null;
  return end;
}

/** Tests only. */
export function resetLinkEndForTests(): void {
  lastLinkEnd = null;
}
