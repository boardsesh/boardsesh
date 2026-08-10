import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ListRow } from '../ListRow';
import { Icon } from '../Icon';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type PlaylistDiscussionRowProps = {
  /** Comments on the playlist's general thread (`<uuid>:_all`). */
  commentCount: number;
  onPress: () => void;
};

/**
 * Entry point to a public playlist's discussion thread, rendered in the detail
 * list header. Web puts its `CommentSection` at the very bottom of the page; on
 * mobile a footer under a paginating list is unreachable for a long playlist, so
 * the thread lives behind a row just under the hero.
 */
export const PlaylistDiscussionRow = memo(function PlaylistDiscussionRow({
  commentCount,
  onPress,
}: PlaylistDiscussionRowProps) {
  const { t } = useTranslation('playlists');
  const { t: tCommon } = useTranslation('common');
  const { systemColors } = useTheme();

  return (
    <View style={styles.container}>
      <ListRow
        title={t('detail.discussion')}
        subtitle={tCommon('comment.count', { count: commentCount })}
        leading={<Icon name="comment" size={20} color={systemColors.secondaryLabel} />}
        showChevron
        showSeparator={false}
        onPress={onPress}
        accessibilityLabel={t('detail.discussion')}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing[2], paddingBottom: spacing[2] },
});
