// The Material variant's board-context app-bar actions: an angle control and a
// bluetooth lightbulb, both as M3 `Appbar.Action`s. Extracted from
// `ClimbTopChrome` so the Climbs app bar and the shared `CollapsingTopChrome`
// material branch (Discover) render the same controls instead of duplicating
// them. They are the flat M3 counterparts of the liquid-glass `AngleToolbarAction`
// / `LightbulbToolbarAction` islands — each reads its own state and renders
// nothing when it doesn't apply (no adjustable board / no bluetooth).
//
// The Climbs angle lives as the first chip in the native filter chip row
// (`FilterChipRow.android`), not here — the app bar keeps only the create action.
// `MaterialAngleAction` remains for Discover's `CollapsingTopChrome`.

import { useCallback } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Appbar } from 'react-native-paper';
import { useTheme } from '../../providers/theme-provider';
import { hapticLight } from '../../lib/haptics';
import { useLightbulbControl } from '../ble/use-lightbulb-control';
import { useBleControlSheet } from '../../providers/ble-control-sheet-provider';
import { Text } from '../Text';
import { iconMap } from '../icon-map';
import { AngleSelectorSheet } from '../play-drawer/AngleSelectorSheet';
import { useMaterialAngleControl } from './use-material-angle-control';

export function MaterialAngleAction() {
  const { systemColors } = useTheme();
  const { t: tSession } = useTranslation('session');
  const { activeBoard, canAdjust, visible, open, close, change } = useMaterialAngleControl();

  const angleIcon = useCallback(
    () => (
      <Text variant="caption1" style={[styles.materialAngleText, { color: systemColors.label }]}>
        {activeBoard?.angle}°
      </Text>
    ),
    [activeBoard?.angle, systemColors.label],
  );

  if (!activeBoard || !canAdjust) return null;

  return (
    <>
      <Appbar.Action icon={angleIcon} onPress={open} accessibilityLabel={tSession('mobile.angleSelector.title')} />
      <AngleSelectorSheet
        visible={visible}
        onClose={close}
        boardName={activeBoard.boardType}
        layoutId={activeBoard.layoutId}
        currentAngle={activeBoard.angle}
        onAngleChange={change}
      />
    </>
  );
}

export function MaterialLightbulbAction() {
  const { systemColors, brandColors } = useTheme();
  const { t: tCommon } = useTranslation('common');
  const { t: tSettings } = useTranslation('settings');
  const { open: openControls } = useBleControlSheet();
  const { bluetooth, lit, localConnected, ledless, wallHeldLocally, onPress, onLongPress } = useLightbulbControl({
    onOpenControls: openControls,
  });

  const handlePress = useCallback(() => {
    hapticLight();
    onPress();
  }, [onPress]);

  if (!bluetooth) return null;

  const iconName = lit ? iconMap['lightbulb.fill'].android : iconMap.lightbulb.android;
  const iconColor = lit ? brandColors.warning : systemColors.label;

  // On a wall with no light kit there is no Bluetooth link to describe, so the
  // label names the two states that DO exist there: holding the wall or not.
  let accessibilityLabel: string;
  if (ledless) {
    accessibilityLabel = wallHeldLocally ? tSettings('ble.releaseWall') : tSettings('ble.takeWall');
  } else {
    accessibilityLabel = localConnected ? tCommon('lightControl.disconnect') : tSettings('ble.connectBoard');
  }

  return (
    <Appbar.Action
      icon={iconName}
      color={iconColor as string}
      onPress={handlePress}
      // Short press connects/disconnects; long press (connected) opens the
      // controls sheet — same as the drawer + accessory-bar lightbulbs.
      onLongPress={localConnected ? onLongPress : undefined}
      // The label reflects what tapping does (this device's link), not the fill —
      // the bulb can read lit because a session peer holds the wall.
      accessibilityLabel={accessibilityLabel}
    />
  );
}

const styles = StyleSheet.create({
  materialAngleText: {
    fontWeight: '700',
    textAlign: 'center',
  },
});
