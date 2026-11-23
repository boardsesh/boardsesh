'use client';

import { useEffect, useRef } from 'react';
import type { GymClaimPlacement } from '@boardsesh/analytics';

/**
 * One claim flow per gym page, many ways in: the call-out (once in the details
 * column, once above the boards on a phone) and "Run this gym? Claim it" under
 * the H1. `GymClaimCta` owns the dialog and the sign-in hop; every other entry
 * point asks it to start, naming where the tap happened for `Gym Claim CTA
 * Clicked`. A module-level set rather than a context, so each entry point stays
 * its own small island inside server-rendered markup (the report buttons on the
 * same page do the same, `gym-report-problem.tsx`).
 */
type GymClaimListener = (gymUuid: string, placement: GymClaimPlacement) => void;
const gymClaimListeners = new Set<GymClaimListener>();

export function requestGymClaim(gymUuid: string, placement: GymClaimPlacement): void {
  for (const listener of gymClaimListeners) listener(gymUuid, placement);
}

/** Start the claim when an entry point asks for this gym's. The latest handler always runs. */
export function useGymClaimRequests(gymUuid: string, onRequest: (placement: GymClaimPlacement) => void): void {
  const handler = useRef(onRequest);
  handler.current = onRequest;
  useEffect(() => {
    const listener: GymClaimListener = (requestedGymUuid, placement) => {
      if (requestedGymUuid === gymUuid) handler.current(placement);
    };
    gymClaimListeners.add(listener);
    return () => {
      gymClaimListeners.delete(listener);
    };
  }, [gymUuid]);
}
