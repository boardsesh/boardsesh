/** Longest grant the admin form offers, in months. */
export const MAX_SUPPORTER_GRANT_MONTHS = 120;

/**
 * Parse the months field. Whole months from 1 to MAX_SUPPORTER_GRANT_MONTHS;
 * anything else is null so the form refuses it before calling the backend.
 */
export function parseGrantMonths(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const months = Number(raw.trim());
  return months >= 1 && months <= MAX_SUPPORTER_GRANT_MONTHS ? months : null;
}

/**
 * `now` plus whole calendar months in UTC, the backend's credit rule
 * (packages/backend/src/services/supporter-status.ts): a day past the end of
 * the target month lands on its last day, so 31 Jan + 1 month is 28 or 29 Feb.
 */
export function supporterGrantUntil(now: Date, months: number): Date {
  const targetMonthIndex = now.getUTCMonth() + months;
  const lastDayOfTarget = new Date(Date.UTC(now.getUTCFullYear(), targetMonthIndex + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      targetMonthIndex,
      Math.min(now.getUTCDate(), lastDayOfTarget),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
}
