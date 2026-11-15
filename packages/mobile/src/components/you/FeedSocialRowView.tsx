import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';

export type FeedSocialRowViewProps = {
  voted: boolean;
  count: number;
  isPending?: boolean;
  commentCount: number;
  onVote: () => void;
  onOpenComments: () => void;
  compact?: boolean;
};

/** Vote + comment row for a feed entity (session card or tick row). */
export function FeedSocialRowView({
  voted,
  count,
  isPending = false,
  commentCount,
  onVote,
  onOpenComments,
  compact = false,
}: FeedSocialRowViewProps) {
  const { t } = useTranslation('feed');
  const { systemColors, brandColors } = useTheme();

  const iconSize = compact ? 16 : 18;
  const voteAccessibilityLabel = voted
    ? t('socialActions.removeUpvoteWithCount', { count })
    : t('socialActions.upvoteWithCount', { count });
  const commentsAccessibilityLabel = t('socialActions.openCommentsWithCount', { count: commentCount });

  return (
    <View style={[styles.row, compact && styles.rowCompact]}>
      <PressableSurface
        style={[styles.button, compact && styles.buttonCompact]}
        onPress={onVote}
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
        onPress={onOpenComments}
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
