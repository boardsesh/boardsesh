import type { Gym } from '@boardsesh/shared-schema';

/**
 * Who can change a gym listing, as the manage page's lock state says it
 * (docs/product/gym-board-governance.md, "who can change this"):
 *
 * - `staff`: the gym's own staff run it (`RUN_BY_GYM`).
 * - `climber`: a climber added it and runs it until staff claim it; named.
 * - `climber_hidden`: the same, with their privacy keeping the name back.
 * - `unclaimed`: listed from public board data; nobody runs it yet.
 */
export type GymListingRunner = 'staff' | 'climber' | 'climber_hidden' | 'unclaimed';

export function gymListingRunner(gym: Pick<Gym, 'listingState' | 'ownerDisplayName'>): GymListingRunner {
  switch (gym.listingState) {
    case 'RUN_BY_GYM':
      return 'staff';
    case 'CLIMBER_LISTED':
      return gym.ownerDisplayName?.trim() ? 'climber' : 'climber_hidden';
    default:
      return 'unclaimed';
  }
}

/** Where "Back to {gym}" goes: the gym's page, or the directory for a slug-less legacy gym. */
export function gymPageHref(gym: Pick<Gym, 'slug'>): string {
  return gym.slug ? `/gym/${encodeURIComponent(gym.slug)}` : '/gyms';
}

/**
 * Whether the lock state may offer this viewer the claim: the server's
 * `canClaim`, and never on a gym its staff run (`RUN_BY_GYM`), which nobody can
 * claim (docs/product/gym-board-governance.md, PR 7). The server already says
 * no there; this keeps the button off for a backend that doesn't yet.
 */
export function gymClaimOpenToViewer(gym: Pick<Gym, 'canClaim' | 'listingState'>): boolean {
  return gym.canClaim && gym.listingState !== 'RUN_BY_GYM';
}
