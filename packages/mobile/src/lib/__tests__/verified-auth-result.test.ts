import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commitVerifiedAuthResult,
  getVerifiedAuthResult,
  parseVerifiedAuthResult,
  subscribeVerifiedAuthResult,
} from '../verified-auth-result';
import { invalidateConsentAccount } from '../consent-state';

const userId = '602c83bf-e090-4c90-9f7e-08ca0b6b5dad';
const creation = { userId, accountCreated: true, provider: 'apple', createdAt: '2026-10-10T00:00:00.000Z' };
beforeEach(() => commitVerifiedAuthResult(null));

describe('verified auth metadata', () => {
  it('allows legacy token responses and strips malformed or foreign creation receipts', () => {
    expect(parseVerifiedAuthResult({ jwt: 'legacy' })).toBeNull();
    expect(parseVerifiedAuthResult({ userId, accountCreation: creation })).toEqual({
      userId,
      accountCreation: creation,
    });
    expect(parseVerifiedAuthResult({ userId: 'another-owner', accountCreation: creation })).toEqual({
      userId: 'another-owner',
    });
  });

  it('clears committed metadata synchronously when auth authority changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVerifiedAuthResult(listener);
    commitVerifiedAuthResult({ userId });
    expect(getVerifiedAuthResult()).toEqual({ userId });
    invalidateConsentAccount();
    expect(getVerifiedAuthResult()).toBeNull();
    expect(listener).toHaveBeenLastCalledWith(null);
    unsubscribe();
  });
});
