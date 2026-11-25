// One `Board Builder Abandoned` per create flow (#8151).
//
// The gym-first flow stacks up to three screens: "Where's this board?", the gym
// search or wall list, then the builder. Each reports the climber leaving it
// without a board, but a climber who backs out of all three has abandoned once,
// not three times, and a climber who followed a wall from the list or saved a
// board has not abandoned at all, even though every screen unmounts when the
// modal closes.
//
// So each screen takes a ticket when it mounts, and on unmount reports only if
// nothing ended the flow since: a board secured, or a deeper screen that
// already reported. Module state, because the screens share no React parent
// below the boards stack; a counter rather than a clock, so two events in one
// millisecond still order.

let sequence = 0;
let lastEndedAt = 0;

/** Taken when a create-flow screen mounts. */
export function boardFlowTicket(): number {
  sequence += 1;
  return sequence;
}

/**
 * A board was created, reused or followed: no screen in this flow was
 * abandoned. Returns an undo for a bind that then failed, so the climber who
 * leaves after it is still counted.
 */
export function noteBoardFlowSecured(): () => void {
  const previousEnd = lastEndedAt;
  sequence += 1;
  lastEndedAt = sequence;
  const securedAt = sequence;
  return () => {
    if (lastEndedAt === securedAt) lastEndedAt = previousEnd;
  };
}

/**
 * Whether the screen holding `ticket` should report its abandonment, and if so
 * marks the flow ended so the screens under it stay quiet.
 */
export function claimBoardFlowAbandonment(ticket: number): boolean {
  if (lastEndedAt > ticket) return false;
  sequence += 1;
  lastEndedAt = sequence;
  return true;
}
