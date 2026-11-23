import type { GymClaimViewerState } from '@boardsesh/analytics';
import type { GymListingState } from '@boardsesh/shared-schema';

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
   * Who runs the listing (`gym.listingState`), the same for every viewer
   * (docs/product/gym-board-governance.md, decision 4).
   */
  listingState: GymListingState;
};

/**
 * Who runs the listing decides whether a claim is on offer at all; the session
 * cookie, not `canClaim`, then decides which arm.
 *
 * - **Run by the gym** (an approved claim or an admin handover): hidden for
 *   everyone. Its staff are named on the page, and an ownership dispute goes
 *   through Report a problem, which reaches our team.
 * - **Added by a climber** or **not claimed yet**: open. Signed in, `canClaim`
 *   is the whole answer (owner, gym admin/editor and covering community leader
 *   all come back false). Signed out, the anonymous arm shows: the gym's staff
 *   who just googled their gym have never signed in, and a gym a climber minted
 *   while setting up their board is exactly the listing they need to take over.
 *   Before `listingState`, a climber-listed gym counted as claimed and hid the
 *   anonymous arm.
 *
 * Switched on the listing state with no `default`, so a fourth state is a
 * compile error here instead of a silent `undefined`.
 */
export function resolveClaimCtaVariant({
  serverCanClaim,
  serverHasSession,
  listingState,
}: ClaimCtaInputs): GymClaimCtaVariant {
  switch (listingState) {
    case 'RUN_BY_GYM':
      return 'hidden';
    case 'CLIMBER_LISTED':
    case 'UNCLAIMED':
      if (serverHasSession) return serverCanClaim ? 'signed-in' : 'hidden';
      return 'signed-out';
  }
}

/**
 * The listing state, read defensively: a gym from a backend that doesn't answer
 * `listingState` falls back to the old two-state reading, where any real owner
 * reads as running it (the conservative side: no claim offered to strangers).
 */
export function gymListingStateOf(gym: { listingState?: GymListingState | null; isClaimed: boolean }): GymListingState {
  return gym.listingState ?? (gym.isClaimed ? 'RUN_BY_GYM' : 'UNCLAIMED');
}

/**
 * What the gym page puts where the claim call-out goes: the call-out itself, an
 * "under review" notice for a claimant who already filed, or nothing.
 *
 * The `cta` arm carries the viewer state the island needs, so the page renders
 * one decision instead of re-deriving (and possibly contradicting) it — and so
 * `hidden`, which is not a viewer state, can't reach the island at all.
 */
export type GymClaimSurface =
  | { kind: 'cta'; viewerState: GymClaimViewerState }
  | { kind: 'pending' }
  | { kind: 'none' };

/**
 * A claimant who already submitted must not be shown the CTA again — `canClaim`
 * is a pure permission bit and knows nothing about claims in flight, so before
 * `myPendingClaim` existed the same person could keep re-submitting into a
 * queue they were already in, with nothing on the page acknowledging it.
 *
 * The pending claim only matters on the `signed-in` arm: a pending claim needs a
 * claimant, and `hidden` means the viewer now covers the gym anyway (an admin
 * granted them access while the claim sat in the queue), where a review notice
 * would be stale.
 */
export function resolveClaimSurface({
  variant,
  gymIsPublic,
  hasPendingClaim,
}: {
  variant: GymClaimCtaVariant;
  /** Claims are for public listings only — the backend rejects the rest. */
  gymIsPublic: boolean;
  /** Whether `gym.myPendingClaim` came back non-null for this viewer. */
  hasPendingClaim: boolean;
}): GymClaimSurface {
  if (!gymIsPublic) return { kind: 'none' };
  if (variant === 'hidden') return { kind: 'none' };
  if (variant === 'signed-in' && hasPendingClaim) return { kind: 'pending' };
  return { kind: 'cta', viewerState: variant };
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
