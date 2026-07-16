/**
 * Structured logging seam for the location-sync importer.
 *
 * `location-sync` is a shared package, so it can't import the backend's winston
 * singleton directly (shared packages never depend on `backend`). Instead the
 * caller injects a structural logger. The shape matches winston's
 * `info(message, meta)` / `warn(message, meta)` signature, so the backend can
 * pass its winston logger straight through (per docs/logging.md) while other
 * hosts pass a string-callback adapter or the no-op below.
 */
export type LocationSyncLogFields = Record<string, unknown>;

export type LocationSyncLogLevel = 'debug' | 'info' | 'warn';

export type LocationSyncLogger = {
  debug(message: string, fields?: LocationSyncLogFields): void;
  info(message: string, fields?: LocationSyncLogFields): void;
  warn(message: string, fields?: LocationSyncLogFields): void;
};

/** Swallows every log line — the default when no logger is injected. */
export const noopLocationSyncLogger: LocationSyncLogger = {
  debug() {},
  info() {},
  warn() {},
};

/**
 * Adapts the importer's existing `log?: (message: string) => void` callback into
 * a {@link LocationSyncLogger}. Fields are appended as a JSON suffix so the
 * report lines stay greppable in plain string sinks; a winston-backed caller
 * should pass its logger directly instead of going through this adapter.
 */
export function toLocationSyncLogger(log?: (message: string) => void): LocationSyncLogger {
  if (!log) {
    return noopLocationSyncLogger;
  }

  const emit = (level: LocationSyncLogLevel, message: string, fields?: LocationSyncLogFields): void => {
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
    log(`[location-sync] [${level}] ${message}${suffix}`);
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
  };
}
