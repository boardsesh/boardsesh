import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { isMoonboardBoardName } from '@boardsesh/board-config';
import type { MoreSection } from '../../MoreForm.types';
import { DEFAULT_KEEP_LIGHTING, sanitiseKeepLighting } from '../../../lib/keep-lighting';
import { buildHelpSectionUrl } from '../../../lib/help-url';
import { openExternalUrl } from '../../../lib/open-url';
import { hapticSelection } from '../../../lib/haptics';
import { useOptionalBluetoothContext } from '../../../providers/bluetooth-provider';
import { useSetting } from '../../../settings';
import { buildBoardLightingSections } from './board-lighting-model';

/**
 * The lighting groups at the foot of the Board page, with every hook they read. The page owns the analytics wrapper, so these sections report
 * `Setting Changed` under the page that shows them.
 */
export function useBoardLightingSections(): MoreSection[] {
  const { t, i18n } = useTranslation('common');
  const language = i18n?.language;
  const [storedKeepLighting, setKeepLighting] = useSetting('putOnBoardKeepsLighting');
  const [drivesInSession, setDrivesInSession] = useSetting('putOnBoardDrivesInSession');
  const [disconnectWhenDrivingEnds, setDisconnectWhenDrivingEnds] = useSetting('disconnectWhenDrivingEnds');
  const keepLighting = sanitiseKeepLighting(storedKeepLighting, DEFAULT_KEEP_LIGHTING);
  const [alwaysDrive, setAlwaysDrive] = useSetting('alwaysDrive');
  const [playlistTapLoadsQueue, setPlaylistTapLoadsQueue] = useSetting('playlistTapLoadsQueue');
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
        keepLighting: {
          choice: keepLighting,
          onChange: (choice) => {
            hapticSelection();
            setKeepLighting(choice);
          },
        },
        drivesInSession: {
          enabled: drivesInSession,
          onChange: (enabled) => {
            hapticSelection();
            setDrivesInSession(enabled);
          },
        },
        disconnectWhenDrivingEnds: {
          enabled: disconnectWhenDrivingEnds,
          onChange: (enabled) => {
            hapticSelection();
            setDisconnectWhenDrivingEnds(enabled);
          },
        },
        alwaysDrive: {
          enabled: alwaysDrive,
          onChange: (enabled) => {
            hapticSelection();
            setAlwaysDrive(enabled);
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
        onOpenDrivingHelp: () => {
          void openExternalUrl(
            buildHelpSectionUrl('board-and-bluetooth', 'driving', language),
            'settings-board-driving-help',
          );
        },
      }),
    [
      language,
      t,
      keepLighting,
      setKeepLighting,
      drivesInSession,
      setDrivesInSession,
      disconnectWhenDrivingEnds,
      setDisconnectWhenDrivingEnds,
      alwaysDrive,
      setAlwaysDrive,
      playlistTapLoadsQueue,
      setPlaylistTapLoadsQueue,
      showMoonboardLightAdjacentHolds,
      moonboardLightAdjacentHolds,
      setMoonboardLightAdjacentHolds,
      reassertWall,
    ],
  );
}
