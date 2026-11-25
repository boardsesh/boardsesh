// Where the gym screens live, for every surface that opens them: the gym page,
// the gym map, the gym editor and the gym's insights.
//
// Each is registered twice: on the root stack (`app/gyms/...`: Home's gym map,
// Gyms you run, notifications), and as a one-line re-export in the board
// picker's own modal stack (`app/boards/gym/[gym].tsx`, `app/boards/gyms.tsx`,
// `app/boards/gyms/edit.tsx`, `app/boards/gyms/analytics.tsx`), so a push from
// inside the picker lands on top of it with a back chevron. Pushing a root copy
// from inside the picker goes wrong two ways (docs/mobile/mobile-sheets-vs-routes.md):
// it lands in a different navigator from the one the climber is looking at, and
// expo-router presents a root route with no `presentation` as a modal whenever
// a modal sits under it, so on iOS it stacks a second sheet on the picker.

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

export type GymMapHref = {
  pathname: '/gyms' | '/boards/gyms';
  params: Record<string, string>;
};

/**
 * The gym map. Inside the picker it is the picker's own copy, a map card over
 * the list (no second draggable panel inside the sheet); on the root stack the
 * full-screen map with its panel.
 */
export function gymMapHref(stack: GymPageStack, params: Record<string, string> = {}): GymMapHref {
  return { pathname: stack === 'boards' ? '/boards/gyms' : '/gyms', params };
}

export type GymEditHref = {
  pathname: '/gyms/edit' | '/boards/gyms/edit';
  params: { gymUuid: string };
};

/** The gym editor (details, hours, who can edit), in the opener's stack. */
export function gymEditHref(gymUuid: string, stack: GymPageStack): GymEditHref {
  return { pathname: stack === 'boards' ? '/boards/gyms/edit' : '/gyms/edit', params: { gymUuid } };
}

export type GymAnalyticsHref = {
  pathname: '/gyms/analytics' | '/boards/gyms/analytics';
  params: { gymUuid: string };
};

/** The gym's insights for its staff, in the opener's stack. */
export function gymAnalyticsHref(gymUuid: string, stack: GymPageStack): GymAnalyticsHref {
  return { pathname: stack === 'boards' ? '/boards/gyms/analytics' : '/gyms/analytics', params: { gymUuid } };
}
