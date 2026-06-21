// The Material variant's board-context app-bar actions: an angle control and a
// bluetooth lightbulb, both as M3 `Appbar.Action`s. Extracted from
// `ClimbTopChrome` so the Climbs app bar and the shared `CollapsingTopChrome`
// material branch (Discover) render the same controls instead of duplicating
// them. They are the flat M3 counterparts of the liquid-glass `AngleToolbarAction`
// / `LightbulbToolbarAction` islands — each reads its own state and renders
// nothing when it doesn't apply (no adjustable board / no bluetooth).

import { useCallback, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Appbar } from 'react-native-paper';
import { useTheme } from '../../providers/theme-provider';
import { useActiveBoard, useSetActiveBoard } from '../../lib/graphql/use-active-board';
import { hapticLight } from '../../lib/haptics';
import { useLightbulbControl } from '../ble/use-lightbulb-control';
import { Text } from '../Text';
import { iconMap } from '../icon-map';
import { AngleSelectorSheet } from '../play-drawer/AngleSelectorSheet';

export function MaterialAngleAction() {
  const { systemColors } = useTheme();
  const { t: tSession } = useTranslation('session');
  const { data: activeBoard } = useActiveBoard();
  const setActiveBoard = useSetActiveBoard();
  const [visible, setVisible] = useState(false);

  const canAdjust = activeBoard?.isAngleAdjustable !== false && activeBoard?.angle != null;
  const angleIcon = useCallback(
    () => (
      <Text variant="caption1" style={[styles.materialAngleText, { color: systemColors.label }]}>
        {activeBoard?.angle}°
      </Text>
    ),
    [activeBoard?.angle, systemColors.label],
  );
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
      <Appbar.Action
        icon={angleIcon}
        onPress={handleOpen}
        accessibilityLabel={tSession('mobile.angleSelector.title')}
      />
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

export function MaterialLightbulbAction() {
  const { systemColors, brandColors } = useTheme();
  const { t: tCommon } = useTranslation('common');
  const { t: tSettings } = useTranslation('settings');
  const { bluetooth, lit, localConnected, onPress } = useLightbulbControl({ source: 'lightbulb_toolbar' });

  const handlePress = useCallback(() => {
    hapticLight();
    onPress();
  }, [onPress]);

  if (!bluetooth) return null;

  const iconName = lit ? iconMap['lightbulb.fill'].android : iconMap.lightbulb.android;
  const iconColor = lit ? brandColors.warning : systemColors.label;

  return (
    <Appbar.Action
      icon={iconName}
      color={iconColor as string}
      onPress={handlePress}
      // The label reflects what tapping does (this device's link), not the fill —
      // the bulb can read lit because a session peer holds the wall.
      accessibilityLabel={localConnected ? tCommon('lightControl.disconnect') : tSettings('ble.connectBoard')}
    />
  );
}

const styles = StyleSheet.create({
  materialAngleText: {
    fontWeight: '700',
    textAlign: 'center',
  },
});
