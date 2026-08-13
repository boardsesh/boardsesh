import { describe, it, expect, beforeEach, vi } from 'vitest';

// `sweepOrphanedUserStorage` is the ONLY thing that ever reclaims a persisted
// query cache orphaned by cookie expiry — otherwise up to 512 KB of profile data
// per abandoned login sits in IndexedDB forever. It matches raw AsyncStorage
// keys by the `:user:<id>:auth-session:<sid>` suffix, so this suite captures the
// predicate it builds and runs the query-cache keys through it.
const preferenceState = vi.hoisted(() => ({
  index: {} as Record<string, number>,
  removePredicate: null as ((key: string) => boolean) | null,
}));

vi.mock('../../preference-store', () => ({
  getPreference: async () => preferenceState.index,
  setPreference: async () => {},
  removePreference: async () => {},
  removePreferencesMatching: async (matchesKey: (key: string) => boolean) => {
    preferenceState.removePredicate = matchesKey;
  },
}));

import { sweepOrphanedUserStorage, userScopedStorageKey } from '../../user-storage-owner.web';
import { QUERY_CACHE_STORAGE_BASES } from '../storage.web';

const ORPHAN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const CURRENT_OWNER = { userId: 'user-1', authSessionId: 'login-2' };
const STALE_OWNER = { userId: 'user-1', authSessionId: 'login-1' };
const OTHER_USER = { userId: 'user-2', authSessionId: 'login-9' };

beforeEach(() => {
  preferenceState.index = {};
  preferenceState.removePredicate = null;
});

// T-22
describe('web query-cache keys and the orphan sweep', () => {
  it('builds login-scoped keys and no key at all without an owner', () => {
    for (const base of QUERY_CACHE_STORAGE_BASES) {
      expect(userScopedStorageKey(base, CURRENT_OWNER)).toBe(`${base}:user:user-1:auth-session:login-2`);
      // A null owner means "no readable blob" rather than an unscoped one — a
      // cross-login read is not merely checked, it is unexpressible.
      expect(userScopedStorageKey(base, null)).toBeNull();
    }
  });

  it('reclaims both the blob and the meta key of a stale login', async () => {
    preferenceState.index = {
      'user-1:login-1': NOW - ORPHAN_RETENTION_MS - 1,
    };

    await sweepOrphanedUserStorage(CURRENT_OWNER, NOW);

    const matches = preferenceState.removePredicate;
    expect(matches).not.toBeNull();
    for (const base of QUERY_CACHE_STORAGE_BASES) {
      const staleKey = userScopedStorageKey(base, STALE_OWNER);
      const liveKey = userScopedStorageKey(base, CURRENT_OWNER);
      const otherUserKey = userScopedStorageKey(base, OTHER_USER);
      expect(staleKey).not.toBeNull();
      expect(matches?.(staleKey as string)).toBe(true);
      // The login that is active right now, and any other account, are left alone.
      expect(matches?.(liveKey as string)).toBe(false);
      expect(matches?.(otherUserKey as string)).toBe(false);
    }
  });

  it('leaves a recently active login alone', async () => {
    preferenceState.index = { 'user-1:login-1': NOW - 1000 };
    await sweepOrphanedUserStorage(CURRENT_OWNER, NOW);
    expect(preferenceState.removePredicate).toBeNull();
  });
});
