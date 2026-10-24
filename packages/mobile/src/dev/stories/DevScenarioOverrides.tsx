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
  const patchedCrewSession = queuePatch?.isCrewSession;
  const patchedSessionId = queuePatch?.sessionId;
  const patchedSessionUsers = queuePatch?.sessionUsers;

  const sharedSession = useContext(QueueSharedSessionContext);
  const sessionIdValue = useContext(QueueSessionIdContext);
  const sessionControls = useContext(QueueSessionControlContext);
  const liveStats = useContext(QueueLiveStatsContext);

  // A browsing crew is always a crew, so a patched `isSharedSession` carries
  // `isCrewSession` with it unless the story says otherwise.
  const sharedSessionValue = useMemo(
    () =>
      sharedSession === null || (patchedSharedSession === undefined && patchedCrewSession === undefined)
        ? sharedSession
        : {
            isSharedSession: patchedSharedSession ?? sharedSession.isSharedSession,
            isCrewSession: patchedCrewSession ?? patchedSharedSession ?? sharedSession.isCrewSession,
          },
    [sharedSession, patchedSharedSession, patchedCrewSession],
  );
  // The real provider derives the member set from the roster, so a patched roster
  // patches it too. Same rule: anonymous members have no userId to match.
  const patchedMemberUserIds = useMemo<ReadonlySet<string> | undefined>(
    () =>
      patchedSessionUsers === undefined
        ? undefined
        : new Set(patchedSessionUsers.flatMap((user) => (user.userId ? [user.userId] : []))),
    [patchedSessionUsers],
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
      sessionControls === null || (patchedSessionId === undefined && patchedMemberUserIds === undefined)
        ? sessionControls
        : {
            ...sessionControls,
            sessionId: patchedSessionId ?? sessionControls.sessionId,
            sessionMemberUserIds: patchedMemberUserIds ?? sessionControls.sessionMemberUserIds,
          },
    [sessionControls, patchedSessionId, patchedMemberUserIds],
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
