import { memo, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { AccessoryClimbThumbnail } from '../queue-control/AccessoryClimbThumbnail';
import { useWallOrQueueCurrentClimb } from '../queue-control/use-wall-or-queue-climb';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useTheme } from '../../providers/theme-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { hapticSelection } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';
import { WALL_LIVE_DOT_SIZE } from '../../theme/layout';

const WALL_THUMBNAIL_SIZE = 36;

/**
 * Ambient "now on the wall" cell pinned to the bottom of the iPad sidebar rail
 * (above the account row). It's the always-glanceable, minimal status pin for
 * the physical wall — a board thumbnail + grade + a warm live dot when a climb
 * is lit, a dim bulb when the wall is dark. Tapping opens the full BoardSheet
 * ("Now on the wall": hero, history, stats, switch board), which is also the
 * basis for the planned Gym Wall destination. The rich always-visible wall
 * surface (strip in portrait, column in landscape) is owned by the shell; this
 * cell is the cross-tab anchor. Renders nothing when board presence isn't active
 * (no board bound).
 *
 * Memoized + isolated so wall events re-render only this cell, not the whole rail.
 */
function SidebarWallCellComponent() {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const { formatGrade } = useGradeFormat();
  const { enabled, boardId } = useBoardPresenceControls();
  const litClimb = useWallOrQueueCurrentClimb(null);
  const { openBoardSheet, boardPanelProps } = useDrawerHost();
  const boardConfig = boardPanelProps?.boardConfig ?? null;

  const handlePress = useCallback(() => {
    hapticSelection();
    openBoardSheet();
  }, [openBoardSheet]);

  // The wall concept is inactive (no board bound) — leave the rail as-is.
  if (!enabled || boardId === null) return null;

  const grade = litClimb ? formatGrade(litClimb.difficulty) : null;
  const accessibilityLabel = litClimb
    ? t('boardPresence.openAriaWithClimb', { name: litClimb.name })
    : t('boardPresence.railDark');

  return (
    <PressableSurface
      onPress={handlePress}
      feedback="scale"
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={styles.cell}
    >
      <Text variant="caption2" color={systemColors.secondaryLabel} numberOfLines={1} style={styles.label}>
        {t('boardPresence.open')}
      </Text>
      {litClimb ? (
        <View style={styles.thumbWrap}>
          <AccessoryClimbThumbnail
            climb={{ frames: litClimb.frames, mirrored: litClimb.mirrored }}
            boardConfig={boardConfig}
            size={WALL_THUMBNAIL_SIZE}
          />
          <View
            style={[styles.dot, { backgroundColor: brandColors.live, borderColor: systemColors.secondaryBackground }]}
          />
        </View>
      ) : (
        <Icon name="lightbulb" size={24} color={systemColors.tertiaryLabel} />
      )}
      {grade ? (
        <Text variant="caption2" color={brandColors.live} numberOfLines={1} style={styles.grade}>
          {grade}
        </Text>
      ) : null}
    </PressableSurface>
  );
}

export const SidebarWallCell = memo(SidebarWallCellComponent);

const styles = StyleSheet.create({
  cell: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing[2],
    gap: 4,
    width: '100%',
  },
  label: { textAlign: 'center', paddingHorizontal: spacing[1] },
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
  grade: { fontWeight: '600' },
});
