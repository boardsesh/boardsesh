export type DaemonOptions = {
  timeZone?: string;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  quietPollMs?: number;
  minDelayMinutes?: number;
  maxDelayMinutes?: number;
};

export type ResolvedDaemonOptions = {
  timeZone: string;
  quietHoursStart: number;
  quietHoursEnd: number;
  quietPollMs: number;
  minDelayMinutes: number;
  maxDelayMinutes: number;
};

export type DaemonLoopRuntime = {
  now?: () => Date;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
  onCycleError?: (error: unknown) => void;
};

export const DEFAULT_DAEMON_OPTIONS: ResolvedDaemonOptions = {
  timeZone: 'Australia/Sydney',
  quietHoursStart: 22,
  quietHoursEnd: 7,
  quietPollMs: 60_000,
  minDelayMinutes: 1,
  maxDelayMinutes: 15,
};

const HOUR_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

export function resolveDaemonOptions(options: DaemonOptions = {}): ResolvedDaemonOptions {
  const resolved: ResolvedDaemonOptions = {
    timeZone: options.timeZone ?? DEFAULT_DAEMON_OPTIONS.timeZone,
    quietHoursStart: options.quietHoursStart ?? DEFAULT_DAEMON_OPTIONS.quietHoursStart,
    quietHoursEnd: options.quietHoursEnd ?? DEFAULT_DAEMON_OPTIONS.quietHoursEnd,
    quietPollMs: options.quietPollMs ?? DEFAULT_DAEMON_OPTIONS.quietPollMs,
    minDelayMinutes: options.minDelayMinutes ?? DEFAULT_DAEMON_OPTIONS.minDelayMinutes,
    maxDelayMinutes: options.maxDelayMinutes ?? DEFAULT_DAEMON_OPTIONS.maxDelayMinutes,
  };

  // Hours must be valid clock hours — out-of-range values would never match the
  // formatter output and silently disable quiet hours.
  if (!isValidHour(resolved.quietHoursStart) || !isValidHour(resolved.quietHoursEnd)) {
    throw new Error(
      `Daemon quietHoursStart and quietHoursEnd must be integers in 0-23 ` +
        `(got start=${resolved.quietHoursStart}, end=${resolved.quietHoursEnd}).`,
    );
  }

  // An equal start/end would silently disable the daemon. Fail loud instead —
  // callers that actually want "always quiet" (pause mode) should use the
  // abort signal or stop the process.
  if (resolved.quietHoursStart === resolved.quietHoursEnd) {
    throw new Error(
      `Daemon quietHoursStart and quietHoursEnd must differ (got ${resolved.quietHoursStart} for both). ` +
        `Use a 1-hour window at minimum, or 0/0 is not a valid "disable quiet hours" shortcut.`,
    );
  }

  // A negative delay would make sleep() resolve immediately and busy-loop the
  // daemon; min must not exceed max so the random range stays well-formed.
  if (resolved.minDelayMinutes < 0) {
    throw new Error(`Daemon minDelayMinutes must be >= 0 (got ${resolved.minDelayMinutes}).`);
  }
  if (resolved.minDelayMinutes > resolved.maxDelayMinutes) {
    throw new Error(
      `Daemon minDelayMinutes must be <= maxDelayMinutes ` +
        `(got min=${resolved.minDelayMinutes}, max=${resolved.maxDelayMinutes}).`,
    );
  }

  // A non-positive quiet poll would busy-loop while waiting out quiet hours.
  if (resolved.quietPollMs <= 0) {
    throw new Error(`Daemon quietPollMs must be > 0 (got ${resolved.quietPollMs}).`);
  }

  return resolved;
}

export function isWithinQuietHours(date: Date, options: ResolvedDaemonOptions): boolean {
  const hour = getHourInTimeZone(date, options.timeZone);

  if (options.quietHoursStart < options.quietHoursEnd) {
    return hour >= options.quietHoursStart && hour < options.quietHoursEnd;
  }

  return hour >= options.quietHoursStart || hour < options.quietHoursEnd;
}

export function getRandomDaemonDelayMs(
  minDelayMinutes: number,
  maxDelayMinutes: number,
  random: () => number = Math.random,
): number {
  const min = Math.min(minDelayMinutes, maxDelayMinutes);
  const max = Math.max(minDelayMinutes, maxDelayMinutes);
  const minutes = Math.floor(random() * (max - min + 1)) + min;
  return minutes * 60_000;
}

export async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw createAbortError();
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(createAbortError());
    };

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runDaemonLoop(
  runCycle: () => Promise<void>,
  options: DaemonOptions | ResolvedDaemonOptions = {},
  runtime: DaemonLoopRuntime = {},
): Promise<void> {
  // Accept either a user-supplied DaemonOptions or an already-resolved
  // ResolvedDaemonOptions — resolveDaemonOptions is idempotent on a resolved
  // object because every field is already set.
  const resolved = resolveDaemonOptions(options);
  const now = runtime.now ?? (() => new Date());
  const random = runtime.random ?? Math.random;
  const sleep = runtime.sleep ?? sleepWithAbort;
  const signal = runtime.signal;
  const log = runtime.onLog ?? (() => {});
  const onCycleError = runtime.onCycleError ?? (() => {});

  while (!signal?.aborted) {
    if (isWithinQuietHours(now(), resolved)) {
      log(
        `[SyncRunner] Quiet hours in ${resolved.timeZone} (${resolved.quietHoursStart}:00-${resolved.quietHoursEnd}:00); checking again in ${Math.round(resolved.quietPollMs / 1000)}s`,
      );

      try {
        await sleep(resolved.quietPollMs, signal);
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        throw error;
      }

      continue;
    }

    try {
      await runCycle();
    } catch (error) {
      onCycleError(error);
    }

    const delayMs = getRandomDaemonDelayMs(resolved.minDelayMinutes, resolved.maxDelayMinutes, random);
    const delayMinutes = Math.round(delayMs / 60_000);
    log(`[SyncRunner] Waiting ${delayMinutes} minute(s) before the next daemon sync cycle`);

    try {
      await sleep(delayMs, signal);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      throw error;
    }
  }
}

function isValidHour(hour: number): boolean {
  return Number.isInteger(hour) && hour >= 0 && hour <= 23;
}

function getHourInTimeZone(date: Date, timeZone: string): number {
  let formatter = HOUR_FORMATTER_CACHE.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-AU', {
      timeZone,
      hour: '2-digit',
      hour12: false,
    });
    HOUR_FORMATTER_CACHE.set(timeZone, formatter);
  }

  const hourPart = formatter.formatToParts(date).find((part) => part.type === 'hour');
  if (!hourPart) {
    throw new Error(`Unable to determine hour for timezone ${timeZone}`);
  }

  return Number(hourPart.value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function createAbortError(): Error {
  const error = new Error('Daemon sleep aborted');
  error.name = 'AbortError';
  return error;
}
