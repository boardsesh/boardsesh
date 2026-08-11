import type { CronTimeFields } from './expression';

const WEEKDAY_INDEX_BY_SHORT_NAME: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) {
    return cached;
  }

  // Throws RangeError for an unknown zone, which is what we want at
  // registration time rather than silently falling back to the container's
  // local zone (the exact drift the UTC job option exists to prevent).
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/**
 * Resolves an instant into the wall-clock fields a cron expression matches
 * against, in the given IANA timezone.
 *
 * Vercel crons run in UTC and the containers we deploy to may not; every job
 * declares its zone explicitly so the schedule can't drift with the host.
 */
export function getZonedTimeFields(instant: Date, timeZone: string): CronTimeFields {
  const parts = getFormatter(timeZone).formatToParts(instant);
  const partValues: Record<string, string> = {};
  for (const part of parts) {
    partValues[part.type] = part.value;
  }

  const dayOfWeek = WEEKDAY_INDEX_BY_SHORT_NAME[partValues.weekday];
  if (dayOfWeek === undefined) {
    throw new Error(`could not resolve weekday for timezone ${timeZone}`);
  }

  return {
    minute: Number(partValues.minute),
    hour: Number(partValues.hour),
    dayOfMonth: Number(partValues.day),
    month: Number(partValues.month),
    dayOfWeek,
  };
}

/** Stable key for "which minute is it here", used to avoid double-firing a tick. */
export function getZonedMinuteKey(instant: Date, timeZone: string): string {
  const parts = getFormatter(timeZone).formatToParts(instant);
  const partValues: Record<string, string> = {};
  for (const part of parts) {
    partValues[part.type] = part.value;
  }
  return `${partValues.year}-${partValues.month}-${partValues.day}-${partValues.hour}-${partValues.minute}`;
}

/** Throws if the zone is not one Intl recognises. */
export function assertValidTimeZone(timeZone: string): void {
  getFormatter(timeZone);
}
