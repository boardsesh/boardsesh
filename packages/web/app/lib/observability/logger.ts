import * as Sentry from '@sentry/nextjs';

/**
 * Structured logging for the Next server.
 *
 * `www` runs in a Railway container now, and Railway's log explorer parses a
 * JSON line into searchable attributes (`@level`, `@requestId`, and numeric
 * fields it can compare and range over). A plain `console.error('Failed:', err)`
 * arrives as one opaque string and is filterable only by substring.
 *
 * The envelope is copied from `packages/scheduler/src/logger.ts` on purpose —
 * same key names, same order, same zero dependencies — so web and scheduler
 * lines normalise identically in the explorer and one saved query covers both.
 *
 * Deliberately NOT the backend's winston logger hoisted into a shared package.
 * That one carries an `appendSplatFormat` compat shim, a
 * `Symbol.for('boardsesh.errorInstance')` handshake with `SentryWinstonTransport`,
 * and a lazy `instanceIdProvider` closure that exists only to dodge a pubsub
 * import cycle. None of it serves Next, and winston in a Next server bundle
 * drags in `logform` + `colors` for nothing.
 */
export type LogFields = Record<string, unknown>;

export type LogLevel = 'info' | 'warn' | 'error';

export type JsonLogger = {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

export type JsonLoggerOptions = {
  /** Emitted as the `service` attribute. `'web'` for everything in this app. */
  service: string;
  /**
   * `false` emits one JSON object per line (what Railway parses); `true` emits
   * a readable one-liner for a terminal. Defaults to `NODE_ENV !== 'production'`.
   *
   * An explicit option rather than a bare env read at every call site because
   * `packages/web/vite.config.ts` compiles `process.env.NODE_ENV` to the literal
   * `"test"`, so a test can only reach the production branch by asking for it.
   */
  pretty?: boolean;
  /** Trace-id source. Overridable so a test can assert the failure path. */
  traceId?: () => string | undefined;
};

/** Characters of the trace id shown in the dev one-liner's `[t:…]` prefix. */
const TRACE_TAG_LENGTH = 8;

/**
 * The current trace id, which is the join key from a Railway log line to a
 * Sentry event.
 *
 * `getCurrentScope()` and `getPropagationContext()` are both plain synchronous
 * getters — `getPropagationContext()` is literally
 * `return this._propagationContext` (@sentry/core 10.37.0,
 * `build/cjs/scope.js:604`) — and `Scope`'s constructor seeds
 * `_propagationContext` with a generated `traceId` (`scope.js:90`), so the read
 * is defined even before `Sentry.init` runs and even outside a request. That is
 * what lets this be called from a server component, a route handler, and an
 * `after()` callback alike without any of them awaiting anything.
 */
export function readTraceId(): string | undefined {
  const { traceId } = Sentry.getCurrentScope().getPropagationContext();
  return typeof traceId === 'string' && traceId.length > 0 ? traceId : undefined;
}

/**
 * Write one line to the right stream.
 *
 * Railway maps stderr to `@level:error` in its own ingest, independently of the
 * `level` attribute in the payload, so warn/error MUST NOT go to stdout or they
 * show up as info-level in the explorer's default view.
 *
 * `process.stdout` is absent on the Edge runtime and in a browser bundle (a
 * client component importing this by mistake), where writing would throw inside
 * a catch block and mask the original failure. `console` keeps the same
 * severity split there.
 */
function writeLine(stream: 'stdout' | 'stderr', line: string): void {
  const target = stream === 'stderr' ? process.stderr : process.stdout;
  if (target && typeof target.write === 'function') {
    target.write(`${line}\n`);
    return;
  }

  if (stream === 'stderr') {
    console.error(line);
  } else {
    console.info(line);
  }
}

function serializeJson(
  level: LogLevel,
  service: string,
  message: string,
  traceId: string | undefined,
  fields: LogFields | undefined,
): string {
  // `traceId` spreads last so a caller-supplied field of the same name can
  // never shadow the real one — a log line whose trace id doesn't match the
  // Sentry event is worse than no trace id at all.
  return JSON.stringify({
    level,
    service,
    time: new Date().toISOString(),
    message,
    ...fields,
    ...(traceId ? { traceId } : {}),
  });
}

function serializePretty(
  level: LogLevel,
  message: string,
  traceId: string | undefined,
  fields: LogFields | undefined,
): string {
  // `[t:abcd1234] [info] message {…}` mirrors the backend's dev format (which
  // prefixes an instance id the same way), so one `tail | grep` habit works
  // across both processes.
  const tracePrefix = traceId ? `[t:${traceId.slice(0, TRACE_TAG_LENGTH)}] ` : '';
  const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
  return `${tracePrefix}[${level}] ${message}${suffix}`;
}

/**
 * A logger emitting one `{ level, service, time, message, …fields, traceId }`
 * object per line in production, and a readable one-liner in development.
 */
export function createJsonLogger({
  service,
  pretty = process.env.NODE_ENV !== 'production',
  traceId = readTraceId,
}: JsonLoggerOptions): JsonLogger {
  const emit = (level: LogLevel, stream: 'stdout' | 'stderr', message: string, fields?: LogFields): void => {
    let currentTraceId: string | undefined;
    try {
      currentTraceId = traceId();
    } catch {
      // Never let telemetry plumbing break a log call. The Sentry SDK is
      // resilient here, but a future async-context strategy that throws would
      // otherwise take down every handler that logs.
      currentTraceId = undefined;
    }

    let line: string;
    try {
      line = pretty
        ? serializePretty(level, message, currentTraceId, fields)
        : serializeJson(level, service, message, currentTraceId, fields);
    } catch {
      // `JSON.stringify` throws on a circular field (a Request, a pg client, a
      // React element someone passed by accident). Losing the fields beats
      // throwing out of a catch block and replacing the real error with a
      // TypeError about a converting circular structure.
      line = pretty
        ? serializePretty(level, message, currentTraceId, undefined)
        : serializeJson(level, service, message, currentTraceId, { fieldsError: 'unserializable' });
    }

    writeLine(stream, line);
  };

  return {
    info: (message, fields) => emit('info', 'stdout', message, fields),
    warn: (message, fields) => emit('warn', 'stderr', message, fields),
    error: (message, fields) => emit('error', 'stderr', message, fields),
  };
}

/** The app-wide logger. Prefer `createRequestLogger` inside a request. */
export const webLogger = createJsonLogger({ service: 'web' });

// A wrapped error can nest (fetch → undici → the socket error); three links is
// plenty and keeps a pathological chain out of the log line.
const MAX_CAUSE_DEPTH = 3;

/**
 * Turns an unknown thrown value into a log-safe message.
 *
 * The `cause` chain is unwrapped because `fetch` rejects with a bare
 * `fetch failed` and hides the actual reason — `ECONNREFUSED`, `ENOTFOUND`, a
 * TLS failure — in `cause`. Web hits exactly that calling Aurora and the
 * GraphQL backend, and `fetch failed` on its own tells an on-call reader
 * nothing about which.
 *
 * Ported from `packages/scheduler/src/logger.ts`; keep the two in step.
 *
 * For a value that might be a graphql-request `ClientError` or a drizzle
 * `DrizzleQueryError` — both of which embed the whole query in `.message` —
 * use `compactErrorMessage` from `./compact-error` instead, which strips and
 * truncates them. This helper deliberately does not truncate.
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
