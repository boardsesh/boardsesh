import type { SocialEntityType } from '@boardsesh/shared-schema';
import { hapticLight } from '../../lib/haptics';
import { FeedSocialRowView } from './FeedSocialRowView';
import { useOptimisticVote } from './use-optimistic-vote';

type FeedSocialRowProps = {
  /** The voted/commented entity (a session or a tick). */
  entityId: string;
  /** Defaults to `'session'` so existing session cards stay unchanged. */
  entityType?: SocialEntityType;
  /** Server upvote count (from the bulk vote summary, else the feed item). */
  upvotes: number;
  /** Server vote for the viewer: 1 = upvoted, else not. */
  userVote: number | null;
  commentCount: number;
  onOpenComments: (entityId: string) => void;
  /** Compact spacing for inline (per-tick) placement. */
  compact?: boolean;
};

/** Vote + comment row for a feed entity (session card or tick row). */
export function FeedSocialRow({
  entityId,
  entityType = 'session',
  upvotes,
  userVote,
  commentCount,
  onOpenComments,
  compact = false,
}: FeedSocialRowProps) {
  const { voted, count, toggle, isPending } = useOptimisticVote(entityId, upvotes, userVote, entityType);
  const onVote = () => {
    if (isPending) return;
    hapticLight();
    toggle();
  };
  return (
    <FeedSocialRowView
      voted={voted}
      count={count}
      isPending={isPending}
      commentCount={commentCount}
      onVote={onVote}
      onOpenComments={() => onOpenComments(entityId)}
      compact={compact}
    />
  );
}
