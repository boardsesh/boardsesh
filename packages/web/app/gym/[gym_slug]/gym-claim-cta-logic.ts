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
  /**
   * `gym.isClaimed` — viewer-independent, `ownerId !== SYSTEM_BOARD_OWNER_ID`
   * on the backend. Gates the anonymous arm only: "Is this your gym?" under the
   * displayed name of the person who already runs it reads as a mistake.
   */
  gymIsClaimed: boolean;
};

/**
 * The session cookie — not `canClaim` — decides which arm can run at all: a
 * request with no session has no signed-in viewer to gate on, and a request
 * with one has already had `canClaim` computed against the real user (owner,
 * gym admin/editor and covering community leader all come back false).
 *
 * `gymIsClaimed` only ever narrows the anonymous arm. A signed-in non-member
 * asking for a gym someone else already owns is a deliberate, long-standing
 * path — the backend routes it to admin review — so the signed-in arm ignores
 * it entirely.
 *
 * Switched on a joined key rather than nested ifs so the eight input states are
 * enumerated in one place. There is deliberately no `default` arm: the declared
 * return type makes an unhandled combination a "lacks ending return statement"
 * compile error instead of a silent `undefined`.
 */
export function resolveClaimCtaVariant({
  serverCanClaim,
  serverHasSession,
  gymIsClaimed,
}: ClaimCtaInputs): GymClaimCtaVariant {
  const inputs = `${serverCanClaim}:${serverHasSession}:${gymIsClaimed}` as `${boolean}:${boolean}:${boolean}`;
  switch (inputs) {
    // Signed in: `canClaim` is the whole answer, claimed or not.
    case 'true:true:true':
    case 'true:true:false':
      // A signed-in viewer the backend says may claim this gym.
      return 'signed-in';
    case 'false:true:true':
    case 'false:true:false':
      // Signed in and already covered — owner, admin/editor, community leader.
      return 'hidden';

    // Anonymous: the arm exists for gyms nobody has claimed yet.
    case 'true:false:false':
    // Unreachable: `canClaim` needs an authenticated user. Grouped with the
    // real anonymous case anyway, because with no session there is no
    // signed-in viewer whose dialog we could open.
    case 'false:false:false':
      // The case this whole flow exists for: a gym owner who just googled their
      // own gym and has never signed in.
      return 'signed-out';
    case 'true:false:true':
    case 'false:false:true':
      // Someone already runs this gym, and their name is on the page directly
      // above where the call-out would sit.
      return 'hidden';
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
