// One decision for the whole post-session screen: does the user get the App
// Store review prompt, the offline-download prompt, or neither?
//
// Resolving `shouldRequestSessionStoreReview` ONCE and branching on the answer
// is the point. Gating the offline prompt on `isSessionStoreReviewEligible`
// instead would be wrong in the worst direction: that predicate is only
// "totalSends >= 3", while an actual review prompt needs the 90-day cooldown,
// the per-session dedup and `StoreReview.hasAction()` on top — so the offline
// prompt would go quiet on every good session, which is its entire audience,
// and fire mainly after weak ones.

import { useEffect, useState } from 'react';
import type { SessionSummary } from '@boardsesh/shared-schema';
import { SESSION_STORE_REVIEW_CANDIDATE_PARAM, shouldRequestSessionStoreReview } from '../store-review';

export type PostSessionPrompt = 'pending' | 'review' | 'offline' | 'none';

/**
 * `'pending'` until the review decision resolves, so neither prompt renders on
 * a guess. `'offline'` means the review is not going to fire — whether the
 * offline nudge itself is eligible is `useOfflineNudge`'s call.
 */
export function usePostSessionPrompt(
  summary: Pick<SessionSummary, 'sessionId' | 'totalSends'> | null | undefined,
  reviewCandidateParam: string | undefined,
): PostSessionPrompt {
  const [prompt, setPrompt] = useState<PostSessionPrompt>('pending');
  const sessionId = summary?.sessionId ?? null;
  const totalSends = summary?.totalSends ?? 0;

  useEffect(() => {
    if (sessionId === null) {
      setPrompt('none');
      return undefined;
    }
    // Not a review candidate at all (arrived from history rather than from
    // ending a session): the offline prompt is unopposed.
    if (reviewCandidateParam !== SESSION_STORE_REVIEW_CANDIDATE_PARAM) {
      setPrompt('offline');
      return undefined;
    }
    let cancelled = false;
    void shouldRequestSessionStoreReview({ sessionId, totalSends }).then((willPrompt) => {
      if (!cancelled) setPrompt(willPrompt ? 'review' : 'offline');
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, totalSends, reviewCandidateParam]);

  return prompt;
}
