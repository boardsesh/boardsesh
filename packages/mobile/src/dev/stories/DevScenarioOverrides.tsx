import { useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import {
  QueueLiveStatsContext,
  QueueSessionControlContext,
  QueueSessionIdContext,
  QueueSharedSessionContext,
} from '../../providers/queue/queue-contexts';
import { getScenarioOverrides, subscribeScenarioOverrides } from './scenario-overrides';

/**
 * Re-provides the queue contexts with a story's fake values patched in, for
 * everything below it: every route, the play drawer, the persistent queue bar.
 *
 * Mounted in dev builds only (see `load.ts`), just inside the providers it
 * patches. With no scenario active it hands down the real context objects
 * unchanged, so no consumer re-renders because this exists.
 */
export function DevScenarioOverrides({ children }: { children: ReactNode }) {
  const overrides = useSyncExternalStore(subscribeScenarioOverrides, getScenarioOverrides, getScenarioOverrides);
  const queuePatch = overrides?.queue;
  const patchedSharedSession = queuePatch?.isSharedSession;
  const patchedSessionId = queuePatch?.sessionId;
  const patchedSessionUsers = queuePatch?.sessionUsers;

  const sharedSession = useContext(QueueSharedSessionContext);
  const sessionIdValue = useContext(QueueSessionIdContext);
  const sessionControls = useContext(QueueSessionControlContext);
  const liveStats = useContext(QueueLiveStatsContext);

  const sharedSessionValue = useMemo(
    () =>
      sharedSession === null || patchedSharedSession === undefined
        ? sharedSession
        : { isSharedSession: patchedSharedSession },
    [sharedSession, patchedSharedSession],
  );
  const sessionIdContextValue = useMemo(
    () =>
      sessionIdValue === null || patchedSessionId === undefined
        ? sessionIdValue
        : { ...sessionIdValue, sessionId: patchedSessionId },
    [sessionIdValue, patchedSessionId],
  );
  const sessionControlsValue = useMemo(
    () =>
      sessionControls === null || patchedSessionId === undefined
        ? sessionControls
        : { ...sessionControls, sessionId: patchedSessionId },
    [sessionControls, patchedSessionId],
  );
  const liveStatsValue = useMemo(
    () =>
      liveStats === null || patchedSessionUsers === undefined
        ? liveStats
        : { ...liveStats, sessionUsers: patchedSessionUsers },
    [liveStats, patchedSessionUsers],
  );

  return (
    <QueueSharedSessionContext value={sharedSessionValue}>
      <QueueSessionIdContext value={sessionIdContextValue}>
        <QueueSessionControlContext value={sessionControlsValue}>
          <QueueLiveStatsContext value={liveStatsValue}>{children}</QueueLiveStatsContext>
        </QueueSessionControlContext>
      </QueueSessionIdContext>
    </QueueSharedSessionContext>
  );
}
