// The seams the workout data plugs into (#6903). The screens already draw a
// workout when these return one; today they return nothing, so every screen
// reads exactly as before.

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

/**
 * The viewer's workout for a session, or undefined when it had none.
 *
 * TODO(#6903, workout data PR): read `sessionWorkouts(sessionId)` (the
 * viewer's own entry), map the GraphQL `SessionWorkout` into
 * `SessionWorkoutView`, and while the outbox still holds this session's ticks
 * derive the stages on the phone from the local run and tick log
 * (`deriveWorkoutStages` in `@boardsesh/workout-summary`) and report the
 * pending count and connectivity.
 */
export function useSessionWorkoutView(sessionId: string | null | undefined): SessionWorkoutState | undefined {
  void sessionId;
  return undefined;
}

const NO_HEADLINES: ReadonlyMap<string, WorkoutHeadlineView> = new Map();

/**
 * Feed-card workout lines by session id. Sessions without a workout are absent.
 *
 * TODO(#6903, workout data PR): batch `sessionWorkoutHeadlines(sessionIds)`
 * (≤ 50 ids per request) and map each `SessionWorkoutHeadline` into
 * `WorkoutHeadlineView`.
 */
export function useSessionWorkoutHeadlines(sessionIds: readonly string[]): ReadonlyMap<string, WorkoutHeadlineView> {
  void sessionIds;
  return NO_HEADLINES;
}
