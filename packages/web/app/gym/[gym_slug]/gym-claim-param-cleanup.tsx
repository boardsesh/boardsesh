'use client';

import { shouldAutoOpenClaimDialog } from './gym-claim-cta-logic';
import { useClaimParamStrip } from './use-claim-param-strip';

type GymClaimParamCleanupProps = {
  /** The raw `?claim=` value, straight off the server's searchParams. */
  claimParam?: string | string[];
};

/**
 * Clears a stale `?claim=1` on the pages where GymClaimCta isn't there to do
 * it: an owner or covering community leader coming back from auth (their
 * variant resolves to `hidden`, so nothing renders), and anyone opening a
 * shared claim link for a gym they can't be offered. Purely cosmetic — the
 * canonical URL never carries the param — but leaving it in the address bar
 * invites a reload that looks like the claim is still pending.
 */
export default function GymClaimParamCleanup({ claimParam }: GymClaimParamCleanupProps) {
  useClaimParamStrip(shouldAutoOpenClaimDialog(claimParam));
  return null;
}
