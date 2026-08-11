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

/** Turns an unknown thrown value into a log-safe message. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
