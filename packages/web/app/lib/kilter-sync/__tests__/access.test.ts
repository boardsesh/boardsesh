import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isKilterSyncAllowed, resetKilterSyncAllowlistCacheForTests } from '../access';

const ENV_KEY = 'KILTER_SYNC_ALLOWED_USER_IDS';

describe('isKilterSyncAllowed', () => {
  const originalEnv = process.env[ENV_KEY];

  beforeEach(() => {
    delete process.env[ENV_KEY];
    resetKilterSyncAllowlistCacheForTests();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
    resetKilterSyncAllowlistCacheForTests();
  });

  it('returns false when the env var is unset', async () => {
    expect(await isKilterSyncAllowed('any-user-id')).toBe(false);
  });

  it('returns false when the env var is set to an empty string', async () => {
    process.env[ENV_KEY] = '';
    expect(await isKilterSyncAllowed('any-user-id')).toBe(false);
  });

  it('returns true for a user explicitly in the allowlist', async () => {
    process.env[ENV_KEY] = 'user-a,user-b,user-c';
    expect(await isKilterSyncAllowed('user-b')).toBe(true);
  });

  it('returns false for a user not in the allowlist', async () => {
    process.env[ENV_KEY] = 'user-a,user-b';
    expect(await isKilterSyncAllowed('user-c')).toBe(false);
  });

  it('tolerates whitespace and empty entries in the comma-separated value', async () => {
    process.env[ENV_KEY] = '  user-a ,, user-b  ,';
    expect(await isKilterSyncAllowed('user-a')).toBe(true);
    expect(await isKilterSyncAllowed('user-b')).toBe(true);
    expect(await isKilterSyncAllowed('')).toBe(false);
  });

  it('caches the parsed allowlist across calls (env mutated between calls is ignored)', async () => {
    // Module-load semantic: change the env after the first call and the
    // next call should still see the original value. Redeploy is what
    // forces a re-read; tests use the reset helper for the same effect.
    process.env[ENV_KEY] = 'user-a';
    expect(await isKilterSyncAllowed('user-a')).toBe(true);
    expect(await isKilterSyncAllowed('user-b')).toBe(false);

    process.env[ENV_KEY] = 'user-a,user-b';
    expect(await isKilterSyncAllowed('user-b')).toBe(false);

    resetKilterSyncAllowlistCacheForTests();
    expect(await isKilterSyncAllowed('user-b')).toBe(true);
  });
});
