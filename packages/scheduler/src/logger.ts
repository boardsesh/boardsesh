/**
 * Minimal structured logger. Every scheduler entry point takes a logger so
 * tests can capture output instead of writing to stdout, and so the Railway
 * log stream gets one JSON object per line (searchable by `job`/`event`).
 */
export type LogFields = Record<string, unknown>;

export type SchedulerLogger = {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

function serialize(level: string, message: string, fields?: LogFields): string {
  return JSON.stringify({ level, service: 'scheduler', time: new Date().toISOString(), message, ...fields });
}

export const consoleLogger: SchedulerLogger = {
  info(message, fields) {
    console.info(serialize('info', message, fields));
  },
  warn(message, fields) {
    console.warn(serialize('warn', message, fields));
  },
  error(message, fields) {
    console.error(serialize('error', message, fields));
  },
};

// A wrapped error can nest (fetch → undici → the socket error); three links is
// plenty and keeps a pathological chain out of the log line.
const MAX_CAUSE_DEPTH = 3;

/**
 * Turns an unknown thrown value into a log-safe message.
 *
 * The `cause` chain is unwrapped because `fetch` rejects with a bare
 * `fetch failed` and hides the actual reason — `ECONNREFUSED`, `ENOTFOUND`, a
 * TLS failure — in `cause`. `docs/scheduler.md`'s runbook reads `lastError` to
 * tell a blocked egress IP from a DNS problem, and `fetch failed` on its own
 * answers neither.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const messages = [error.message];
  let cause: unknown = error.cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cause instanceof Error; depth += 1) {
    if (cause.message !== '' && !messages.includes(cause.message)) {
      messages.push(cause.message);
    }
    cause = cause.cause;
  }

  return messages.filter((message) => message !== '').join(': ') || error.name;
}
