export type DaemonOptions = {
  timeZone?: string;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  quietPollMs?: number;
  minDelayMinutes?: number;
  maxDelayMinutes?: number;
  standbyPollMs?: number;
};

export type ResolvedDaemonOptions = {
  timeZone: string;
  quietHoursStart: number;
  quietHoursEnd: number;
  quietPollMs: number;
  minDelayMinutes: number;
  maxDelayMinutes: number;
  standbyPollMs: number;
};

export type DaemonLoopRuntime = {
  now?: () => Date;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
  onCycleError?: (error: unknown) => void;
  /**
   * Optional gate asked before every cycle. `false` puts the loop into standby:
   * it skips the cycle, sleeps `standbyPollMs` instead of the usual jittered
   * delay, and tries again — it never throws and never exits, because a
   * crash-looping loser during a rolling deploy is worse than the duplicate
   * work this gate exists to avoid.
   *
   * A rejection is treated as "don't run" (fail closed). The gate is backed by
   * Postgres, and a daemon that can't reach Postgres can't sync anyway, so
   * failing closed costs nothing and avoids resurrecting the duplicate-work bug
   * during a database blip.
   */
  acquireSlot?: () => Promise<boolean>;
};

export const DEFAULT_DAEMON_OPTIONS: ResolvedDaemonOptions = {
  timeZone: 'Australia/Sydney',
  quietHoursStart: 22,
  quietHoursEnd: 7,
  quietPollMs: 60_000,
  minDelayMinutes: 1,
  maxDelayMinutes: 15,
  // Standby is deliberately much shorter than the 1-15 minute working delay:
  // when the active instance goes away, the standby one should take over in
  // seconds, not in a random fraction of a quarter-hour.
  standbyPollMs: 30_000,
};

const HOUR_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

/**
 * Emit a "still on standby" line every N standby polls (at the 30s default,
 * every 10 minutes) so a passive instance stays visibly alive in the logs
 * without producing a line every poll.
 */
const STANDBY_KEEPALIVE_EVERY = 20;

export function resolveDaemonOptions(options: DaemonOptions = {}): ResolvedDaemonOptions {
  const resolved: ResolvedDaemonOptions = {
    timeZone: options.timeZone ?? DEFAULT_DAEMON_OPTIONS.timeZone,
    quietHoursStart: options.quietHoursStart ?? DEFAULT_DAEMON_OPTIONS.quietHoursStart,
    quietHoursEnd: options.quietHoursEnd ?? DEFAULT_DAEMON_OPTIONS.quietHoursEnd,
    quietPollMs: options.quietPollMs ?? DEFAULT_DAEMON_OPTIONS.quietPollMs,
    minDelayMinutes: options.minDelayMinutes ?? DEFAULT_DAEMON_OPTIONS.minDelayMinutes,
    maxDelayMinutes: options.maxDelayMinutes ?? DEFAULT_DAEMON_OPTIONS.maxDelayMinutes,
    standbyPollMs: options.standbyPollMs ?? DEFAULT_DAEMON_OPTIONS.standbyPollMs,
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

  // Same reasoning for standby: a non-positive value would spin on the lease
  // gate instead of waiting for the active instance to go away.
  if (resolved.standbyPollMs <= 0) {
    throw new Error(`Daemon standbyPollMs must be > 0 (got ${resolved.standbyPollMs}).`);
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
  const acquireSlot = runtime.acquireSlot;
  // Standby is usually long-lived (the passive instance of a two-container
  // deploy can sit here for hours), so log the transitions and then only a
  // periodic keepalive rather than a line every 30 seconds.
  let inStandby = false;
  let standbyCycles = 0;

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

    if (acquireSlot) {
      let holdsSlot: boolean;
      try {
        holdsSlot = await acquireSlot();
      } catch (error) {
        // Fail closed — see the acquireSlot docs. Report it so the failure is
        // visible, then stand by rather than running unguarded.
        onCycleError(error);
        holdsSlot = false;
      }

      if (!holdsSlot) {
        if (!inStandby) {
          inStandby = true;
          standbyCycles = 0;
          log(
            `[SyncRunner] Another instance holds the daemon lease; standing by (re-checking every ${Math.round(resolved.standbyPollMs / 1000)}s)`,
          );
        } else if (++standbyCycles % STANDBY_KEEPALIVE_EVERY === 0) {
          const standbyMinutes = Math.round((standbyCycles * resolved.standbyPollMs) / 60_000);
          log(`[SyncRunner] Still on standby after ~${standbyMinutes} minute(s); another instance holds the lease`);
        }

        try {
          await sleep(resolved.standbyPollMs, signal);
        } catch (error) {
          if (isAbortError(error)) {
            return;
          }
          throw error;
        }

        continue;
      }

      if (inStandby) {
        inStandby = false;
        log('[SyncRunner] Took over the daemon lease; resuming sync cycles');
      }
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
