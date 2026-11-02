// When the one-shot "Long-press a climb for quick actions" tip may show on the
// Climbs list.
//
// It teaches a gesture on a climb row, so it waits for a row to exist: on a wall
// nobody has set on yet the tip pointed at nothing, and because it is marked
// seen the moment it shows, the climber never got it back once climbs arrived
// (#5960). It also yields to the board-reveal tip, the first-connect card and
// the first-connect confirmation dialog so two prompts never stack.

export function shouldShowQuickActionsTip({
  armed,
  revealTipShowing,
  connectCardVisible,
  connectConfirmationShowing,
  climbCount,
}: {
  /** Unseen on this device, and armed on focus. */
  armed: boolean;
  revealTipShowing: boolean;
  connectCardVisible: boolean;
  /** The "Connected to {{board}}" confirmation is about to show or is up (`first-connect-confirmation-presence.ts`). */
  connectConfirmationShowing: boolean;
  /** Rows currently in the list. */
  climbCount: number;
}): boolean {
  return armed && !revealTipShowing && !connectCardVisible && !connectConfirmationShowing && climbCount > 0;
}
