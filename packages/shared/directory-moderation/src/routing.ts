import type { BoardReportReason, DirectoryReportRecipient, GymListingState, GymReportReason } from './reasons';

/**
 * Who a report goes to: docs/product/gym-board-governance.md, decision 2, as
 * code. The backend routes with it and the clients word "who will see this"
 * with it, so the sheet never promises a reader the server won't reach.
 *
 * | Board                    | Gym                                   | Goes to                       |
 * |--------------------------|---------------------------------------|-------------------------------|
 * | Added by a climber       | none, not claimed, or climber-listed  | the creator                   |
 * | Added by a climber       | run by the gym                        | the creator + gym staff       |
 * | Synced (SYSTEM)          | run by the gym                        | gym staff                     |
 * | Synced (SYSTEM)          | none, not claimed, or climber-listed  | the admin queue, straight away|
 * | Any, "wrong gym or place"| any                                   | as above, plus the admin queue|
 *
 * "Gym staff" is the gym's owner and admin members. The climber who owns a
 * climber-listed gym is not staff: they listed the place, they don't run it.
 *
 * Two rules sit on top of the table:
 * - A report never goes back to the person who filed it. A creator reporting
 *   their own board reaches whoever else the table names, or the admin queue
 *   when that leaves nobody.
 * - `relist_request` is the creator asking to be put back on a gym whose staff
 *   took the board off. It goes to the staff of that gym (any gym with a real
 *   owner: whoever removed it can put it back), or to the admin queue for an
 *   unclaimed gym, and never to the creator.
 */

export type BoardReportRoutingInput = {
  reason: BoardReportReason;
  /** The board belongs to the SYSTEM import account (a synced board). */
  boardOwnedBySystem: boolean;
  /** The person filing the report created the board. */
  viewerIsCreator: boolean;
  /**
   * The board is linked to a live gym. For `relist_request`, the gym in the
   * latest staff removal still exists.
   */
  hasGym: boolean;
  /** That gym's listing state; ignored without a gym. */
  gymListingState: GymListingState | null;
};

export type GymReportRoutingInput = {
  reason: GymReportReason;
  gymListingState: GymListingState;
};

export type DirectoryReportRouting = {
  /** Who hears about the report, in a fixed order: creator, gym staff, admin. */
  recipients: DirectoryReportRecipient[];
  /** The report goes to the admin queue as it opens, not after the escalation delay. */
  escalateNow: boolean;
};

const RECIPIENT_ORDER: readonly DirectoryReportRecipient[] = ['creator', 'gym_staff', 'admin'];

function routing(recipients: Iterable<DirectoryReportRecipient>): DirectoryReportRouting {
  const unique = new Set(recipients);
  if (unique.size === 0) unique.add('admin');
  const ordered = RECIPIENT_ORDER.filter((recipient) => unique.has(recipient));
  return { recipients: ordered, escalateNow: unique.has('admin') };
}

export function routeBoardReport(input: BoardReportRoutingInput): DirectoryReportRouting {
  const runByGym = input.hasGym && input.gymListingState === 'RUN_BY_GYM';

  if (input.reason === 'relist_request') {
    const gymHasStaff = input.hasGym && input.gymListingState !== null && input.gymListingState !== 'UNCLAIMED';
    return routing(gymHasStaff ? ['gym_staff'] : ['admin']);
  }

  const recipients = new Set<DirectoryReportRecipient>();
  if (input.boardOwnedBySystem) {
    recipients.add(runByGym ? 'gym_staff' : 'admin');
  } else {
    if (!input.viewerIsCreator) recipients.add('creator');
    if (runByGym) recipients.add('gym_staff');
  }
  // Wrong gym or place can be someone's home address on a public map: the
  // team looks at once, whoever else hears about it.
  if (input.reason === 'wrong_place') recipients.add('admin');
  return routing(recipients);
}

export function routeGymReport(input: GymReportRoutingInput): DirectoryReportRouting {
  // Staff can correct their own gym's details. Everything else about a gym
  // listing (a duplicate, a closure, a home wall on the map) is the team's call.
  if (input.reason === 'wrong_details' && input.gymListingState === 'RUN_BY_GYM') return routing(['gym_staff']);
  return routing(['admin']);
}
