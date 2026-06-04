import { View, Pressable, StyleSheet } from 'react-native';
import type { SocialEntityType } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useOptimisticVote } from './use-optimistic-vote';
import { hapticLight } from '../../lib/haptics';
import { brandColors } from '../../theme/colors';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type FeedSocialRowProps = {
  /** The voted/commented entity (a session or a tick). */
  entityId: string;
  /** Defaults to `'session'` so existing session cards stay unchanged. */
  entityType?: SocialEntityType;
  /** Server upvote count (from the bulk vote summary, else the feed item). */
  upvotes: number;
  /** Server vote for the viewer: 1 = upvoted, else not. */
  userVote: number | null;
  /** Comment count to badge. Omit when the count isn't known (e.g. per-tick
   *  rows, where the detail query doesn't return it) — the icon shows without
   *  a number rather than a misleading 0. */
  commentCount?: number;
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
  const { systemColors } = useTheme();
  const { voted, count, toggle, isPending } = useOptimisticVote(entityId, upvotes, userVote, entityType);

  const iconSize = compact ? 16 : 18;

  const handleVote = () => {
    if (isPending) return; // guard double-tap (toggle no-ops too)
    hapticLight();
    toggle();
  };

  return (
    <View style={[styles.row, compact && styles.rowCompact]}>
      <Pressable
        style={styles.button}
        onPress={handleVote}
        disabled={isPending}
        accessibilityRole="button"
        accessibilityState={{ selected: voted }}
        hitSlop={6}
      >
        <Icon
          name={voted ? 'favorite.fill' : 'favorite'}
          size={iconSize}
          color={voted ? brandColors.error : systemColors.secondaryLabel}
        />
        {count > 0 && (
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {count}
          </Text>
        )}
      </Pressable>
      <Pressable style={styles.button} onPress={() => onOpenComments(entityId)} accessibilityRole="button" hitSlop={6}>
        <Icon name="comment" size={iconSize} color={systemColors.secondaryLabel} />
        {commentCount != null && commentCount > 0 && (
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {commentCount}
          </Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: spacing[6],
    marginTop: spacing[3],
    paddingTop: spacing[3],
  },
  rowCompact: {
    gap: spacing[4],
    marginTop: 0,
    paddingTop: 0,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
});
