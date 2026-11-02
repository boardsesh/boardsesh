// "This stored session is over" for a session the app never rejoined (#6903).
//
// `WorkoutRunSessionSync` ends a workout run when it SEES the session id go
// away. A cold start onto a session that ended meanwhile never sets the id at
// all: the queue's restore asks `sessionStatus`, finds it ended or missing, and
// drops the stored id. Without this signal the run would sit on disk until the
// next session replaced it, its last copy never sent and no recap kept. The
// restore announces the id here, and the sync ends that session's run the
// same way it ends any other.
//
// Announced before the sync subscribes (both start on the cold start), an id
// waits here and is handed over on subscribe.

type Listener = (sessionId: string) => void;

const listeners = new Set<Listener>();
let waiting: string[] = [];

/** The stored session `sessionId` turned out to be over on a cold start. */
export function announceStoredSessionEnded(sessionId: string): void {
  if (listeners.size === 0) {
    if (!waiting.includes(sessionId)) waiting.push(sessionId);
    return;
  }
  for (const listener of listeners) listener(sessionId);
}

/** Hears every announced id, the ones announced before this call included. */
export function subscribeStoredSessionEnded(listener: Listener): () => void {
  listeners.add(listener);
  const handOver = waiting;
  waiting = [];
  for (const sessionId of handOver) listener(sessionId);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only. */
export function resetStoredSessionEndedForTests(): void {
  listeners.clear();
  waiting = [];
}
