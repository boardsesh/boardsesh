/** Replay only a fixture reset statement which PostgreSQL aborted as a deadlock victim. */
function isDeadlock(error: unknown): boolean {
  let cause: unknown = error;
  for (let depth = 0; depth < 8 && typeof cause === 'object' && cause !== null; depth += 1) {
    if ('code' in cause && cause.code === '40P01') return true;
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return false;
}

export async function retryFixtureReset(reset: () => Promise<unknown>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await reset();
      return;
    } catch (error: unknown) {
      // A deadlock rolls the whole autocommit TRUNCATE back. Background reads
      // can finish before this bounded retry; seed writes and assertions never
      // run here, and every other SQL/application error is rethrown immediately.
      if (attempt >= 3 || !isDeadlock(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
}
