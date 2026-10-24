// Whether a database setup attempt (WAL switch, queue table, schema migrations) is
// running right now. Dependency-free so the launch update gate can read it (#6689).
//
// Migrations run as write transactions on their own connection. On Android a JS
// reload does not close that connection, so a reload landing mid-migration would
// leave the write lock held for the rest of the process: the replacement runtime
// could then never migrate, and offline storage would stay off all session. The
// gate therefore does not reload while an attempt is running. Between attempts
// (the retry ladder's sleeps) no transaction is open, and a reload is safe.
//
// A count rather than a flag: a dead-handle recovery starts a second init chain
// (#5410), and the old chain finishing must not report the new one as idle.

let runningAttempts = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    // Called from inside the init chain: a listener must never become an init failure.
    try {
      listener();
    } catch {
      // The gate fails open on its own; nothing to add here.
    }
  }
}

/** Marks one attempt as running. Call the returned function once it settles. */
export function beginDatabaseInitAttempt(): () => void {
  runningAttempts += 1;
  if (runningAttempts === 1) notify();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    runningAttempts -= 1;
    if (runningAttempts === 0) notify();
  };
}

export function isDatabaseInitAttemptRunning(): boolean {
  return runningAttempts > 0;
}

/** Called whenever attempts start or stop running. Returns the unsubscribe. */
export function subscribeDatabaseInitAttempt(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetDatabaseInitActivityForTests(): void {
  runningAttempts = 0;
  listeners.clear();
}
