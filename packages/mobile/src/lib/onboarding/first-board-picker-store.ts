// How many times the launch gate has opened the board picker for the signed-in
// account (#5654), so it opens at most twice.
//
// AsyncStorage, next to the active board it stands in for, and keyed by the
// account that saw it: a second account on a shared phone starts from zero
// instead of inheriting the first one's count. Sign-out clears it as well
// (`clearPersistedUserStores`), along with the rest of the per-account state.

import { getPreference, removePreference, setPreference } from '../preference-store';

const STORAGE_KEY = 'firstBoardPickerShown';

type StoredShowCount = { userId: string; count: number };

function isStoredShowCount(value: unknown): value is StoredShowCount {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.userId === 'string' && typeof record.count === 'number' && Number.isFinite(record.count);
}

/**
 * The account's show count, 0 when nothing (or another account's count) is
 * stored. `null` when the read fails, which the decision treats as "don't
 * show": without a count the cap cannot hold.
 */
export async function readFirstBoardPickerShowCount(userId: string): Promise<number | null> {
  try {
    const stored = await getPreference<unknown>(STORAGE_KEY);
    if (!isStoredShowCount(stored) || stored.userId !== userId) return 0;
    return Math.max(0, Math.floor(stored.count));
  } catch {
    return null;
  }
}

/** Records one more showing. Written BEFORE the picker opens, so a crash inside it still counts. */
export async function recordFirstBoardPickerShown(userId: string, count: number): Promise<void> {
  const stored: StoredShowCount = { userId, count };
  await setPreference(STORAGE_KEY, stored);
}

/** Sign-out and account switches: the next account starts from zero. */
export async function clearFirstBoardPickerShowCount(): Promise<void> {
  await removePreference(STORAGE_KEY);
}
