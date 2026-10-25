// Keeps the session's shared rest clock in step with this phone (#5382).
// Renders nothing, and never re-renders on a tick: it subscribes to the
// rest-timer store's local actions, not its state.
//
// Mounted whenever there is a session (RestTimerRuntime), armed or not, so the
// first ARM, the seed's "no clock yet" and a crewmate's clock all reach this
// phone. The rules live in lib/crew-rest-publisher.ts; this only wires them to
// the queue provider, the settings and the store.

import { useEffect, useRef } from 'react';
import {
  useIsCrewSession,
  useQueueActions,
  useQueueSessionControls,
  useQueueSessionId,
} from '../../providers/queue-provider';
import { useSetting } from '../../settings';
import { getOwnRestPacing } from '../../hooks/use-effective-rest-pacing';
import { nowMs } from '../../lib/clock';
import { reportHandledError } from '../../lib/error-reporting';
import { resetCrewCadenceLink, subscribeCrewCadenceSnapshots } from '../../lib/crew-rest-cadence';
import { createCrewRestPublisher } from '../../lib/crew-rest-publisher';
import {
  clearCrewCadence,
  getRestTimerState,
  setRestTimerWallQueueItemReader,
  subscribeLocalRestTimerActions,
} from '../../lib/rest-timer-store';
import { resetServerClock } from '../../lib/server-clock';

export function RestTimerCrewPublisher() {
  const { sessionId } = useQueueSessionId();
  if (sessionId === null) return null;
  // One publisher per session: a new session starts with an empty queue, a
  // fresh revision floor and no clock samples from the last one.
  return <SessionCrewPublisher key={sessionId} sessionId={sessionId} />;
}

function SessionCrewPublisher({ sessionId }: { sessionId: string }) {
  const { setSessionRestCadence, getQueueSnapshot } = useQueueActions();
  const { participantId } = useQueueSessionControls();
  const [targetSeconds] = useSetting('restTimerTargetSeconds');
  const [mode] = useSetting('restTimerMode');
  const [autoAdvance] = useSetting('restTimerAutoAdvance');
  const isCrewSession = useIsCrewSession();
  const isCrewSessionRef = useRef(isCrewSession);
  isCrewSessionRef.current = isCrewSession;

  // Read through refs: the publisher lives for the whole session, and a new
  // participant id or action identity is not a reason to drop its queue.
  const participantIdRef = useRef(participantId);
  participantIdRef.current = participantId;
  const sendRef = useRef(setSessionRestCadence);
  sendRef.current = setSessionRestCadence;
  const getQueueSnapshotRef = useRef(getQueueSnapshot);
  getQueueSnapshotRef.current = getQueueSnapshot;

  const publisherRef = useRef<ReturnType<typeof createCrewRestPublisher> | null>(null);

  useEffect(() => {
    const publisher = createCrewRestPublisher({
      sessionId,
      send: (input) => sendRef.current(input),
      getOwnParticipantId: () => participantIdRef.current,
      getState: getRestTimerState,
      getOwnPacing: getOwnRestPacing,
      nowMs,
      report: (error, action) =>
        reportHandledError(error, { tags: { source: 'crew-rest-clock', op: action.toLowerCase() } }),
    });
    publisherRef.current = publisher;
    setRestTimerWallQueueItemReader(() => getQueueSnapshotRef.current().currentClimbQueueItem?.uuid ?? null);
    const unsubscribeActions = subscribeLocalRestTimerActions(publisher.handleLocalAction);
    const unsubscribeSnapshots = subscribeCrewCadenceSnapshots(publisher.handleSnapshot);
    return () => {
      unsubscribeActions();
      unsubscribeSnapshots();
      publisher.dispose();
      publisherRef.current = null;
      setRestTimerWallQueueItemReader(null);
      resetCrewCadenceLink();
      resetServerClock();
      // A clock this app cannot run is only held, so it goes with its session
      // here: on an unarmed phone nothing else would drop it (RestTimerSessionSync
      // mounts only while armed), and its "needs a newer version" note would
      // outlive the session. A clock this phone follows is armed, and
      // RestTimerSessionSync turns it off with the session.
      const { crew } = getRestTimerState();
      if (crew !== null && crew.sessionId === sessionId && crew.config === null) clearCrewCadence();
    };
  }, [sessionId]);

  // A settings edit (Settings › Timers, or the sheet with no crew clock yet)
  // hands a session alone this phone's pacing, as the timer always followed the
  // settings. Not in a crew (Marco, 2026-10-25): there the shared clock changes
  // only from the timer's own controls, which send the crew's config with that
  // one change (editCrewRestPacing), and a default edited in Settings › Timers
  // stays the climber's own. Not on mount: that is no edit.
  const mountedSettingsRef = useRef(false);
  useEffect(() => {
    if (!mountedSettingsRef.current) {
      mountedSettingsRef.current = true;
      return;
    }
    if (isCrewSessionRef.current) return;
    publisherRef.current?.noteSettingsEdited();
  }, [targetSeconds, mode, autoAdvance]);

  return null;
}
