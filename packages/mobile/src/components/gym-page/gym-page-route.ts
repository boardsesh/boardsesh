// Where the gym page lives, for every surface that opens it.
//
// The page is registered twice: `app/gyms/[gym].tsx` on the root stack (the gym
// map, Gyms you run, notifications), and a one-line re-export at
// `app/boards/gym/[gym].tsx` so the board picker pushes it inside its own modal
// stack, with a back chevron to the picker. Pushing the root copy from inside
// the picker would put it in a different navigator from the one the climber is
// looking at (docs/mobile/mobile-sheets-vs-routes.md, the cross-navigator trap).

/** Which stack the opener is standing in. */
export type GymPageStack = 'root' | 'boards';

/** `?claim=denied`: opened from a "we couldn't confirm you run it" notice. */
export const GYM_PAGE_CLAIM_DENIED = 'denied';

export type GymPageHref = {
  pathname: '/gyms/[gym]' | '/boards/gym/[gym]';
  params: { gym: string; returnTo?: string; claim?: typeof GYM_PAGE_CLAIM_DENIED };
};

/**
 * The gym page for a gym uuid. `returnTo` is the tab a board picked on the page
 * returns to; the board picker forwards its own so a pick lands where the picker
 * was opened from. Absent, the page returns to Climbs. `claimDenied` opens the
 * page on the claimant's denial card, with a way to try again.
 */
export function gymPageHref(
  gymUuid: string,
  stack: GymPageStack = 'root',
  returnTo?: string,
  options: { claimDenied?: boolean } = {},
): GymPageHref {
  return {
    pathname: stack === 'boards' ? '/boards/gym/[gym]' : '/gyms/[gym]',
    params: {
      gym: gymUuid,
      ...(returnTo ? { returnTo } : {}),
      ...(options.claimDenied ? { claim: GYM_PAGE_CLAIM_DENIED } : {}),
    },
  };
}

/** Which stack a route's segments stand in: the board picker's modal stack, or the root one. */
export function gymPageStackForSegments(segments: readonly string[]): GymPageStack {
  return segments[0] === 'boards' ? 'boards' : 'root';
}
