import { describe, expect, it } from 'vite-plus/test';
import { creditMonthsFor, extendCredit, isCurrentSupporter } from './supporter-status';

const NOW = new Date('2026-10-31T09:30:00.000Z');

describe('creditMonthsFor', () => {
  it.each([
    [999, 'usd', 0],
    [1000, 'usd', 1],
    [2999, 'usd', 2],
    [10_000, 'usd', 10],
    [1499, 'aud', 0],
    [1500, 'aud', 1],
    [4500, 'aud', 3],
    [0, 'usd', 0],
    [-1500, 'aud', 0],
    [Number.NaN, 'usd', 0],
  ] as const)('%i %s minor units buy %i months', (amount, currency, months) => {
    expect(creditMonthsFor(amount, currency)).toBe(months);
  });
});

describe('extendCredit', () => {
  it('starts from now when there is no credit', () => {
    expect(extendCredit(null, 2, NOW).toISOString()).toBe('2026-12-31T09:30:00.000Z');
  });

  it('starts from now when the credit already ran out', () => {
    expect(extendCredit(new Date('2026-01-01T00:00:00Z'), 1, NOW).toISOString()).toBe('2026-11-30T09:30:00.000Z');
  });

  it('stacks on credit still running', () => {
    expect(extendCredit(new Date('2027-01-15T00:00:00Z'), 3, NOW).toISOString()).toBe('2027-04-15T00:00:00.000Z');
  });

  it('lands on the last day of a shorter month', () => {
    expect(extendCredit(new Date('2027-01-31T08:00:00Z'), 1, NOW).toISOString()).toBe('2027-02-28T08:00:00.000Z');
    expect(extendCredit(new Date('2027-12-31T08:00:00Z'), 2, NOW).toISOString()).toBe('2028-02-29T08:00:00.000Z');
  });

  it('crosses year ends', () => {
    expect(extendCredit(null, 14, NOW).toISOString()).toBe('2027-12-31T09:30:00.000Z');
  });
});

describe('isCurrentSupporter', () => {
  const none = { stripeSubscriptionId: null, subscriptionStatus: null, creditUntil: null };

  it('is false with no row', () => {
    expect(isCurrentSupporter(null, NOW)).toBe(false);
    expect(isCurrentSupporter(none, NOW)).toBe(false);
  });

  it.each(['active', 'trialing', 'past_due'])('counts a %s subscription', (status) => {
    expect(isCurrentSupporter({ ...none, stripeSubscriptionId: 'sub_1', subscriptionStatus: status }, NOW)).toBe(true);
  });

  it.each(['canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused'])(
    'does not count a %s subscription',
    (status) => {
      expect(isCurrentSupporter({ ...none, stripeSubscriptionId: 'sub_1', subscriptionStatus: status }, NOW)).toBe(
        false,
      );
    },
  );

  it('needs a subscription id, not only a status', () => {
    expect(isCurrentSupporter({ ...none, subscriptionStatus: 'active' }, NOW)).toBe(false);
  });

  it('counts credit until the instant it runs out', () => {
    expect(isCurrentSupporter({ ...none, creditUntil: new Date(NOW.getTime() + 1) }, NOW)).toBe(true);
    expect(isCurrentSupporter({ ...none, creditUntil: NOW }, NOW)).toBe(false);
  });
});
