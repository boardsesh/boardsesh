import { PressableSurface } from '../PressableSurface';
import { memo, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { AccessoryClimbThumbnail } from '../queue-control/AccessoryClimbThumbnail';
import { useWallClimbIfDistinct } from '../queue-control/use-wall-or-queue-climb';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useTheme } from '../../providers/theme-provider';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { hapticSelection } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';
import { WALL_LIVE_DOT_SIZE } from '../../theme/layout';

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
  const { resolveGrade } = useDisplayGrade();
  // Pass `null`: the strip always mirrors whatever's lit on the wall, so it never
  // hides the climb as a duplicate of the local queue head.
  const litClimb = useWallClimbIfDistinct(null);
  const { openBoardSheet, boardPanelProps } = useDrawerHost();
  const boardConfig = boardPanelProps?.boardConfig ?? null;

  const handlePress = useCallback(() => {
    hapticSelection();
    openBoardSheet();
  }, [openBoardSheet]);

  // The lit-climb payload (BoardPresenceClimb) carries no Boardsesh grade today, so
  // `resolveGrade` falls back to the legacy label — the strip lights up the
  // Boardsesh grade once the backend stamps presence climbs. The colour stays the
  // warm live accent, so only the label matters here.
  const grade = litClimb ? resolveGrade({ difficulty: litClimb.grade ?? '' }, boardConfig?.boardName).label : null;

  return (
    <PressableSurface
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={
        litClimb ? t('boardPresence.openAriaWithClimb', { name: litClimb.name ?? '' }) : t('boardPresence.openAria')
      }
      style={[styles.strip, { paddingTop: insets.top + spacing[2], borderBottomColor: systemColors.separator }]}
    >
      {litClimb ? (
        <View style={styles.thumbWrap}>
          <AccessoryClimbThumbnail
            climb={{ frames: litClimb.frames ?? '' }}
            boardConfig={boardConfig}
            size={STRIP_THUMBNAIL_SIZE}
          />
          <View
            style={[styles.dot, { backgroundColor: brandColors.live, borderColor: systemColors.secondaryBackground }]}
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
          {litClimb ? (litClimb.name ?? '') : t('boardPresence.railDark')}
        </Text>
      </View>
      {grade ? (
        <Text variant="subheadline" color={brandColors.live} numberOfLines={1} style={styles.grade}>
          {grade}
        </Text>
      ) : null}
      <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
    </PressableSurface>
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
    width: WALL_LIVE_DOT_SIZE,
    height: WALL_LIVE_DOT_SIZE,
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
