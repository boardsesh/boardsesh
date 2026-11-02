// The Climbs header's Hide (owner decision, 2026-11-02): the climber hides the
// climb on the wall, and it stays hidden until a DIFFERENT climb goes up on that
// board, across relaunches. One entry per board: the hidden climb and the lit
// time of the lighting it covers.
//
// The scope is board + climb, not board + lighting. The same climb is reported
// again for reasons that put nothing new on the wall: a reconnect after a Kilter
// box drops the link (the client clears its report dedup on every connect), the
// climber's iPad taking the board and re-lighting it, a mirror flip, an angle
// change, a Live Activity re-light. Each carries a fresh server lit time, so a
// lit-time key would bring the capsule back for every one of them.
//
// The lit time orders reports: only a different climb lit at or after the hidden
// lighting ends the Hide (`observeWallClimb`), so a late or replayed report of an
// older climb never does. Once a different climb has gone up, the same climb
// coming back later is a new climb on the wall and shows again.

import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { getPreference, setPreference } from './preference-store';

const STORAGE_KEY = 'wallCapsuleDismissals';

/** The two presence fields a Hide reads: which climb, and when it was lit. */
export type WallClimbStamp = Pick<BoardPresenceClimb, 'climbUuid' | 'sentAt'>;

/** The climb hidden on one board, and the lit time of the lighting the climber hid. */
export type HiddenWallClimb = { climbUuid: string; sentAt: string };

type StoredDismissals = { version: 2; byBoard: Record<string, HiddenWallClimb> };
type DismissalSnapshot = { byBoard: ReadonlyMap<number, HiddenWallClimb>; loaded: boolean };

let byBoard: ReadonlyMap<number, HiddenWallClimb> = new Map();
let loaded = false;
let snapshot: DismissalSnapshot = { byBoard, loaded };
const SERVER_SNAPSHOT: DismissalSnapshot = { byBoard: new Map(), loaded: false };
const listeners = new Set<() => void>();
// Choices made before the disk read finishes override that read, while entries
// for other boards still load. Never write an incomplete map after a read error.
const pendingDismissals = new Map<number, HiddenWallClimb>();
let loadPromise: Promise<void> | null = null;
let writePromise = Promise.resolve();
let revision = 0;
let persistedRevision = 0;
let queuedRevision = 0;

function notify(): void {
  snapshot = { byBoard, loaded };
  for (const listener of listeners) listener();
}

function readHiddenClimb(entry: unknown): HiddenWallClimb | null {
  if (entry === null || typeof entry !== 'object') return null;
  if (!('climbUuid' in entry) || typeof entry.climbUuid !== 'string') return null;
  if (!('sentAt' in entry) || typeof entry.sentAt !== 'string') return null;
  return { climbUuid: entry.climbUuid, sentAt: entry.sentAt };
}

// Version 1 (#7169) stored one lighting per board as `[boardId, seq, sentAt, climbUuid]`.
// Its climb and lit time carry over, so a Hide made before the update holds.
function readVersionOneEntry(entry: unknown): HiddenWallClimb | null {
  if (typeof entry !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(entry);
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [, , sentAt, climbUuid]: unknown[] = parsed;
    return typeof climbUuid === 'string' && typeof sentAt === 'string' ? { climbUuid, sentAt } : null;
  } catch {
    return null;
  }
}

function readStoredDismissals(stored: unknown): Map<number, HiddenWallClimb> {
  if (stored === null || typeof stored !== 'object' || !('version' in stored)) return new Map();
  const readEntry = stored.version === 2 ? readHiddenClimb : stored.version === 1 ? readVersionOneEntry : null;
  if (readEntry === null) return new Map();
  if (!('byBoard' in stored) || stored.byBoard === null || typeof stored.byBoard !== 'object') return new Map();
  return new Map(
    Object.entries(stored.byBoard).flatMap(([boardId, entry]) => {
      const numericBoardId = Number(boardId);
      const hidden = readEntry(entry);
      return Number.isSafeInteger(numericBoardId) && hidden !== null ? [[numericBoardId, hidden] as const] : [];
    }),
  );
}

function persistDismissals(): void {
  const writtenRevision = revision;
  if (writtenRevision <= queuedRevision) return;
  queuedRevision = writtenRevision;
  const stored: StoredDismissals = { version: 2, byBoard: Object.fromEntries(byBoard) };
  // Every snapshot writes after its predecessor; an older slow write cannot
  // finish last and restore a Hide from before the latest change.
  writePromise = writePromise
    .then(() => setPreference(STORAGE_KEY, stored))
    .then(() => {
      persistedRevision = writtenRevision;
    })
    .catch(() => {
      // Keep the optimistic choice and retry the newest snapshot on foreground.
      if (queuedRevision === writtenRevision) queuedRevision = persistedRevision;
    });
}

function ensureLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loadPromise === null) {
    loadPromise = getPreference<unknown>(STORAGE_KEY)
      .then((stored) => {
        byBoard = new Map([...readStoredDismissals(stored), ...pendingDismissals]);
        loaded = true;
        const needsPersist = pendingDismissals.size > 0;
        pendingDismissals.clear();
        notify();
        if (needsPersist) persistDismissals();
      })
      .catch((error: unknown) => {
        loadPromise = null;
        throw error;
      });
  }
  return loadPromise;
}

function refreshDismissals(): void {
  if (!loaded) {
    void ensureLoaded().catch(() => {});
  } else if (persistedRevision < revision) {
    persistDismissals();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): DismissalSnapshot {
  return snapshot;
}

/** `earlier` was lit before `later`. Unreadable stamps never order, so they never protect a Hide. */
function litBefore(earlier: string, later: string): boolean {
  const earlierMs = Date.parse(earlier);
  const laterMs = Date.parse(later);
  return Number.isFinite(earlierMs) && Number.isFinite(laterMs) && earlierMs < laterMs;
}

/**
 * One lighting of one climb on one board: the board, the climb and the server's
 * lit time. It names what a capsule drew, so a Hide tapped on a capsule that
 * has since changed under the finger is dropped (`onDismiss` checks it). The
 * Hide itself covers the climb, not just this lighting.
 */
export function wallCapsuleOccurrenceKey(boardId: number, climb: WallClimbStamp): string {
  return JSON.stringify([boardId, climb.climbUuid, climb.sentAt]);
}

/**
 * Hide this climb on this board on this device, including across launches,
 * until a different climb goes up there. One entry per board, so the newest
 * choice replaces the last and the stored map never grows past the boards this
 * phone has looked at.
 */
export function dismissWallCapsule(boardId: number, climb: WallClimbStamp): void {
  const current = byBoard.get(boardId);
  if (current?.climbUuid === climb.climbUuid && current.sentAt === climb.sentAt) return;
  const hidden: HiddenWallClimb = { climbUuid: climb.climbUuid, sentAt: climb.sentAt };
  byBoard = new Map(byBoard).set(boardId, hidden);
  revision++;
  if (!loaded) pendingDismissals.set(boardId, hidden);
  notify();
  if (loaded) persistDismissals();
  else refreshDismissals();
}

/**
 * The board's presence reported `climb` as the climb on the wall. A different
 * climb lit at or after the hidden lighting ends that board's Hide, so the
 * hidden climb shows again if it ever comes back. The hidden climb itself, or
 * an older report, changes nothing.
 */
export function observeWallClimb(boardId: number, climb: WallClimbStamp): void {
  if (!loaded) return;
  const hidden = byBoard.get(boardId);
  if (hidden === undefined || hidden.climbUuid === climb.climbUuid) return;
  if (litBefore(climb.sentAt, hidden.sentAt)) return;
  const next = new Map(byBoard);
  next.delete(boardId);
  byBoard = next;
  revision++;
  notify();
  persistDismissals();
}

export type WallCapsuleDismissal = {
  /** False until stored Hides are read, so a stored Hide never flashes. True with no board. */
  loaded: boolean;
  /** The climb on the wall is the one the climber hid on this board. */
  dismissed: boolean;
  /** The climb hidden on this board, if any, for surfaces that draw a climb without presence. */
  hiddenClimbUuid: string | null;
};

/**
 * The Hide state of a board's wall. Pass the board's live wall climb whether or
 * not it is still trusted: a different climb on the wall, even past the hour,
 * went up after the hidden one and ends its Hide.
 */
export function useWallCapsuleDismissal(
  boardId: number | null,
  wallClimb: WallClimbStamp | null,
): WallCapsuleDismissal {
  const currentSnapshot = useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);
  useEffect(() => {
    if (boardId === null) return undefined;
    refreshDismissals();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshDismissals();
    });
    return () => subscription.remove();
  }, [boardId]);
  const hidden = boardId === null ? undefined : currentSnapshot.byBoard.get(boardId);
  const climbUuid = wallClimb?.climbUuid ?? null;
  const sentAt = wallClimb?.sentAt ?? null;
  const storeLoaded = currentSnapshot.loaded;
  useEffect(() => {
    if (!storeLoaded || boardId === null || climbUuid === null || sentAt === null) return;
    observeWallClimb(boardId, { climbUuid, sentAt });
  }, [storeLoaded, boardId, climbUuid, sentAt, hidden]);
  return {
    loaded: boardId === null || storeLoaded,
    dismissed: hidden !== undefined && climbUuid !== null && hidden.climbUuid === climbUuid,
    hiddenClimbUuid: hidden?.climbUuid ?? null,
  };
}

/** Test-only: finish the stored read, as a running app has long since done. */
export function hydrateWallCapsuleDismissalsForTests(): Promise<void> {
  return ensureLoaded();
}

/** Test-only: simulate a cold launch while preserving the preference backing store. */
export function resetWallCapsuleDismissalsForTests(): void {
  byBoard = new Map();
  loaded = false;
  snapshot = { byBoard, loaded };
  pendingDismissals.clear();
  loadPromise = null;
  writePromise = Promise.resolve();
  revision = 0;
  persistedRevision = 0;
  queuedRevision = 0;
}
