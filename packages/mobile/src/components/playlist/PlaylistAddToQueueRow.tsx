import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ListRow } from '../ListRow';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type PlaylistAddToQueueRowProps = {
  onPress: () => void;
  /** True while the board-scoped fetch + append is in flight. */
  isAppending: boolean;
};

/**
 * The playlist detail screen's additive bulk-queue control: land every climb in
 * this playlist behind whatever the climber already has queued, without touching
 * the current climb.
 *
 * A labelled row in the list header rather than a control on the bottom bar,
 * because that is the one surface reaching both platform branches, smart AND
 * owned playlists, and non-owners — the overflow menu is `isOwner`-gated and
 * smart playlists render no menu at all. It sits directly above
 * `PlaylistDiscussionRow`, which is the same shape (a `ListRow` in
 * `ListHeaderComponent`).
 *
 * Glyph is the app's established "add to queue" mark — `add` at 22 dp in
 * `actionColors.success`, identical to the climb long-press sheet's row — so the
 * additive action reads the same wherever it appears.
 */
export const PlaylistAddToQueueRow = memo(function PlaylistAddToQueueRow({
  onPress,
  isAppending,
}: PlaylistAddToQueueRowProps) {
  const { t } = useTranslation('playlists');
  const { systemColors, actionColors } = useTheme();

  return (
    <View style={styles.container}>
      <ListRow
        title={t('detail.addToQueue.action')}
        subtitle={t('detail.addToQueue.subtitle')}
        leading={<Icon name="add" size={22} color={actionColors.success} />}
        trailing={
          isAppending ? (
            // Sized into the trailing slot so the row height doesn't change
            // mid-append — no reflow of the list under the climber's thumb. It
            // is progress, not a control, so it never becomes its own focus stop.
            <View style={styles.spinner} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <ActivityIndicator size="small" color={systemColors.secondaryLabel} />
            </View>
          ) : undefined
        }
        showChevron={false}
        showSeparator={false}
        // `ListRow` has no `disabled` prop, so a second tap is swallowed here.
        // The hook guards re-entrancy too; this keeps the haptic from firing on
        // a tap that does nothing.
        onPress={isAppending ? noop : onPress}
        haptic={!isAppending}
        accessibilityState={isAppending ? BUSY_STATE : undefined}
        accessibilityLabel={t('detail.addToQueue.action')}
        accessibilityHint={t('detail.addToQueue.subtitle')}
      />
    </View>
  );
});

const BUSY_STATE = { busy: true, disabled: true } as const;

function noop() {}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing[2], paddingBottom: spacing[2] },
  // Fixed width so the trailing slot reserves the same space whether or not the
  // indicator is there — the label column never shifts mid-append.
  spinner: { width: 20, alignItems: 'center', justifyContent: 'center' },
});
