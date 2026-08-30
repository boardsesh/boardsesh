import util from 'node:util';
import { createLogger, format, transports, type Logger, type LoggerOptions } from 'winston';
import { SentryWinstonTransport } from './sentry-transport';

// Explicit annotation prevents TS2742 from inferring a path through the
// package manager's isolated virtual-store install layout.
type FormatFactory = ReturnType<typeof format>;

type InstanceIdProvider = () => string | null;

let instanceIdProvider: InstanceIdProvider | null = null;

export function setInstanceIdProvider(provider: InstanceIdProvider | null): void {
  instanceIdProvider = provider;
}

const SPLAT = Symbol.for('splat');
const TRAILING_ERROR = Symbol('boardsesh.trailingError');
// Global-registry symbol so SentryWinstonTransport can read the same key
// without an import cycle between logger.ts and sentry-transport.ts.
const ERROR_INSTANCE = Symbol.for('boardsesh.errorInstance');

type LoggerInfoRecord = Record<string | symbol, unknown>;

type ErrorDetails = {
  name: string;
  message: string;
  stack?: string;
};

function errorDetails(error: Error): ErrorDetails {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

// Winston's `Logger.log()` merges the first trailing arg into `info` only when
// it's an object — strings and other primitives are stashed under
// `info[Symbol.for('splat')]` and the default `format.splat()` only consumes
// them when the message has `%s`-style tokens. The old console patch we're
// replacing always emitted every trailing arg, so this format renders leftover
// splat entries while preserving trailing Error details as structured fields.
export const appendSplatFormat: FormatFactory = format((info) => {
  const infoRecord = info as LoggerInfoRecord;
  const splatValue = infoRecord[SPLAT];
  if (!Array.isArray(splatValue)) return info;

  delete infoRecord[SPLAT];
  if (splatValue.length === 0) return info;

  const rendered = splatValue
    .map((arg) => {
      if (arg instanceof Error) {
        infoRecord.error ??= errorDetails(arg);
        infoRecord.stack ??= arg.stack;
        infoRecord[TRAILING_ERROR] = true;
        // Preserve the live Error reference for SentryWinstonTransport. The
        // `error` field above is already flattened to a serialisable shape
        // ({ name, message, stack }) for JSON output, which loses
        // `instanceof Error` and any cause chain or custom subclass info.
        infoRecord[ERROR_INSTANCE] ??= arg;
        return arg.stack ?? `${arg.name}: ${arg.message}`;
      }
      if (typeof arg === 'string') return arg;
      return util.inspect(arg, { depth: 4, breakLength: Infinity });
    })
    .join(' ');
  info.message = `${String(info.message)} ${rendered}`;
  return info;
});

export const instanceIdFormat: FormatFactory = format((info) => {
  const instanceId = instanceIdProvider?.();
  if (instanceId) info.instanceId = instanceId.slice(0, 8);
  return info;
});

const devPrintf = format.printf((info) => {
  const { level, message, instanceId, ...metadata } = info as Record<string, unknown> & {
    level: string;
    message: unknown;
  };
  const hasTrailingError = Boolean((info as LoggerInfoRecord)[TRAILING_ERROR]);
  const rest = Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) =>
        key !== 'service' &&
        key !== 'pid' &&
        key !== 'timestamp' &&
        (!hasTrailingError || (key !== 'error' && key !== 'stack')),
    ),
  );
  const tag = typeof instanceId === 'string' && instanceId ? `[i:${instanceId}] ` : '';
  const meta = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
  return `${tag}[${level}] ${String(message)}${meta}`;
});

type BackendLoggerOptions = {
  loggerTransports?: LoggerOptions['transports'];
  logLevel?: string;
  nodeEnv?: string;
  processId?: number;
};

export function createBackendLogger(options: BackendLoggerOptions = {}): Logger {
  const isProduction = (options.nodeEnv ?? process.env.NODE_ENV) === 'production';
  return createLogger({
    level: options.logLevel ?? process.env.LOG_LEVEL ?? 'info',
    exitOnError: false,
    defaultMeta: { service: 'backend', pid: options.processId ?? process.pid },
    format: isProduction
      ? format.combine(
          instanceIdFormat(),
          format.timestamp(),
          format.errors({ stack: true }),
          appendSplatFormat(),
          format.json(),
        )
      : format.combine(instanceIdFormat(), appendSplatFormat(), format.colorize(), devPrintf),
    transports: options.loggerTransports ?? [
      new transports.Console({ stderrLevels: ['error', 'warn'] }),
      new SentryWinstonTransport({ nodeEnv: options.nodeEnv ?? process.env.NODE_ENV }),
    ],
  });
}

export const logger = createBackendLogger();
