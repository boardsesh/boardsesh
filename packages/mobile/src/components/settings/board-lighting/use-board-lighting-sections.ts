import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { isMoonboardBoardName } from '@boardsesh/board-config';
import type { MoreSection } from '../../MoreForm.types';
import { useAutoDisconnectTimeoutLabels } from '../../ble/use-auto-disconnect-timeout-labels';
import { AUTO_DISCONNECT_TIMEOUT_OPTIONS } from '../../../lib/ble/auto-disconnect-controller';
import { hapticSelection } from '../../../lib/haptics';
import { useOptionalBluetoothContext } from '../../../providers/bluetooth-provider';
import { useSetting } from '../../../settings';
import { buildBoardLightingSections } from './board-lighting-model';

/**
 * The lighting and Bluetooth groups at the foot of the Board page, with every
 * hook they read. The page owns the analytics wrapper, so these sections report
 * `Setting Changed` under the page that shows them.
 */
export function useBoardLightingSections(): MoreSection[] {
  const { t } = useTranslation('common');
  const [lightOnSwipe, setLightOnSwipe] = useSetting('lightOnSwipe');
  const [lightOnClimbTap, setLightOnClimbTap] = useSetting('lightOnClimbTap');
  const [playlistTapLoadsQueue, setPlaylistTapLoadsQueue] = useSetting('playlistTapLoadsQueue');
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

  return useMemo(
    () =>
      buildBoardLightingSections({
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
        playlistTapLoadsQueue: {
          enabled: playlistTapLoadsQueue,
          onChange: (enabled) => {
            hapticSelection();
            setPlaylistTapLoadsQueue(enabled);
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
    [
      t,
      lightOnSwipe,
      setLightOnSwipe,
      lightOnClimbTap,
      setLightOnClimbTap,
      playlistTapLoadsQueue,
      setPlaylistTapLoadsQueue,
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
}
