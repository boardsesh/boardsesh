import { memo, useCallback } from 'react';
import { View, StyleSheet, Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { AccessoryClimbThumbnail } from '../queue-control/AccessoryClimbThumbnail';
import { useWallOrQueueCurrentClimb } from '../queue-control/use-wall-or-queue-climb';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useTheme } from '../../providers/theme-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { hapticSelection } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';

const STRIP_THUMBNAIL_SIZE = 40;

/**
 * Compact "Now on the wall" strip docked atop the iPad detail pane in portrait,
 * where a dedicated wall column would crush the browse list (see
 * `resolveWallSurface`). Shows the lit climb (thumbnail + name + grade + a warm
 * live dot) or a dark state, and taps through to the full BoardSheet. The shell
 * sets PlayDrawer's `paneTopInset={false}` whenever this is shown, so the strip
 * owns the top safe-area inset. Memoized + isolated so wall events re-render only
 * the strip, not the pane.
 */
function WallStripComponent() {
  const { t } = useTranslation('session');
  const insets = useSafeAreaInsets();
  const { systemColors, brandColors } = useTheme();
  const { formatGrade } = useGradeFormat();
  const litClimb = useWallOrQueueCurrentClimb(null);
  const { openBoardSheet, boardPanelProps } = useDrawerHost();
  const boardConfig = boardPanelProps?.boardConfig ?? null;

  const handlePress = useCallback(() => {
    hapticSelection();
    openBoardSheet();
  }, [openBoardSheet]);

  const grade = litClimb ? formatGrade(litClimb.difficulty) : null;

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={
        litClimb ? t('boardPresence.openAriaWithClimb', { name: litClimb.name }) : t('boardPresence.openAria')
      }
      style={[styles.strip, { paddingTop: insets.top + spacing[2], borderBottomColor: systemColors.separator }]}
    >
      {litClimb ? (
        <View style={styles.thumbWrap}>
          <AccessoryClimbThumbnail
            climb={{ frames: litClimb.frames, mirrored: litClimb.mirrored }}
            boardConfig={boardConfig}
            size={STRIP_THUMBNAIL_SIZE}
          />
          <View
            style={[
              styles.dot,
              { backgroundColor: brandColors.warning, borderColor: systemColors.secondaryBackground },
            ]}
          />
        </View>
      ) : (
        <View style={styles.bulbSlot}>
          <Icon name="lightbulb" size={24} color={systemColors.tertiaryLabel} />
        </View>
      )}
      <View style={styles.body}>
        <Text variant="caption2" color={systemColors.secondaryLabel} numberOfLines={1}>
          {t('boardPresence.open')}
        </Text>
        <Text variant="subheadline" color={systemColors.label} numberOfLines={1} style={styles.name}>
          {litClimb ? litClimb.name : t('boardPresence.railDark')}
        </Text>
      </View>
      {grade ? (
        <Text variant="subheadline" color={brandColors.warning} numberOfLines={1} style={styles.grade}>
          {grade}
        </Text>
      ) : null}
      <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
    </Pressable>
  );
}

export const WallStrip = memo(WallStripComponent);

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  thumbWrap: { position: 'relative' },
  dot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 12,
    height: 12,
    borderRadius: borderRadius.full,
    borderWidth: 2,
  },
  bulbSlot: {
    width: STRIP_THUMBNAIL_SIZE,
    height: STRIP_THUMBNAIL_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1, minWidth: 0 },
  name: { fontWeight: '600' },
  grade: { fontWeight: '700' },
});
