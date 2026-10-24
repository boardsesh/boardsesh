// React binding for the one wall-driver rule (lib/session-timer/driver-rule.ts).
// Reads crew membership and wall ownership, and hands back a value that only
// changes when the answer does.

import { useMemo } from 'react';
import { useIsCrewSession } from '../providers/queue-provider';
import { useBoardConnectionState } from '../components/ble/use-board-connection-state';
import { deriveSessionTimerDriver, type SessionTimerDriver } from '../lib/session-timer/driver-rule';

export function useSessionTimerDriver(): SessionTimerDriver {
  const isCrewSession = useIsCrewSession();
  const { inAppBoardConnection, localConnected, holderDisplayName } = useBoardConnectionState();

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
