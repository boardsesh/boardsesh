import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';

// PREFERENCE_SECURE_KEYS drives which SecureStore keys the #4103 keychain
// migration copies into the v2 namespace. Its entries are imported from the
// modules that own them, which makes a platform fork a real hazard: Metro
// resolves `./session-store` to session-store.web.ts on the browser target, and
// that fork used to declare the session keys privately. An import through it
// resolves to `undefined` there, punching a silent hole in the list.
//
// Importing the list and inspecting its values cannot catch that. Vitest and tsc
// both resolve `./session-store` to the NATIVE file, whose exports are perfectly
// defined, so re-pointing an import at a forked module passes every value
// assertion while the browser bundle quietly loses two keys. The guard has to be
// structural, which is what the first test is: it reads the source and fails on
// an import of any module that has a `.web` sibling.
//
// The value assertions after it are a second, weaker net. They catch a renamed
// or deleted constant, not a fork.

const LIB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'after-first-unlock',
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

describe('preference-secure-keys imports', () => {
  it('pulls no key through a module that has a platform fork', () => {
    const source = readFileSync(resolve(LIB_DIR, 'preference-secure-keys.ts'), 'utf8');
    const relativeSpecifiers = [...source.matchAll(/from '(\.[^']+)'/g)].map((match) => match[1]);

    expect(relativeSpecifiers.length).toBeGreaterThan(0);
    const forkedSpecifiers = relativeSpecifiers.filter((specifier) =>
      ['.web.ts', '.web.tsx'].some((suffix) => existsSync(resolve(LIB_DIR, `${specifier}${suffix}`))),
    );

    // A hit here means Metro resolves that import to a fork on the browser
    // target, and every key the fork does not re-export becomes `undefined` in
    // the list below. The fix is to move those constants into a fork-free module
    // of their own, the way session-store-keys.ts already does for the two
    // session ids.
    expect(forkedSpecifiers).toEqual([]);
  });
});

describe('PREFERENCE_SECURE_KEYS', () => {
  it('is exactly the sixteen preference keys the migration covers', async () => {
    const { PREFERENCE_SECURE_KEYS } = await import('../preference-secure-keys');

    // Pinned as literals so a renamed or deleted constant lands as a diff on
    // this line instead of as a silent hole in the migration list.
    expect(PREFERENCE_SECURE_KEYS).toEqual([
      'boardsesh_active_session_id',
      'boardsesh_created_session_id',
      'boardsesh_last_used_grade',
      'boardsesh_recent_filters',
      'boardsesh_last_search_by_board',
      'locale_override',
      'theme_override',
      'ui_variant',
      'changelog_last_seen',
      'onboarding_seen',
      'onboarding_board_tip_pending',
      'onboarding_tip_workout_seen',
      'onboarding_tip_crew_seen',
      'onboarding_tip_record_seen',
      'onboarding_tip_accessory_seen',
      'onboarding_tip_quickactions_seen',
    ]);
  });

  it('has no undefined or empty entries', async () => {
    const { PREFERENCE_SECURE_KEYS } = await import('../preference-secure-keys');

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
