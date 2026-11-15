import { useCallback, useRef, useState } from 'react';
import type { SocialEntityType } from '@boardsesh/shared-schema';
import { useVote } from '../../lib/graphql/hooks';
import { useHttpActionScope } from '../../lib/graphql/use-http-action-scope';

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
  // Destructure the stable submit function + pending flag rather than depend on
  // the whole useMutation result — that object is a fresh reference every render,
  // so depending on it would needlessly recreate `toggle` (defeating any memo on
  // consumers). `mutate` is reference-stable; only `isPending` legitimately moves.
  const { mutateWithReceipt: voteWithReceipt, isPending: voteIsPending } = useVote();
  const actionScope = useHttpActionScope();
  const identity = useRef({ entityId, entityType, view: actionScope.key });
  if (
    identity.current.entityId !== entityId ||
    identity.current.entityType !== entityType ||
    identity.current.view !== actionScope.key
  )
    identity.current = { entityId, entityType, view: actionScope.key };
  const currentIdentity = identity.current;
  const [override, setOptimistic] = useState<{
    identity: typeof currentIdentity;
    count: number;
    voted: boolean;
  } | null>(null);
  // Retire recycled rows during render, before a parent layout effect or a
  // completed old mutation can publish into the new entity or browser view.
  const optimistic = override?.identity === currentIdentity ? override : null;

  const voted = optimistic ? optimistic.voted : serverUserVote === 1;
  const count = optimistic ? optimistic.count : serverUpvotes;

  const toggle = useCallback(() => {
    if (voteIsPending || identity.current !== currentIdentity) return; // guard double-tap and recycled callbacks
    let action: ReturnType<typeof actionScope.capture>;
    try {
      action = actionScope.capture();
    } catch {
      return;
    }
    const originalIdentity = currentIdentity;
    const isCurrent = () => identity.current === originalIdentity && action.isCurrent();
    const nextVoted = !voted;
    setOptimistic({ identity: originalIdentity, count: count + (nextVoted ? 1 : -1), voted: nextVoted });
    // The backend's vote mutation only accepts +1/-1 (no 0/null "clear vote"
    // value) — un-voting is done by resending the SAME value already on
    // record, which the resolver detects and deletes. Mobile only ever
    // represents an upvote, so the wire value is always 1; `nextVoted` still
    // drives the local optimistic voted/count flip above.
    void (async () => {
      let receipt: Awaited<ReturnType<typeof voteWithReceipt>> | undefined;
      try {
        receipt = await voteWithReceipt({ entityType, entityId, value: 1 }, { signal: action.signal });
        receipt.assertCurrent();
        if (!isCurrent()) return;
        setOptimistic({
          identity: originalIdentity,
          count: receipt.result.upvotes,
          voted: receipt.result.userVote === 1,
        });
      } catch {
        if (isCurrent()) setOptimistic(null);
      } finally {
        receipt?.dispose();
        action.finish();
      }
    })();
  }, [voteWithReceipt, voteIsPending, voted, count, entityId, entityType, actionScope, currentIdentity]);

  return { voted, count, toggle, isPending: voteIsPending };
}
