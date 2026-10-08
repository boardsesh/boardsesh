import { useCallback, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type { BoardName } from '@boardsesh/shared-schema';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useSetBoardAngle } from '../../lib/boards/use-set-board-angle';
import { hapticLight } from '../../lib/haptics';
import { Text } from '../Text';
import { AngleSelectorSheet } from '../play-drawer/AngleSelectorSheet';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { useBoardAngleOptions } from '../../hooks/use-board-angle-options';
import { AnchoredPopover } from '../navigation/AnchoredPopover';
import { AngleBoardDiagram } from '../play-drawer/AngleBoardDiagram';
import { AngleSlider } from '../play-drawer/AngleSlider';
import { SheetTopBar } from '../SheetTopBar';
import { spacing } from '../../theme/tokens';
import { GlassToolbarAction } from './GlassActionToolbar';

/**
 * The "{angle}°" toolbar button paired with its `AngleSelectorSheet`.
 * Self-contained: reads the active board, owns the sheet's open state, and writes
 * the chosen angle back through `useSetBoardAngle` (which re-grades the climbs in
 * the list / playlist). Renders nothing for fixed-angle boards (or none). Used by
 * both the Climbs and Discover chromes.
 */
export function AngleToolbarAction() {
  const { systemColors } = useTheme();
  const { t: tSession } = useTranslation('session');
  const { t: tCommon } = useTranslation('common');
  const { isPad, widthClass } = useDeviceLayout();
  const { data: activeBoard } = useActiveBoard();
  const setBoardAngle = useSetBoardAngle();
  const [visible, setVisible] = useState(false);
  const [selectedAngle, setSelectedAngle] = useState(activeBoard?.angle ?? 40);
  const angles = useBoardAngleOptions(activeBoard?.boardType as BoardName | undefined);
  const usesPopover = Platform.OS === 'ios' && isPad && widthClass === 'regular';

  const [popoverPresentation, setPopoverPresentation] = useState(usesPopover);

  const canAdjust = activeBoard?.isAngleAdjustable !== false && activeBoard?.angle != null;

  const handleOpen = useCallback(() => {
    if (!activeBoard || activeBoard.isAngleAdjustable === false || activeBoard.angle == null) return;
    hapticLight();
    setPopoverPresentation(usesPopover);
    setSelectedAngle(activeBoard.angle);
    setVisible(true);
  }, [activeBoard, usesPopover]);

  const handleClose = useCallback(() => setVisible(false), []);

  const handleAngleChange = useCallback(
    (newAngle: number) => {
      if (!activeBoard || activeBoard.isAngleAdjustable === false || newAngle === activeBoard.angle) return;
      void setBoardAngle(activeBoard, newAngle);
    },
    [activeBoard, setBoardAngle],
  );

  if (!activeBoard || !canAdjust) return null;

  const trigger = (
    <GlassToolbarAction onPress={handleOpen} accessibilityLabel={tSession('mobile.angleSelector.title')}>
      <Text variant="caption1" style={[styles.angleText, { color: systemColors.label }]}>
        {activeBoard.angle}°
      </Text>
    </GlassToolbarAction>
  );
  if (usesPopover)
    return (
      <AnchoredPopover
        visible={visible}
        onClose={handleClose}
        trigger={trigger}
        content={
          <View>
            <SheetTopBar
              title={tSession('mobile.angleSelector.title')}
              leading={{ kind: 'close', onPress: handleClose }}
              trailing={{
                kind: 'confirm',
                label: tCommon('actions.done'),
                prominent: true,
                onPress: () => {
                  handleAngleChange(selectedAngle);
                  handleClose();
                },
              }}
            />
            <View style={styles.popoverBody}>
              <AngleBoardDiagram
                angle={selectedAngle}
                size={150}
                accessibilityLabel={tSession('mobile.angleSelector.diagramAria', { angle: selectedAngle })}
              />
              <Text variant="largeTitle" numeric>
                {selectedAngle}°
              </Text>
              <AngleSlider angles={angles} value={selectedAngle} onChange={setSelectedAngle} />
            </View>
          </View>
        }
      />
    );

  return (
    <>
      {trigger}
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
  popoverBody: { padding: spacing[4], gap: spacing[4], alignItems: 'center' },
  angleText: {
    fontWeight: '700',
  },
});
