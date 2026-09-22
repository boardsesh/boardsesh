import { afterEach, describe, expect, it } from 'vite-plus/test';
import { isLiveStripeSubscription, supportReturnUrl } from './stripe-support';

const originalBoardseshUrl = process.env.BOARDSESH_URL;

afterEach(() => {
  if (originalBoardseshUrl === undefined) delete process.env.BOARDSESH_URL;
  else process.env.BOARDSESH_URL = originalBoardseshUrl;
});

describe('supportReturnUrl', () => {
  it('preserves supported locale prefixes and strips the base trailing slash', () => {
    process.env.BOARDSESH_URL = 'https://www.boardsesh.com/';
    expect(supportReturnUrl('fr')).toBe('https://www.boardsesh.com/fr/support');
    expect(supportReturnUrl('en-US')).toBe('https://www.boardsesh.com/support');
  });

  it('ignores unrecognised locale input', () => {
    process.env.BOARDSESH_URL = 'https://www.boardsesh.com';
    expect(supportReturnUrl('../billing')).toBe('https://www.boardsesh.com/support');
  });
});

describe('isLiveStripeSubscription', () => {
  it('treats chargeable and recoverable subscriptions as live', () => {
    expect(isLiveStripeSubscription('active')).toBe(true);
    expect(isLiveStripeSubscription('trialing')).toBe(true);
    expect(isLiveStripeSubscription('past_due')).toBe(true);
  });

  it('excludes terminal or absent subscriptions', () => {
    expect(isLiveStripeSubscription('canceled')).toBe(false);
    expect(isLiveStripeSubscription('incomplete')).toBe(false);
    expect(isLiveStripeSubscription('incomplete_expired')).toBe(false);
    expect(isLiveStripeSubscription('paused')).toBe(false);
    expect(isLiveStripeSubscription('unpaid')).toBe(false);
    expect(isLiveStripeSubscription('future_status')).toBe(false);
    expect(isLiveStripeSubscription(null)).toBe(false);
  });
});
