import type { SupportClaimCurrency } from '@boardsesh/db/schema';

/**
 * The supporter tag rule (docs/supporters.md). Pure functions only, so the
 * webhook, the resolvers and the public profile all reach the same verdict.
 */

/** Subscription statuses that still count as "currently a supporter". */
export const LIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'] as const;

/** One calendar month of tag time per this many minor units, by currency. */
export const CREDIT_MINOR_UNITS_PER_MONTH: Readonly<Record<SupportClaimCurrency, number>> = {
  usd: 1000,
  aud: 1500,
};

export function isLiveSubscriptionStatus(status: string | null | undefined): boolean {
  return (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status ?? '');
}

export type SupporterStatusFields = {
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
  creditUntil: Date | null;
};

/** A live monthly subscription, or one-off/granted credit that has not run out. */
export function isCurrentSupporter(row: SupporterStatusFields | null | undefined, now: Date): boolean {
  if (!row) return false;
  if (row.stripeSubscriptionId && isLiveSubscriptionStatus(row.subscriptionStatus)) return true;
  return row.creditUntil !== null && row.creditUntil.getTime() > now.getTime();
}

/** Whole months of tag time a one-off gift buys, rounded down. */
export function creditMonthsFor(amountMinor: number, currency: SupportClaimCurrency): number {
  const perMonth = CREDIT_MINOR_UNITS_PER_MONTH[currency];
  if (!perMonth || !Number.isFinite(amountMinor) || amountMinor <= 0) return 0;
  return Math.floor(amountMinor / perMonth);
}

/**
 * Add calendar months in UTC. A day past the end of the target month lands on
 * that month's last day (31 Jan + 1 month = 28 or 29 Feb).
 */
function addCalendarMonthsUtc(start: Date, months: number): Date {
  const targetMonthIndex = start.getUTCMonth() + months;
  const lastDayOfTarget = new Date(Date.UTC(start.getUTCFullYear(), targetMonthIndex + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      start.getUTCFullYear(),
      targetMonthIndex,
      Math.min(start.getUTCDate(), lastDayOfTarget),
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
      start.getUTCMilliseconds(),
    ),
  );
}

/** New `credit_until`: `months` stacked on whichever is later, `from` or `now`. */
export function extendCredit(from: Date | null, months: number, now: Date): Date {
  const start = from && from.getTime() > now.getTime() ? from : now;
  return addCalendarMonthsUtc(start, Math.max(0, Math.trunc(months)));
}
