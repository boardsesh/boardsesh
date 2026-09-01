import { describe, expect, it } from 'vitest';
import { qaSessionKey } from '../qa-keys';

describe('qaSessionKey', () => {
  it('joins the account, the branch and the running bundle', () => {
    expect(qaSessionKey('user-a', 'pr-4792', 'abc-123')).toBe('user-a:pr-4792:abc-123');
  });

  it('stands in `embedded` for a launch with no update id', () => {
    // The bundle baked into the binary can't change without a new build, so one
    // stable token per branch is exactly right there.
    expect(qaSessionKey('user-a', 'pr-4792', null)).toBe('user-a:pr-4792:embedded');
    expect(qaSessionKey('user-a', 'pr-4792', undefined)).toBe('user-a:pr-4792:embedded');
  });

  it('separates the same bundle id across branches', () => {
    expect(qaSessionKey('user-a', 'pr-1', 'same')).not.toBe(qaSessionKey('user-a', 'pr-2', 'same'));
  });

  it('separates two bundles on the same branch', () => {
    // The author pushing again is a new thing to test: the brief must show
    // again and the tester must be able to file a second verdict.
    expect(qaSessionKey('user-a', 'pr-1', 'first')).not.toBe(qaSessionKey('user-a', 'pr-1', 'second'));
  });

  it('separates two testers on the same device and bundle', () => {
    // The markers live in one device-wide settings store, so without the account
    // tester A's sign-off suppressed tester B's brief after a sign-in switch.
    expect(qaSessionKey('user-a', 'pr-1', 'same')).not.toBe(qaSessionKey('user-b', 'pr-1', 'same'));
  });
});
