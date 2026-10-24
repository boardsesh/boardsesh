// React binding for the one wall-driver rule (lib/session-timer/driver-rule.ts).
// Reads crew membership and wall ownership, and hands back a value that only
// changes when the answer does.

import { useMemo } from 'react';
import { useIsCrewSession } from '../providers/queue-provider';
import { useBoardConnectionState } from '../components/ble/use-board-connection-state';
import { deriveSessionTimerDriver, type SessionTimerDriver } from '../lib/session-timer/driver-rule';
import { useDevScenarioWall } from '../dev/stories/load';

export function useSessionTimerDriver(): SessionTimerDriver {
  const isCrewSession = useIsCrewSession();
  const boardConnection = useBoardConnectionState();
  // A crew story's fake wall holder (#5382). Dev only: null in a release build.
  const scenarioWall = useDevScenarioWall();
  const inAppBoardConnection = scenarioWall?.connection ?? boardConnection.inAppBoardConnection;
  const holderDisplayName = scenarioWall ? (scenarioWall.holderDisplayName ?? null) : boardConnection.holderDisplayName;
  const localConnected = boardConnection.localConnected;

  return useMemo(
    () =>
      deriveSessionTimerDriver({
        isCrewSession,
        inAppBoardConnection,
        localBleConnected: localConnected,
        holderDisplayName,
      }),
    [isCrewSession, inAppBoardConnection, localConnected, holderDisplayName],
  );
}
