import { useEffect, useRef, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { getScreenshotDriveRequest, subscribeScreenshotDriveRequest } from '../../lib/screenshot-driving';
import type { DriveStartOutcome } from './use-wall-control';
import type { WallControlModel } from './wall-control';

type ScreenshotDriveControllerProps = {
  boardUuid: string | null;
  climbUuid: string | null;
  eligible: boolean;
  sessionId: string | null;
  connected: boolean;
  displayedLit: boolean;
  mirrored: boolean;
  model: Pick<WallControlModel, 'state' | 'driving' | 'drivePhase' | 'pending' | 'writing' | 'swipeAction'>;
  start: () => DriveStartOutcome;
};

/** Runs the real wall action once per explicit hero intent, including the tapless Duo. */
export function ScreenshotDriveController({
  boardUuid,
  climbUuid,
  eligible,
  sessionId,
  connected,
  displayedLit,
  mirrored,
  model,
  start,
}: ScreenshotDriveControllerProps) {
  const request = useSyncExternalStore(
    subscribeScreenshotDriveRequest,
    getScreenshotDriveRequest,
    getScreenshotDriveRequest,
  );
  const attempted = useRef<number | null>(null);
  const matches =
    eligible &&
    sessionId === null &&
    request !== null &&
    request.boardUuid === boardUuid &&
    request.climbUuid === climbUuid;
  const ready =
    matches &&
    connected &&
    displayedLit &&
    model.state === 'lit' &&
    model.driving &&
    model.drivePhase === 'live' &&
    !model.pending &&
    !model.writing;

  useEffect(() => {
    if (!matches || !request || attempted.current === request.sequence) return;
    // A retained Duo pane can already be driving this exact climb. Consume its
    // intent too, so stopping later cannot cause an automatic restart.
    if (ready) {
      attempted.current = request.sequence;
      return;
    }
    if (model.swipeAction !== 'drive') return;
    attempted.current = request.sequence;
    start();
  }, [matches, request, ready, model.swipeAction, start]);

  if (!ready) return null;
  return (
    <View
      testID={`store-driving-${boardUuid}-${climbUuid}${mirrored ? '-mirrored' : ''}`}
      style={styles.marker}
      pointerEvents="none"
      collapsable={false}
    />
  );
}

const styles = StyleSheet.create({
  marker: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
});
