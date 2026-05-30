import { v4 as uuidv4 } from 'uuid';
import { ensureProfile, type PartyProfile as SharedPartyProfile } from '@boardsesh/party-profile';
import { createIndexedDBStore, migrateFromLocalStorage } from './idb-helper';

const STORE_NAME = 'profile';
const PROFILE_KEY = 'party-profile';

// Legacy localStorage keys to migrate from
const LEGACY_USER_ID_KEY = 'boardsesh:userId';

// Re-exported under the local name so the dozens of `import type { PartyProfile }
// from '@/app/lib/party-profile-db'` callsites don't need to change.
export type PartyProfile = SharedPartyProfile;

const getDB = createIndexedDBStore('boardsesh-party', STORE_NAME);

/**
 * Get the party profile from IndexedDB
 */
export const getPartyProfile = async (): Promise<PartyProfile | null> => {
  try {
    const db = await getDB();
    if (!db) return null;
    const profile = await db.get(STORE_NAME, PROFILE_KEY);
    if (profile) {
      // Return only the id field (ignore legacy username/avatarUrl if present)
      return { id: profile.id };
    }
    return null;
  } catch (error) {
    console.error('Failed to get party profile:', error);
    return null;
  }
};

/**
 * Save the party profile to IndexedDB
 */
export const savePartyProfile = async (profile: PartyProfile): Promise<void> => {
  try {
    const db = await getDB();
    if (!db) return;
    await db.put(STORE_NAME, profile, PROFILE_KEY);
  } catch (error) {
    console.error('Failed to save party profile:', error);
    throw error;
  }
};

/**
 * Clear the party profile from IndexedDB
 */
export const clearPartyProfile = async (): Promise<void> => {
  try {
    const db = await getDB();
    if (!db) return;
    await db.delete(STORE_NAME, PROFILE_KEY);
  } catch (error) {
    console.error('Failed to clear party profile:', error);
    throw error;
  }
};

/**
 * Migrate data from legacy localStorage keys to IndexedDB
 * Returns true if migration was performed, false otherwise
 */
const migrateFromLegacyStorage = async (): Promise<boolean> => {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const existingProfile = await getPartyProfile();
    if (existingProfile) {
      return false;
    }

    const migrated = await migrateFromLocalStorage<string>(LEGACY_USER_ID_KEY, async (legacyUserId) => {
      await savePartyProfile({ id: legacyUserId });
    });

    if (migrated) {
      // oxlint-disable-next-line no-restricted-globals -- one-time migration cleanup
      localStorage.removeItem('boardsesh:username');
      console.info('Successfully migrated party profile from localStorage to IndexedDB');
    }

    return migrated;
  } catch (error) {
    console.error('Failed to migrate from localStorage:', error);
    return false;
  }
};

/**
 * Ensure a user ID exists, creating a new profile if needed.
 * Migrates from legacy localStorage and delegates the get/create logic to the
 * shared `@boardsesh/party-profile` package so mobile and web share the same
 * contract.
 */
export const ensurePartyProfile = async (): Promise<PartyProfile> => {
  try {
    await migrateFromLegacyStorage();
    return await ensureProfile(
      {
        get: () => getPartyProfile(),
        set: (profile) => savePartyProfile(profile),
      },
      uuidv4,
    );
  } catch (error) {
    console.error('Failed to ensure party profile:', error);
    // In-memory fallback so the rest of the UI doesn't crash on IDB failures.
    return { id: uuidv4() };
  }
};
