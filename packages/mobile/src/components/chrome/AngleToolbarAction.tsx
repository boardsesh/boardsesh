import { useCallback, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { useActiveBoard, useSetActiveBoard } from '../../lib/graphql/use-active-board';
import { hapticLight } from '../../lib/haptics';
import { Text } from '../Text';
import { AngleSelectorSheet } from '../play-drawer/AngleSelectorSheet';
import { GlassToolbarAction } from './GlassActionToolbar';

/**
 * The "{angle}°" toolbar button paired with its `AngleSelectorSheet`.
 * Self-contained: reads the active board, owns the sheet's open state, and writes
 * the chosen angle back through `setActiveBoard` (which re-grades the climbs in
 * the list / playlist). Renders nothing for fixed-angle boards (or none). Used by
 * both the Climbs and Discover chromes.
 */
export function AngleToolbarAction() {
  const { systemColors } = useTheme();
  const { t: tSession } = useTranslation('session');
  const { data: activeBoard } = useActiveBoard();
  const setActiveBoard = useSetActiveBoard();
  const [visible, setVisible] = useState(false);

  const canAdjust = activeBoard?.isAngleAdjustable !== false && activeBoard?.angle != null;

  const handleOpen = useCallback(() => {
    if (!activeBoard || activeBoard.isAngleAdjustable === false || activeBoard.angle == null) return;
    hapticLight();
    setVisible(true);
  }, [activeBoard]);

  const handleClose = useCallback(() => setVisible(false), []);

  const handleAngleChange = useCallback(
    (newAngle: number) => {
      if (!activeBoard || activeBoard.isAngleAdjustable === false || newAngle === activeBoard.angle) return;
      void setActiveBoard({ ...activeBoard, angle: newAngle });
    },
    [activeBoard, setActiveBoard],
  );

  if (!activeBoard || !canAdjust) return null;

  return (
    <>
      <GlassToolbarAction onPress={handleOpen} accessibilityLabel={tSession('mobile.angleSelector.title')}>
        <Text variant="caption1" style={[styles.angleText, { color: systemColors.label }]}>
          {activeBoard.angle}°
        </Text>
      </GlassToolbarAction>
      <AngleSelectorSheet
        visible={visible}
        onClose={handleClose}
        boardName={activeBoard.boardType}
        layoutId={activeBoard.layoutId}
        currentAngle={activeBoard.angle}
        onAngleChange={handleAngleChange}
      />
    </>
  );
}

const styles = StyleSheet.create({
  angleText: {
    fontWeight: '700',
  },
});
