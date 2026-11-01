// The workout data behind the session screens (#6903): the summary, session
// detail and feed cards. Reads `sessionWorkouts` / `sessionWorkoutHeadlines`
// (`@boardsesh/graphql/operations/session-workouts`), and falls back to this
// phone's own run while the server copy is behind. Which workout each screen
// shows: `session-workout-view-model.ts`.

import { useEffect, useMemo, useRef } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GET_SESSION_WORKOUTS,
  GET_SESSION_WORKOUT_HEADLINES,
  MAX_SESSION_WORKOUT_HEADLINE_IDS,
  type GetSessionWorkoutHeadlinesQueryResponse,
  type GetSessionWorkoutsQueryResponse,
  type SessionWorkoutHeadlineResult,
  type SessionWorkoutResult,
} from '@boardsesh/graphql/operations/session-workouts';
import type { PendingSessionWrites } from '@boardsesh/offline-sync';
import { getHttpClient } from '../../../lib/graphql/client';
import { useProfile } from '../../../lib/graphql/hooks';
import { sessionWorkoutHeadlinesQueryKey, sessionWorkoutsQueryKey } from '../../../lib/graphql/query-keys';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { useIsOffline } from '../../../hooks/use-is-offline';
import { useEndedWorkout } from '../../../lib/ended-workout-store';
import { useWorkoutRunRecord } from '../../../lib/workout-run-store';
import { readPendingSessionWrites } from '../../../offline/pending-tick';
import { subscribeMutationDelivery } from '../../../offline/offline-sync-adapter';
import {
  chooseSessionWorkout,
  headlineRequests,
  headlineView,
  localWorkoutView,
  serverWorkoutView,
  type FormatGradeLabel,
  type SessionWorkoutScope,
} from './session-workout-view-model';
import type { SessionWorkoutView, WorkoutHeadlineView } from './types';

/** What the summary and session detail need to draw a session's workout. */
export type SessionWorkoutState = {
  workout: SessionWorkoutView;
  /**
   * Ticks this phone logged in the session that the server doesn't have yet.
   * While above zero the summary shows the phone's own counts and the
   * "still saving" note instead of server totals that can read zero.
   */
  pendingTicks: number;
  /** No connection to save them over: the note says so. */
  offline: boolean;
};

const SESSION_WORKOUTS_STALE_TIME_MS = 30 * 1000;
const HEADLINES_STALE_TIME_MS = 60 * 1000;
const NO_WORKOUTS: readonly SessionWorkoutResult[] = [];
const NO_PENDING_WRITES: PendingSessionWrites = { ticks: 0, workouts: 0 };
const NO_HEADLINES: ReadonlyMap<string, WorkoutHeadlineView> = new Map();

/** Daily feed cards ("daily:<user>:<day>") are not sessions and never hold a workout. */
const canHoldWorkout = (sessionId: string | null): sessionId is string =>
  sessionId !== null && sessionId !== '' && !sessionId.startsWith('daily:');

const pendingSessionWritesQueryKey = (sessionId: string | null) => ['pendingSessionWrites', sessionId] as const;

/**
 * What this phone still has to send for `sessionId`, read again whenever a
 * queued tick or workout write is delivered. A null id reads nothing.
 */
function usePendingSessionWrites(sessionId: string | null): PendingSessionWrites {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: pendingSessionWritesQueryKey(sessionId),
    queryFn: () => readPendingSessionWrites(sessionId ?? ''),
    enabled: sessionId !== null,
    // A local SQLite read: never paused for a dead signal.
    networkMode: 'always',
    staleTime: 0,
  });
  useEffect(() => {
    if (sessionId === null) return undefined;
    return subscribeMutationDelivery((event) => {
      if (event.tableName !== 'boardsesh_ticks' && event.tableName !== 'session_workouts') return;
      void queryClient.invalidateQueries({ queryKey: pendingSessionWritesQueryKey(sessionId) });
      // The server copy just changed: read it now, not when the drain ends.
      if (event.tableName === 'session_workouts' && event.status === 'acknowledged') {
        void queryClient.invalidateQueries({ queryKey: sessionWorkoutsQueryKey(sessionId) });
      }
    });
  }, [queryClient, sessionId]);
  return data ?? NO_PENDING_WRITES;
}

/**
 * The workout to draw for a session, or undefined when it had none.
 *
 * `scope: 'viewer'` (the summary) shows only the viewer's own workout;
 * `'session'` (session detail) falls back to the session owner's, then the
 * first one listed. The viewer's own comes from this phone (its live run, or the
 * recap kept when the session ended) while the phone still has ticks or a
 * workout write for the session queued, or while the server has none.
 *
 * `sessionOwnerUserId` is the session's creator, which session detail already
 * has from its own query (`SessionDetail.ownerUserId`).
 *
 * The workout keeps its identity while the chosen answer does: a change in
 * connectivity or the pending count rebuilds only the thin outer object, so
 * the grouped rows below never redraw for it.
 */
