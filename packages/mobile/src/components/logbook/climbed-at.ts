import type { TickReportingTimeInput } from '@boardsesh/shared-schema';
import { getDeviceTimezone } from '../../lib/device-timezone';
// Pure date helpers for editing a tick's `climbedAt` timestamp, shared by the
// create flow (QuickTickBar) and the edit flow (LogbookEditSheet). No React or
// React Native imports — kept pure so the merge/clamp rules are unit-testable.
import { parseTickTime } from '@boardsesh/profile-stats';

/** How often the tick sheets re-sample "now" so a long-open sheet's picker
 *  bound (and the create sheet's unedited default) can't drift into the past. */
export const MAXIMUM_CLIMBED_AT_REFRESH_MS = 60_000;

/** Parse a stored `climbedAt` ISO string into a local `Date`, falling back to
 *  now when the value is missing or unparseable. */
export function toEditableDate(climbedAt: string): Date {
  const parsed = parseTickTime(climbedAt).toDate();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/** A tick can't be logged in the future — pull any future instant back to now. */
export function clampToNow(date: Date): Date {
  const now = new Date();
  return date.getTime() > now.getTime() ? now : date;
}

/** Apply the calendar day (year/month/day) of `selected` onto `current`,
 *  keeping the time-of-day. */
export function applyDatePart(current: Date, selectedDate: Date, options: { clampToPresent: boolean }): Date {
  const next = new Date(current);
  next.setFullYear(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
  return options.clampToPresent ? clampToNow(next) : next;
}

/** Apply the time-of-day (hours/minutes) of `selected` onto `current`, keeping
 *  the calendar day. */
export function applyTimePart(current: Date, selectedTime: Date, options: { clampToPresent: boolean }): Date {
  const next = new Date(current);
  next.setHours(selectedTime.getHours(), selectedTime.getMinutes(), 0, 0);
  return options.clampToPresent ? clampToNow(next) : next;
}

export function formatDateForDisplay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatTimeForDisplay(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** The original ISO timestamp still drives the logbook. This records what was actually selected. */
export function selectedTickReportingTime(date: Date, selectedClock: boolean): TickReportingTimeInput | undefined {
  if (selectedClock) return { precision: 'instant' };
  const timeZone = getDeviceTimezone();
  if (!timeZone) return undefined;
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return { precision: 'day', date: `${year}-${month}-${day}`, timeZone };
}
