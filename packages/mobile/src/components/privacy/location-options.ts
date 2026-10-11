import type { PrivacyLocationAudience } from '@boardsesh/graphql/operations/privacy';

/**
 * The exact-location choices a board owner is offered, in display order.
 *
 * Followers is not one of them: on a public account follows are approved
 * automatically, so it would show the address to anyone who taps Follow, and
 * the server stores a followers choice as invited people. A board that already
 * carries it keeps the button so its owner can see the current choice and move
 * off it.
 */
export function locationOptions(current: PrivacyLocationAudience): PrivacyLocationAudience[] {
  return current === 'followers' ? ['only_me', 'followers', 'members', 'public'] : ['only_me', 'members', 'public'];
}
