import { useCallback, useEffect, useState } from 'react';
import type { SocialEntityType } from '@boardsesh/shared-schema';
import { useVote } from '../../lib/graphql/hooks';

export type OptimisticVote = {
  /** Whether the viewer has upvoted (optimistic while a tap is in flight). */
  voted: boolean;
  /** Upvote count (optimistic while a tap is in flight). */
  count: number;
  /** Toggle the viewer's vote. No-ops while a previous tap is still in flight. */
  toggle: () => void;
  /** True while the vote mutation is in flight. */
  isPending: boolean;
};

/**
 * Optimistic upvote state for a feed entity (sessions or ticks). Layers a local
 * override over the server count / `userVote` so the UI flips instantly,
 * reconciles to the server summary on success, rolls back on error, and resets
 * when the row is recycled onto a different entity — FlashList reuses component
 * instances, so without the reset one card's vote would bleed onto another.
 *
 * `entityType` defaults to `'session'` so existing session call sites stay
 * unchanged; tick rows pass `'tick'` to reuse the same vote pipeline.
 */
export function useOptimisticVote(
  entityId: string,
  serverUpvotes: number,
  serverUserVote: number | null,
  entityType: SocialEntityType = 'session',
): OptimisticVote {
  // Destructure the stable `mutate` + the `isPending` flag rather than depend on
  // the whole useMutation result — that object is a fresh reference every render,
  // so depending on it would needlessly recreate `toggle` (defeating any memo on
  // consumers). `mutate` is reference-stable; only `isPending` legitimately moves.
  const { mutate: voteMutate, isPending: voteIsPending } = useVote();
  const [optimistic, setOptimistic] = useState<{ count: number; voted: boolean } | null>(null);

  // Recycled onto a different entity → drop the previous row's optimistic state.
  useEffect(() => setOptimistic(null), [entityId]);

  const voted = optimistic ? optimistic.voted : serverUserVote === 1;
  const count = optimistic ? optimistic.count : serverUpvotes;

  const toggle = useCallback(() => {
    if (voteIsPending) return; // guard double-tap
    const nextVoted = !voted;
    setOptimistic({ count: count + (nextVoted ? 1 : -1), voted: nextVoted });
    voteMutate(
      { entityType, entityId, value: nextVoted ? 1 : 0 },
      {
        onSuccess: (summary) => setOptimistic({ count: summary.upvotes, voted: summary.userVote === 1 }),
        onError: () => setOptimistic(null),
      },
    );
  }, [voteMutate, voteIsPending, voted, count, entityId, entityType]);

  return { voted, count, toggle, isPending: voteIsPending };
}
