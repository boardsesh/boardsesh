import { useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { getScreenshotDriveRequest, subscribeScreenshotDriveRequest } from '../../lib/screenshot-driving';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useBluetoothWriteInProgress } from '../../providers/bluetooth-write-activity';
import { useQueueData } from '../../providers/queue-provider';
import { useBoardConnectionState } from '../ble/use-board-connection-state';
import { useWallClearedClimbUuid } from '../ble/wall-cleared-store';
import { useDriveMode } from './drive-mode-store';
import { useWallClimb } from './use-wall-climb';

/** Observe the real drive after the player closes; never starts or changes it. */
export function ScreenshotCurrentDriveReadiness() {
  const request = useSyncExternalStore(
    subscribeScreenshotDriveRequest,
    getScreenshotDriveRequest,
    getScreenshotDriveRequest,
  );
  const { data: board, isPending: boardPending } = useActiveBoard();
  const { currentClimbQueueItem } = useQueueData();
  const { boardId } = useBoardPresenceControls();
  const connection = useBoardConnectionState();
  const drive = useDriveMode();
  const wall = useWallClimb();
  const clearedClimbUuid = useWallClearedClimbUuid();
  const writing = useBluetoothWriteInProgress();
  const ready =
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' &&
    process.env.EXPO_PUBLIC_SCREENSHOT_DRIVING === '1' &&
    process.env.EXPO_PUBLIC_SCREENSHOT_FAKE_BLE === '1' &&
    request !== null &&
    !boardPending &&
    board?.uuid === request.boardUuid &&
    board.boardType !== 'spray' &&
    board.hasLeds !== false &&
    !connection.ledless &&
    connection.sessionId === null &&
    connection.localConnected &&
    !connection.pending &&
    !writing &&
    drive?.phase === 'live' &&
    drive.sessionId === null &&
    boardId !== null &&
    drive.boardId === boardId &&
    currentClimbQueueItem?.climb.uuid === request.climbUuid &&
    wall.uuid === request.climbUuid &&
    (!connection.bluetooth?.staleCurrentHold ||
      connection.bluetooth.staleCurrentHold.queueItemUuid !== currentClimbQueueItem?.uuid) &&
    clearedClimbUuid !== request.climbUuid;
  if (!ready) return null;
  return (
    <View
      testID={`store-current-driving-${request.boardUuid}-${request.climbUuid}`}
      style={styles.marker}
      pointerEvents="none"
      collapsable={false}
    />
  );
}

const styles = StyleSheet.create({
  marker: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
});
