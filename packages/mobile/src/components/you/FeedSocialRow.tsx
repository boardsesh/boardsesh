import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SocialEntityType } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { useOptimisticVote } from './use-optimistic-vote';
import { hapticLight } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';
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
  const { t } = useTranslation('feed');
  const { systemColors, brandColors } = useTheme();
  const { voted, count, toggle, isPending } = useOptimisticVote(entityId, upvotes, userVote, entityType);

  const iconSize = compact ? 16 : 18;
  const voteAccessibilityLabel = voted
    ? t('socialActions.removeUpvoteWithCount', { count })
    : t('socialActions.upvoteWithCount', { count });
  const commentsAccessibilityLabel = t('socialActions.openCommentsWithCount', { count: commentCount });

  const handleVote = () => {
    if (isPending) return; // guard double-tap (toggle no-ops too)
    hapticLight();
    toggle();
  };

  return (
    <View style={[styles.row, compact && styles.rowCompact]}>
      <PressableSurface
        style={[styles.button, compact && styles.buttonCompact]}
        onPress={handleVote}
        disabled={isPending}
        accessibilityRole="button"
        accessibilityLabel={voteAccessibilityLabel}
        accessibilityState={{ selected: voted, disabled: isPending }}
        feedback="opacity"
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
      </PressableSurface>
      <PressableSurface
        style={[styles.button, compact && styles.buttonCompact]}
        onPress={() => onOpenComments(entityId)}
        accessibilityRole="button"
        accessibilityLabel={commentsAccessibilityLabel}
        feedback="opacity"
      >
        <Icon name="comment" size={iconSize} color={systemColors.secondaryLabel} />
        {commentCount > 0 && (
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {commentCount}
          </Text>
        )}
      </PressableSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  rowCompact: {
    gap: spacing[1],
  },
  button: {
    minWidth: 44,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
    paddingHorizontal: spacing[2],
    borderRadius: borderRadius.full,
  },
  buttonCompact: {
    paddingHorizontal: spacing[1],
  },
});
