import { AURORA_BOARDS, type AuroraBoardName } from '@boardsesh/shared-schema';

/**
 * Pure eligibility rules for the "link your board account" prompt, kept apart from
 * the query that feeds them so they can be tested without pulling `expo-web-browser`
 * and the rest of the credential module into the graph. Same split as
 * `decideBoardLookStep`.
 */

/** MoonBoard has no credential flow at all, so it can never be "linkable". */
export function isLinkableBoard(boardType: string | undefined): boardType is AuroraBoardName {
  return !!boardType && (AURORA_BOARDS as readonly string[]).includes(boardType);
}

/**
 * Whether we can honestly tell this climber their sends are missing because no
 * board account is linked.
 *
 * `undefined` means "don't know yet", and callers must treat it as such rather
 * than as "nothing linked". React Query runs `offlineFirst` on the credentials
 * query, so an offline launch leaves it pending indefinitely — reading a pending
 * state as "no credentials" would show a climber who linked months ago a card
 * telling them to link.
 */
export function hasNoLinkedBoardAccount(
  credentials: readonly { boardType: string }[] | undefined,
): boolean | undefined {
  if (credentials === undefined) return undefined;
  return credentials.length === 0;
}
