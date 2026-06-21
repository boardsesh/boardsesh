import { memo } from 'react';
import { StyleSheet, View, Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';

type PlayDrawerPreviewBannerProps = {
  /** Whether to show the "Set active" affordance. Hidden when the climb is on a
   *  board the user isn't on (the switch-board overlay is the right action there). */
  showSetActive: boolean;
  /** Promote the previewed climb to the current queue item. */
  onSetActive: () => void;
};

/**
 * Banner shown in the play drawer when the displayed climb is a *preview* — a
 * climb the user is browsing (workout builder, logbook/cross-board) that is NOT
 * their active/wall climb. The lightbulb acts on the active climb, not this
 * preview, so the banner makes that explicit and offers a one-tap "Set active"
 * to promote it. The peer-driven accessory-bar wall climb is *not* a preview in
 * this sense — it's physically lit — so it renders {@link PlayDrawerOnWallBanner}
 * (read-only, no "Set active") instead.
 */
export const PlayDrawerPreviewBanner = memo(function PlayDrawerPreviewBanner({
  showSetActive,
  onSetActive,
}: PlayDrawerPreviewBannerProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();

  return (
    <View style={styles.row}>
      <View style={styles.chip}>
        <Text variant="caption1" color={iosSystemColors.white} style={styles.chipLabel}>
          {t('playView.previewBadge')}
        </Text>
      </View>
      {showSetActive ? (
        <Pressable
          onPress={onSetActive}
          accessibilityRole="button"
          accessibilityLabel={t('playView.setActive')}
          hitSlop={8}
          style={styles.setActive}
        >
          <Text variant="subheadline" color={systemColors.accent} style={styles.setActiveLabel}>
            {t('playView.setActive')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: spacing[4],
    marginTop: spacing[1],
    marginBottom: spacing[2],
  },
  chip: {
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1] / 2,
    borderRadius: borderRadius.sm,
    backgroundColor: iosSystemColors.systemOrange,
  },
  chipLabel: {
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  setActive: {
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
  },
  setActiveLabel: {
    fontWeight: '600',
  },
});
