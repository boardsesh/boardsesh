import type { GymClaimViewerState } from '@boardsesh/analytics';

/**
 * Which arm of the claim call-out the server should render, if any.
 *
 * `signed-in` and `signed-out` line up 1:1 with `GymClaimViewerState`, so the
 * variant doubles as the analytics property the island reports — one decision,
 * not two that can drift.
 */
export type GymClaimCtaVariant = GymClaimViewerState | 'hidden';

/** The query param a returning signer carries back to the gym page. */
export const CLAIM_PARAM = 'claim';

/** Its only accepted value. Anything else means "don't auto-open". */
export const CLAIM_PARAM_VALUE = '1';

type ClaimCtaInputs = {
  /**
   * `gym.canClaim` from the backend. The resolver computes it as
   * `!!authenticatedUserId && …`, so it is false for every anonymous request
   * regardless of whether the gym is actually claimable.
   */
  serverCanClaim: boolean;
  /** Whether the request carried an auth cookie (`getServerAuthToken()`). */
  serverHasSession: boolean;
};

/**
 * The session cookie — not `canClaim` — decides which arm can run at all: a
 * request with no session has no signed-in viewer to gate on, and a request
 * with one has already had `canClaim` computed against the real user (owner,
 * gym admin/editor and covering community leader all come back false).
 *
 * Switched on a joined key rather than nested ifs so the four input states are
 * enumerated in one place. There is deliberately no `default` arm: the declared
 * return type makes an unhandled combination a "lacks ending return statement"
 * compile error instead of a silent `undefined`.
 */
export function resolveClaimCtaVariant({ serverCanClaim, serverHasSession }: ClaimCtaInputs): GymClaimCtaVariant {
  const inputs = `${serverCanClaim}:${serverHasSession}` as `${boolean}:${boolean}`;
  switch (inputs) {
    case 'true:true':
      // A signed-in viewer the backend says may claim this gym.
      return 'signed-in';
    case 'false:true':
      // Signed in and already covered — owner, admin/editor, community leader.
      return 'hidden';
    case 'true:false':
    // Unreachable: `canClaim` needs an authenticated user. Falls through to the
    // anonymous arm anyway, because with no session there is no signed-in
    // viewer whose dialog we could open.
    case 'false:false':
      // The case this whole flow exists for: a gym owner who just googled their
      // own gym and has never signed in.
      return 'signed-out';
  }
}

/**
 * True only for the exact scalar `'1'`. Next hands a repeated param
 * (`?claim=1&claim=1`, which a crawler or a double-appended redirect produces)
 * as an array, and an array must not auto-open a dialog.
 */
export function shouldAutoOpenClaimDialog(rawParam: string | string[] | undefined): boolean {
  return rawParam === CLAIM_PARAM_VALUE;
}

/** Where the auth flow drops the owner back: the same gym page, claim intact. */
export function buildClaimReturnPath(gymSlug: string): string {
  return `/gym/${gymSlug}?${CLAIM_PARAM}=${CLAIM_PARAM_VALUE}`;
}
