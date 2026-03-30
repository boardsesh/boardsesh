import { createIndexedDBStore } from './idb-helper';

const STORE_NAME = 'onboarding';

// Increment this when new steps are added to the onboarding tour.
// This will cause the tour to show again for all users.
export const ONBOARDING_VERSION = 1;

export interface OnboardingStatus {
  completedVersion: number;
  completedAt: string;
}

const getDB = createIndexedDBStore('boardsesh-onboarding', STORE_NAME);

/**
 * Get the storage key for onboarding status.
 * Uses the user ID when logged in for per-user tracking,
 * or a generic key for anonymous users.
 */
const getStorageKey = (userId?: string | number | null): string => {
  return userId ? `onboarding-${userId}` : 'onboarding-anonymous';
};

/**
 * Get the onboarding status from IndexedDB
 */
export const getOnboardingStatus = async (userId?: string | number | null): Promise<OnboardingStatus | null> => {
  try {
    const db = await getDB();
    if (!db) return null;
    const key = getStorageKey(userId);
    return await db.get(STORE_NAME, key);
  } catch (error) {
    console.error('Failed to get onboarding status:', error);
    return null;
  }
};

/**
 * Save the onboarding status to IndexedDB
 */
export const saveOnboardingStatus = async (userId?: string | number | null): Promise<void> => {
  try {
    const db = await getDB();
    if (!db) return;
    const key = getStorageKey(userId);
    const status: OnboardingStatus = {
      completedVersion: ONBOARDING_VERSION,
      completedAt: new Date().toISOString(),
    };
    await db.put(STORE_NAME, status, key);
  } catch (error) {
    console.error('Failed to save onboarding status:', error);
  }
};

/**
 * Check if onboarding should be shown.
 * Returns true if onboarding hasn't been completed or a newer version is available.
 */
export const shouldShowOnboarding = async (userId?: string | number | null): Promise<boolean> => {
  try {
    const status = await getOnboardingStatus(userId);
    if (!status) return true;
    return status.completedVersion < ONBOARDING_VERSION;
  } catch {
    return true;
  }
};

// --- Guided Tour (cross-page "Take the tour" flow) ---

const GUIDED_TOUR_KEY = 'guided-tour-pending';

/**
 * Mark the guided tour as pending (set before navigating away from home page).
 */
export const setGuidedTourPending = async (): Promise<void> => {
  try {
    const db = await getDB();
    if (!db) return;
    await db.put(STORE_NAME, { pending: true, setAt: new Date().toISOString() }, GUIDED_TOUR_KEY);
  } catch (error) {
    console.error('Failed to set guided tour pending:', error);
  }
};

/**
 * Check if the guided tour is pending (called on board page mount).
 */
export const isGuidedTourPending = async (): Promise<boolean> => {
  try {
    const db = await getDB();
    if (!db) return false;
    const data = await db.get(STORE_NAME, GUIDED_TOUR_KEY);
    return !!data?.pending;
  } catch {
    return false;
  }
};

/**
 * Clear the guided tour pending flag (called when tour starts on board page).
 */
export const clearGuidedTourPending = async (): Promise<void> => {
  try {
    const db = await getDB();
    if (!db) return;
    await db.delete(STORE_NAME, GUIDED_TOUR_KEY);
  } catch (error) {
    console.error('Failed to clear guided tour pending:', error);
  }
};
