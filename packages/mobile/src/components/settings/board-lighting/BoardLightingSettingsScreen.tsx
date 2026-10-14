import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { isMoonboardBoardName } from '@boardsesh/board-config';
import { MoreForm } from '../../MoreForm';
import { useAutoDisconnectTimeoutLabels } from '../../ble/use-auto-disconnect-timeout-labels';
import { AUTO_DISCONNECT_TIMEOUT_OPTIONS } from '../../../lib/ble/auto-disconnect-controller';
import { hapticSelection } from '../../../lib/haptics';
import { withSettingTracking } from '../../../lib/settings-analytics';
import { useOptionalBluetoothContext } from '../../../providers/bluetooth-provider';
import { useSetting } from '../../../settings';
import { buildBoardLightingModel } from './board-lighting-model';

export function BoardLightingSettingsScreen() {
  const { t } = useTranslation('common');
  const [lightOnSwipe, setLightOnSwipe] = useSetting('lightOnSwipe');
  const [lightOnClimbTap, setLightOnClimbTap] = useSetting('lightOnClimbTap');
  const [autoDisconnectBle, setAutoDisconnectBle] = useSetting('autoDisconnectBle');
  const [autoDisconnectTimeoutSeconds, setAutoDisconnectTimeoutSeconds] = useSetting('autoDisconnectTimeoutSeconds');
  const autoDisconnectTimeoutLabels = useAutoDisconnectTimeoutLabels();
  // MoonBoard "V2" additional-LED feature: same setting and toggle handler as the
  // BLE control sheet (BleControlSheetHost), so it is reachable without opening a
  // live connection. Only shown for a MoonBoard, the same gate as that sheet.
  const bluetooth = useOptionalBluetoothContext();
  const showMoonboardLightAdjacentHolds = isMoonboardBoardName(bluetooth?.boardName);
  const moonboardLightAdjacentHolds = bluetooth?.moonboardLightAdjacentHolds ?? false;
  const setMoonboardLightAdjacentHolds = bluetooth?.setMoonboardLightAdjacentHolds;
  const reassertWall = bluetooth?.reassertWall;

  const model = useMemo(
    () =>
      withSettingTracking(
        buildBoardLightingModel({
          t,
          lightOnSwipe: {
            enabled: lightOnSwipe,
            onChange: (enabled) => {
              hapticSelection();
              setLightOnSwipe(enabled);
            },
          },
          lightOnClimbTap: {
            enabled: lightOnClimbTap,
            onChange: (enabled) => {
              hapticSelection();
              setLightOnClimbTap(enabled);
            },
          },
          moonboardLightAdjacentHolds: showMoonboardLightAdjacentHolds
            ? {
                enabled: moonboardLightAdjacentHolds,
                onChange: (enabled) => {
                  hapticSelection();
                  setMoonboardLightAdjacentHolds?.(enabled);
                  reassertWall?.();
                },
              }
            : null,
          autoDisconnect: {
            enabled: autoDisconnectBle,
            onChange: (enabled) => {
              hapticSelection();
              setAutoDisconnectBle(enabled);
            },
          },
          autoDisconnectTimeout: {
            seconds: autoDisconnectTimeoutSeconds,
            options: AUTO_DISCONNECT_TIMEOUT_OPTIONS.map((seconds) => ({
              seconds,
              label: autoDisconnectTimeoutLabels[seconds],
            })),
            onChange: (seconds) => {
              hapticSelection();
              setAutoDisconnectTimeoutSeconds(seconds);
            },
          },
        }),
        'board-lighting',
      ),
    [
      t,
      lightOnSwipe,
      setLightOnSwipe,
      lightOnClimbTap,
      setLightOnClimbTap,
      showMoonboardLightAdjacentHolds,
      moonboardLightAdjacentHolds,
      setMoonboardLightAdjacentHolds,
      reassertWall,
      autoDisconnectBle,
      setAutoDisconnectBle,
      autoDisconnectTimeoutSeconds,
      setAutoDisconnectTimeoutSeconds,
      autoDisconnectTimeoutLabels,
    ],
  );

  return <MoreForm model={model} />;
}
