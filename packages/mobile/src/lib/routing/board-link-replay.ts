// Whether this sign-in is opening a board or climb link that was tapped while
// signed out (#6027).
//
// Two components need to agree on it. The deep-link provider reads the stashed
// link after sign-in and opens it. The onboarding gate, a moment later, decides
// whether a new account with no board gets the first-board picker, and that
// picker is pushed on top of whatever is on screen. The gate stands down for a
// launch URL and for the route groups in `DEEP_LINK_SEGMENTS`, but a replayed
// climb is neither: the link was tapped while the app was already open, so
// there is no launch URL, and it lands on `/kilter/…` or `/b/…`. Without this
// the climber who signed up to see a shared climb got "Where do you climb?"
// over it.
//
// The provider hands over the promise of its read, not a flag set after it, so
// the gate cannot decide in the gap between the read starting and the route
// opening. Module state, because the two sit far apart in the tree and the
// provider remounts on every sign-in.

let replay: Promise<boolean> | null = null;

/**
 * The provider's read of the stash for this sign-in: resolves true when it
 * opened a board link. Each sign-in replaces the last one's answer.
 */
export function setBoardLinkReplay(pending: Promise<boolean>): void {
  replay = pending;
}

/** Signed out, or nothing to replay: the next sign-in starts from "no". */
export function clearBoardLinkReplay(): void {
  replay = null;
}

/** True when this sign-in opened a stashed board link. Never rejects. */
export async function didReplayBoardLink(): Promise<boolean> {
  if (!replay) return false;
  try {
    return await replay;
  } catch {
    return false;
  }
}
