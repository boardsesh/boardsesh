import { matchesCronExpression, parseCronExpression } from './expression';
import { assertValidTimeZone, getZonedMinuteKey, getZonedTimeFields } from './zoned-time';

/** Handle returned by {@link CronScheduler.schedule}. */
export type CronTask = {
  readonly expression: string;
  readonly timezone: string;
  stop(): void;
};

export type CronScheduleOptions = {
  /** IANA timezone the expression is evaluated in. Required — never implicit. */
  readonly timezone: string;
};

/**
 * The tiny slice of a cron library the runner depends on. Injected so tests
 * can drive ticks directly instead of waiting on wall-clock time.
 */
export type CronScheduler = {
  schedule(expression: string, handler: () => void, options: CronScheduleOptions): CronTask;
  stop(): void;
};

const MINUTE_MS = 60_000;
// Wake a little after the minute boundary so a timer that fires marginally
// early can't evaluate the previous minute twice.
const TICK_OFFSET_MS = 500;

type RegisteredTask = {
  readonly expression: ReturnType<typeof parseCronExpression>;
  readonly timezone: string;
  readonly handler: () => void;
  lastFiredMinuteKey: string | null;
};

export type MinuteTickerOptions = {
  /** Injected for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Called (and swallowed) when a handler throws synchronously. */
  readonly onHandlerError?: (error: unknown, expression: string) => void;
};

/**
 * A once-per-minute cron ticker.
 *
 * One shared timer wakes just after each minute boundary and fires every task
 * whose expression matches the current wall clock in that task's timezone.
 * Missed minutes (process paused, host suspended) are skipped rather than
 * replayed — same behaviour as a system crontab.
 */
export function createMinuteTicker(options: MinuteTickerOptions = {}): CronScheduler {
  const now = options.now ?? (() => Date.now());
  const tasks = new Set<RegisteredTask>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const runTick = () => {
    const instant = new Date(now());
    for (const task of tasks) {
      const minuteKey = getZonedMinuteKey(instant, task.timezone);
      if (task.lastFiredMinuteKey === minuteKey) {
        continue;
      }
      if (!matchesCronExpression(task.expression, getZonedTimeFields(instant, task.timezone))) {
        continue;
      }

      task.lastFiredMinuteKey = minuteKey;
      try {
        task.handler();
      } catch (error) {
        options.onHandlerError?.(error, task.expression.source);
      }
    }
  };

  const scheduleNextTick = () => {
    if (stopped || tasks.size === 0) {
      return;
    }
    const millisecondsIntoMinute = now() % MINUTE_MS;
    const delay = MINUTE_MS - millisecondsIntoMinute + TICK_OFFSET_MS;
    timer = setTimeout(() => {
      timer = null;
      runTick();
      scheduleNextTick();
    }, delay);
  };

  const stopTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    schedule(expression, handler, scheduleOptions) {
      if (stopped) {
        throw new Error('cannot schedule on a stopped ticker');
      }
      assertValidTimeZone(scheduleOptions.timezone);

      const task: RegisteredTask = {
        expression: parseCronExpression(expression),
        timezone: scheduleOptions.timezone,
        handler,
        lastFiredMinuteKey: null,
      };
      tasks.add(task);
      if (timer === null) {
        scheduleNextTick();
      }

      return {
        expression,
        timezone: scheduleOptions.timezone,
        stop() {
          tasks.delete(task);
          if (tasks.size === 0) {
            stopTimer();
          }
        },
      };
    },
    stop() {
      stopped = true;
      tasks.clear();
      stopTimer();
    },
  };
}
