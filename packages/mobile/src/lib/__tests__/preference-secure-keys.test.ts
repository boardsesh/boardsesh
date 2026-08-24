import { describe, it, expect, vi } from 'vitest';

// PREFERENCE_SECURE_KEYS drives which SecureStore keys the #4103 keychain
// migration copies into the v2 namespace. Its entries are imported from the
// modules that own them, which makes a platform fork a real hazard: Metro
// resolves `./session-store` to session-store.web.ts on the browser target, and
// that fork used to declare the session keys privately. An import through it
// resolves to `undefined` there, punching a silent hole in this list that tsc
// (which resolves the native file) cannot see.
//
// These assertions are the guard. Repointing any entry at a module with a
// `.web.ts` sibling that does not re-export the key fails the undefined check.

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'after-first-unlock',
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

describe('PREFERENCE_SECURE_KEYS', () => {
  it('has no undefined or empty entries', async () => {
    const { PREFERENCE_SECURE_KEYS } = await import('../preference-secure-keys');

    expect(PREFERENCE_SECURE_KEYS.length).toBeGreaterThan(0);
    for (const key of PREFERENCE_SECURE_KEYS) {
      expect(typeof key).toBe('string');
      expect(key).not.toBe('');
    }
  });

  it('lists every key exactly once', async () => {
    const { PREFERENCE_SECURE_KEYS } = await import('../preference-secure-keys');

    expect(new Set(PREFERENCE_SECURE_KEYS).size).toBe(PREFERENCE_SECURE_KEYS.length);
  });

  it('covers both party-session keys from the fork-free key module', async () => {
    const { PREFERENCE_SECURE_KEYS } = await import('../preference-secure-keys');
    const { CREATED_SESSION_ID_KEY, SESSION_ID_KEY } = await import('../session-store-keys');

    expect(PREFERENCE_SECURE_KEYS).toContain(SESSION_ID_KEY);
    expect(PREFERENCE_SECURE_KEYS).toContain(CREATED_SESSION_ID_KEY);
  });

  it('excludes the two keys the migration deliberately skips', async () => {
    const { PREFERENCE_SECURE_KEYS } = await import('../preference-secure-keys');

    // boardsesh_party_profile is read synchronously at module eval, before any
    // async migration could run; boardsesh_dev_metro_hosts is dev-only and
    // already read-and-deleted on its way to AsyncStorage.
    expect(PREFERENCE_SECURE_KEYS).not.toContain('boardsesh_party_profile');
    expect(PREFERENCE_SECURE_KEYS).not.toContain('boardsesh_dev_metro_hosts');
  });
});
