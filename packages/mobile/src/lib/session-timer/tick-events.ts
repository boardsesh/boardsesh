// A logged climb, as the session timer's sinks hear about it (#5397).
//
// The tick saver calls `noteSessionTimerTick` once per committed tick, before
// the rest timer hears about it. A sink that wants a tick with the rest timer
// off (the gym timer restarts on every logged climb then, as it always has)
// subscribes here. Outbox replay never calls this: a tick that reaches the
// server twenty minutes late must not restart a clock on the wall.

import { getRestTimerStartMs } from '../rest-timer';

export type SessionTimerTick = {
  /** When the climb was logged, or null when the timestamp did not parse. */
  climbedAtMs: number | null;
  nowMs: number;
};

type SessionTimerTickListener = (tick: SessionTimerTick) => void;

const listeners = new Set<SessionTimerTickListener>();

/** Never throws: a sink that fails must not break the save that called this. */
export function noteSessionTimerTick(climbedAtIso: string, nowMs: number): void {
  const tick: SessionTimerTick = { climbedAtMs: getRestTimerStartMs(climbedAtIso), nowMs };
  for (const listener of listeners) {
    try {
      listener(tick);
    } catch {
      // One sink's failure is that sink's problem.
    }
  }
}

export function subscribeSessionTimerTicks(listener: SessionTimerTickListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