export function useSessionWorkoutView(
  sessionId: string | null | undefined,
  scope: SessionWorkoutScope = 'viewer',
  sessionOwnerUserId: string | null = null,
): SessionWorkoutState | undefined {
  const id = sessionId ?? null;
  const serverSessionId = canHoldWorkout(id) ? id : null;
  const { data: profile } = useProfile();
  const viewerUserId = profile?.id ?? null;
  const { formatGrade } = useGradeFormat();
  const offline = useIsOffline();

  const liveRecord = useWorkoutRunRecord(id);
  const endedRecord = useEndedWorkout(id);
  // A recap counts only for the account it was kept for: a shared phone never
  // shows one climber's workout as another's.
  const ownRecap = endedRecord && viewerUserId !== null && endedRecord.userId === viewerUserId ? endedRecord : null;
  const localRecord = liveRecord ?? ownRecap;
  const pending = usePendingSessionWrites(localRecord ? serverSessionId : null);

  const { data: workouts = NO_WORKOUTS } = useQuery({
    queryKey: sessionWorkoutsQueryKey(serverSessionId),
    queryFn: () =>
      getHttpClient()
        .request<GetSessionWorkoutsQueryResponse>(GET_SESSION_WORKOUTS, { sessionId: serverSessionId })
        .then((response) => response.sessionWorkouts),
    enabled: serverSessionId !== null,
    staleTime: SESSION_WORKOUTS_STALE_TIME_MS,
  });

  const localView = useMemo(
    () => (localRecord ? localWorkoutView(localRecord, viewerUserId ?? '', formatGrade) : null),
    [localRecord, viewerUserId, formatGrade],
  );

  const phoneAhead = pending.ticks > 0 || pending.workouts > 0;
  const choice = useMemo(
    () =>
      chooseSessionWorkout({
        workouts,
        viewerUserId,
        sessionOwnerUserId: scope === 'session' ? sessionOwnerUserId : null,
        localAvailable: localView !== null,
        phoneAhead,
        scope,
      }),
    [workouts, viewerUserId, sessionOwnerUserId, localView, phoneAhead, scope],
  );
  const chosenServerWorkout = choice?.source === 'server' ? choice.workout : null;
  const serverView = useMemo(
    () => (chosenServerWorkout ? serverWorkoutView(chosenServerWorkout, formatGrade) : null),
    [chosenServerWorkout, formatGrade],
  );
  const workout = choice?.source === 'local' ? localView : serverView;
  const pendingTicks = choice?.source === 'local' ? pending.ticks : 0;

  return useMemo(() => (workout ? { workout, pendingTicks, offline } : undefined), [workout, pendingTicks, offline]);
}

function fetchHeadlines(sessionIds: readonly string[]): Promise<SessionWorkoutHeadlineResult[]> {
  return getHttpClient()
    .request<GetSessionWorkoutHeadlinesQueryResponse>(GET_SESSION_WORKOUT_HEADLINES, { sessionIds })
    .then((response) => response.sessionWorkoutHeadlines);
}

type HeadlineViewCache = {
  format: FormatGradeLabel;
  views: WeakMap<SessionWorkoutHeadlineResult, WorkoutHeadlineView>;
};

/**
 * Feed-card workout lines by session id; sessions without a workout are
 * absent. Takes the feed's session ids page by page and sends one
 * `sessionWorkoutHeadlines` request per page (`headlineRequests`), so loading
 * the next page leaves the earlier pages' answers alone.
 *
 * The map keeps its identity while no line changes, and each line keeps its
 * object while its answer does, so memoized cards (and a `renderItem` that
 * lists the map) re-render only for a line that moved.
 */
export function useSessionWorkoutHeadlines(
  sessionIdPages: readonly (readonly string[])[],
): ReadonlyMap<string, WorkoutHeadlineView> {
  const { formatGrade } = useGradeFormat();
  const requests = useMemo(() => headlineRequests(sessionIdPages, MAX_SESSION_WORKOUT_HEADLINE_IDS), [sessionIdPages]);
  const answers = useQueries({
    queries: requests.map((sessionIds) => ({
      queryKey: sessionWorkoutHeadlinesQueryKey(sessionIds),
      queryFn: () => fetchHeadlines(sessionIds),
      staleTime: HEADLINES_STALE_TIME_MS,
    })),
  });
  const cacheRef = useRef<HeadlineViewCache>({ format: formatGrade, views: new WeakMap() });
  const previousRef = useRef<ReadonlyMap<string, WorkoutHeadlineView>>(NO_HEADLINES);

  // A grade-format change draws every line again.
  if (cacheRef.current.format !== formatGrade) cacheRef.current = { format: formatGrade, views: new WeakMap() };
  const { views } = cacheRef.current;
  const next = new Map<string, WorkoutHeadlineView>();
  for (const answer of answers) {
    for (const headline of answer.data ?? []) {
      let view = views.get(headline);
      if (!view) {
        view = headlineView(headline, formatGrade);
        views.set(headline, view);
      }
      next.set(headline.sessionId, view);
    }
  }
  const previous = previousRef.current;
  if (previous.size === next.size && [...next].every(([key, view]) => previous.get(key) === view)) return previous;
  const result = next.size === 0 ? NO_HEADLINES : next;
  previousRef.current = result;
  return result;
}
