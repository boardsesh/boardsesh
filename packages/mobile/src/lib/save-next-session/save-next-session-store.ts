// Persisted state for "save for next session" (#6002), and the external store
// its two surfaces read.
//
// One record in AsyncStorage (via preference-store), `saveNextSession`:
// - `noticeShows`: how often the play drawer's "Saved" notice has shown on this
//   phone. Climbers heart about four climbs each, so the notice explains itself
//   three times and then stays out of the way.
// - `cardDismissedAt`: when the X on the Climbs "saved climbs" card was tapped.
//   A dismiss is for good on this phone.
//
// One per phone, kept across sign-outs, like `firstConnectDevice`: it holds two
// numbers about what this phone has already shown, nothing about the account.
//
// Surfaces read it through `useSaveNextSessionSelector` (useSyncExternalStore
// over a derived primitive), so the Climbs list re-renders only when the card's
// own answer flips, never because the play drawer counted a notice.

import { useSyncExternalStore } from 'react';
import { getPreference, setPreference } from '../preference-store';
import { reportError } from '../error-reporting';

const STORAGE_KEY = 'saveNextSession';

/** The "Saved" notice shows this many times per phone, then never again. */
export const SAVED_CLIMB_NOTICE_MAX_SHOWS = 3;

export type SaveNextSessionState = {
  noticeShows: number;
  cardDismissedAt: number | null;
};

export const EMPTY_SAVE_NEXT_SESSION_STATE: SaveNextSessionState = {
  noticeShows: 0,
  cardDismissedAt: null,
};

/** Null until the phone's state has been read. */
let snapshot: SaveNextSessionState | null = null;
const listeners = new Set<() => void>();
let stateLoad: Promise<SaveNextSessionState> | null = null;
let writeChain: Promise<void> = Promise.resolve();

function publish(next: SaveNextSessionState): void {
  if (
    snapshot !== null &&
    snapshot.noticeShows === next.noticeShows &&
    snapshot.cardDismissedAt === next.cardDismissedAt
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

function isStoredState(value: unknown): value is SaveNextSessionState {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const { noticeShows, cardDismissedAt } = record;
  return (
    typeof noticeShows === 'number' &&
    Number.isInteger(noticeShows) &&
    noticeShows >= 0 &&
    (cardDismissedAt === null || (typeof cardDismissedAt === 'number' && Number.isFinite(cardDismissedAt)))
  );
}

/** Serialised, so an older write can never land after a newer one. */
function persist(next: SaveNextSessionState): void {
  const write = writeChain.then(() => setPreference(STORAGE_KEY, next));
  writeChain = write.catch(() => undefined);
  // The in-memory state already moved, so this launch behaves either way; a
  // failed write only costs the next launch this change.
  write.catch(reportError);
}

async function readState(): Promise<SaveNextSessionState> {
  const stored = await getPreference<unknown>(STORAGE_KEY);
  return isStoredState(stored) ? stored : EMPTY_SAVE_NEXT_SESSION_STATE;
}

/**
 * This phone's state, read from storage once per process and from memory after
 * that. A failed read is not cached, so the next caller retries.
 */
export async function loadSaveNextSession(): Promise<SaveNextSessionState> {
  if (!stateLoad) {
    stateLoad = readState().then(
      (stored) => {
        if (snapshot === null) publish(stored);
        return stored;
      },
      (error: unknown) => {
        stateLoad = null;
        throw error;
      },
    );
  }
  const loaded = await stateLoad;
  // Anything written since the read lives in the snapshot, not the promise.
  return snapshot ?? loaded;
}

/** Starts the read without waiting for it. Safe to call from every surface. */
export function ensureSaveNextSessionLoaded(): void {
  if (snapshot !== null) return;
  void loadSaveNextSession().catch(reportError);
}

/**
 * Asks for one of the notice's three shows. Returns true, and counts it, when
 * there is one left. Synchronous, because it runs in the heart's tap handler.
 *
 * Accepted trade-off: while the stored count has not been read, the answer is
 * "no". A heart that beats the storage read (the play drawer starts the read
 * when it mounts, so in practice only the first heart of a launch can) gets no
 * notice, and that skipped notice does NOT use up one of the three shows:
 * nothing is counted or written, so the phone still gets all three later.
 * After a failed read the answer stays "no" and every ask starts a new read.
 *
 * This is deliberate. Do not turn it into a blocking read: the tap handler
 * cannot wait on storage, and showing before the count is known could overshoot
 * the cap.
 */
export function claimSavedClimbNoticeShow(): boolean {
  if (snapshot === null) {
    ensureSaveNextSessionLoaded();
    return false;
  }
  if (snapshot.noticeShows >= SAVED_CLIMB_NOTICE_MAX_SHOWS) return false;
  const next: SaveNextSessionState = { ...snapshot, noticeShows: snapshot.noticeShows + 1 };
  publish(next);
  persist(next);
  return true;
}

/**
 * The X on the Climbs card: gone for good on this phone.
 *
 * Idempotent: the first call wins and writes once; a second tap, however close
 * behind, changes nothing. The check and the publish below run in one
 * synchronous step against the live snapshot, never against a value read
 * before an await, so two overlapping calls cannot both pass the check.
 */
export async function dismissSavedClimbsCard(atMs: number): Promise<void> {
  // The card only renders once the state is in memory, so a real tap skips this
  // and the dismissal lands inside the tap itself.
  if (snapshot === null) {
    try {
      await loadSaveNextSession();
    } catch (error: unknown) {
      // Unreadable storage: still hide the card for this launch.
      reportError(error);
    }
  }
  const current = snapshot ?? EMPTY_SAVE_NEXT_SESSION_STATE;
  if (current.cardDismissedAt !== null) return;
  const next: SaveNextSessionState = { ...current, cardDismissedAt: atMs };
  publish(next);
  persist(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSaveNextSessionSnapshot(): SaveNextSessionState | null {
  return snapshot;
}

/**
 * One value derived from the state (null while it is still being read). Return
 * a primitive: the caller re-renders only when that value changes.
 */
export function useSaveNextSessionSelector<Selected extends boolean | string | number | null>(
  select: (current: SaveNextSessionState | null) => Selected,
): Selected {
  // A new closure each render is fine: the primitive return keeps
  // useSyncExternalStore from looping on a fresh getSnapshot.
  const selectFromStore = (): Selected => select(snapshot);
  return useSyncExternalStore(subscribe, selectFromStore, selectFromStore);
}

/** Test-only: back to a fresh process. */
export function resetSaveNextSessionStoreForTests(): void {
  if (process.env.NODE_ENV !== 'test') return;
  snapshot = null;
  stateLoad = null;
  writeChain = Promise.resolve();
  for (const listener of listeners) listener();
}
