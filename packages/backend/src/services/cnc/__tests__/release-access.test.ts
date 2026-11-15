import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { isCncCreationAllowed, requireCncCheckoutAccess, requireCncCreationAccess } from '../release-access';

beforeEach(() => {
  vi.stubEnv('CNC_TRANSPORT', 'pgboss');
  vi.stubEnv('CNC_RELEASE_MODE', 'beta');
  vi.stubEnv('CNC_BETA_USER_IDS', 'marco-account,test-account');
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_synthetic123');
});
afterEach(() => vi.unstubAllEnvs());

describe('server CNC release access', () => {
  it('allows exactly the approved account IDs during a Stripe sandbox beta', () => {
    expect(isCncCreationAllowed('marco-account')).toBe(true);
    expect(isCncCreationAllowed('test-account')).toBe(true);
    for (const userId of ['other-account', 'MARCO-ACCOUNT', 'marco', '', ' marco-account', 'marco-account ']) {
      expect(isCncCreationAllowed(userId)).toBe(false);
    }
  });

  it('uses exact IDs while permitting whitespace around comma-separated entries', () => {
    vi.stubEnv('CNC_BETA_USER_IDS', ' marco-account , test-account ');
    expect(isCncCreationAllowed('marco-account')).toBe(true);
    expect(isCncCreationAllowed('test-account')).toBe(true);
    expect(isCncCreationAllowed('account')).toBe(false);
  });

  it.each(['', 'sk_live_synthetic123', 'rk_live_synthetic123', 'sk_test_', 'sk_test_secret\n', ' sk_test_secret'])(
    'refuses beta work with an absent, live or malformed Stripe key: %j',
    (key) => {
      vi.stubEnv('STRIPE_SECRET_KEY', key);
      expect(isCncCreationAllowed('marco-account')).toBe(false);
    },
  );

  it('accepts a restricted Stripe test key too', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'rk_test_synthetic123');
    expect(isCncCreationAllowed('marco-account')).toBe(true);
  });

  it.each([
    '',
    'marco-account,',
    ',marco-account',
    'marco-account,,test-account',
    'marco-account,invalid id',
    'marco-account,invalid\x01id',
  ])('fails closed for an empty or malformed beta allowlist: %j', (ids) => {
    vi.stubEnv('CNC_BETA_USER_IDS', ids);
    expect(isCncCreationAllowed('marco-account')).toBe(false);
  });

  it.each([undefined, '', 'disabled', 'unknown', 'BETA'])('fails closed for pg-boss release mode %j', (mode) => {
    vi.stubEnv('CNC_RELEASE_MODE', mode);
    expect(isCncCreationAllowed('marco-account')).toBe(false);
  });

  it('preserves legacy HTTP behavior only when no release mode was configured', () => {
    vi.stubEnv('CNC_TRANSPORT', undefined);
    vi.stubEnv('CNC_RELEASE_MODE', undefined);
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_synthetic123');
    expect(isCncCreationAllowed('existing-buyer')).toBe(true);
    vi.stubEnv('CNC_RELEASE_MODE', 'beta');
    expect(isCncCreationAllowed('marco-account')).toBe(false);
    vi.stubEnv('CNC_RELEASE_MODE', 'disabled');
    expect(isCncCreationAllowed('existing-buyer')).toBe(false);
  });

  it('requires an explicit public mode for an unrestricted new rollout', () => {
    vi.stubEnv('CNC_RELEASE_MODE', 'public');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_synthetic123');
    expect(isCncCreationAllowed('future-buyer')).toBe(true);
  });

  it('returns existing localized error codes without exposing beta identities or keys', () => {
    expect(() => requireCncCreationAccess('other-account')).toThrowError(
      expect.objectContaining({ extensions: { code: 'CNC_WORKER_UNAVAILABLE' } }),
    );
    expect(() => requireCncCheckoutAccess('other-account')).toThrowError(
      expect.objectContaining({ extensions: { code: 'CNC_CHECKOUT_UNAVAILABLE' } }),
    );
    expect(() => requireCncCreationAccess('marco-account')).not.toThrow();
    expect(() => requireCncCheckoutAccess('test-account')).not.toThrow();
  });
});
