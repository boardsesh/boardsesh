import { useEffect, useState, useSyncExternalStore } from 'react';
import { getPreference, removePreference, setPreference } from './preference-store';

/**
 * The wall button's frost peek (#7113, hint B): the frost wipes in 28 pt from
 * the trailing edge and springs back, to show the button can be swiped. The ‹‹
 * chevrons (hint A) stay regardless.
 *
 * 2.7 (spec B3): the swipe now turns Put on board's keep-lighting window into an
 * open-ended drive, so the peek plays where that is news:
 *
 * - the first time a keep-lighting window starts in an app session, and
 * - once more in that session, on the third Put on board within 5 minutes:
 *   a climber putting climbs up one press at a time.
 *
 * In at most `MAX_PEEK_SESSIONS` sessions, counted on a v2 key. A climber who
 * saw 2.6's three peeks (its count, still on the device) gets ONE more peek for
 * the new meaning, not three: `UPGRADE_PEEKS`, and not a whole session's worth
 * either, so the session that plays it plays no replay. Everyone else, a
 * newcomer or a climber 2.6 showed fewer than three, gets the normal three.
 * Never once a swipe has driven the wall (that key is kept from 2.6: they know
 * the gesture), never in screenshot mode, never with a screen reader on.
 *
 * Built like `reset-zoom-hint.ts`: AsyncStorage rather than SecureStore, since
 * this is a device-local UI marker and the keychain outlives an uninstall.
 */
const SESSIONS_KEY = 'wallSwipePeekSessionsV2';
/** 2.6's count: at `MAX_PEEK_SESSIONS` the climber is an upgrader owed `UPGRADE_PEEKS`. Never written now. */
const LEGACY_SESSIONS_KEY = 'wallSwipePeekSessions';
const USED_KEY = 'wallSwipeUsed';
export const MAX_PEEK_SESSIONS = 3;
/** Peeks a climber who saw all of 2.6's gets for 2.7's meaning: one, then never again. */
export const UPGRADE_PEEKS = 1;
/** The replay: this many Put on board presses... */
export const PUT_ON_BOARD_REPLAY_PRESSES = 3;
/** ...within this long. */
export const PUT_ON_BOARD_REPLAY_WINDOW_MS = 5 * 60_000;

/** In memory: this app session has played its window peek (or decided not to). */
let peekedThisSession = false;
/** In memory: this app session has played its replay. */
let replayedThisSession = false;
/** In memory: this app session already counts towards the three. */
let countedThisSession = false;
/** Recent Put on board presses, oldest first, inside the replay window. */
let putOnBoardPresses: number[] = [];
/** The third press inside the window landed: the replay is owed this session. */
let replayAsked = false;
const replayListeners = new Set<() => void>();

function emitReplay(): void {
  for (const listener of replayListeners) listener();
}

/**
 * How much of the hint a climber may still see, from the two counts:
 * - an upgrader (2.6's count reached `MAX_PEEK_SESSIONS`) gets `UPGRADE_PEEKS`
 *   peeks, counted one per session, and none more in the session that played
 *   one (the replay included);
 * - anyone else gets `MAX_PEEK_SESSIONS` sessions, every peek of a session
 *   (its window peek and its replay) included.
 * Pure, so the rule is pinned by a test of its own.
 */
export function wallSwipePeekOwed({
  used,
  legacySessions,
  sessions,
  countedThisSession: counted,
}: {
  used: boolean;
  legacySessions: number | null;
  sessions: number | null;
  countedThisSession: boolean;
}): boolean {
  if (used) return false;
  const shown = sessions ?? 0;
  if ((legacySessions ?? 0) >= MAX_PEEK_SESSIONS) return !counted && shown < UPGRADE_PEEKS;
  return counted || shown < MAX_PEEK_SESSIONS;
}

const countOrNull = (value: number | null): number | null => (typeof value === 'number' ? value : null);

/** A store error reads as "no": a hint that reappears on every open is the nagging it must avoid. */
async function hintStillOwed(): Promise<boolean> {
  try {
    const used = (await getPreference<boolean>(USED_KEY)) === true;
    if (used) return false;
    return wallSwipePeekOwed({
      used,
      legacySessions: countOrNull(await getPreference<number>(LEGACY_SESSIONS_KEY)),
      sessions: countOrNull(await getPreference<number>(SESSIONS_KEY)),
      countedThisSession,
    });
  } catch {
    return false;
  }
}

/**
 * Whether the window peek should play now. False in screenshot mode (a captured
 * button never carries a half-wiped frost), after this session's peek, once the
 * swipe has been used, or after three sessions.
 */
export async function shouldPlayWallSwipePeek(): Promise<boolean> {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return false;
  if (peekedThisSession) return false;
  return hintStillOwed();
}

/** Whether the replay should play now: owed, not played this session, and the hint still owed. */
export async function shouldPlayWallSwipeReplay(): Promise<boolean> {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return false;
  if (replayedThisSession || !replayAsked) return false;
  return hintStillOwed();
}

/**
 * Claim this session's window peek: true for the first caller only, so two
 * buttons mounted at once never both play it. In memory only: a session counts
 * towards the three once a peek actually plays (`recordWallSwipePeekPlayed`).
 */
export function claimWallSwipePeek(): boolean {
  if (peekedThisSession) return false;
  peekedThisSession = true;
  return true;
}

/** Claim this session's replay, as `claimWallSwipePeek` does. */
export function claimWallSwipeReplay(): boolean {
  if (replayedThisSession || !replayAsked) return false;
  replayedThisSession = true;
  return true;
}

/**
 * A press on Put on board put a climb up. The third within
 * `PUT_ON_BOARD_REPLAY_WINDOW_MS` asks for the session's replay.
 */
export function noteWallPutOnBoardPress(now = Date.now()): void {
  if (replayedThisSession || replayAsked) return;
  putOnBoardPresses = [...putOnBoardPresses.filter((at) => now - at < PUT_ON_BOARD_REPLAY_WINDOW_MS), now];
  if (putOnBoardPresses.length < PUT_ON_BOARD_REPLAY_PRESSES) return;
  putOnBoardPresses = [];
  replayAsked = true;
  emitReplay();
}

/** A peek played on screen: this session counts towards the three, once. */
export function recordWallSwipePeekPlayed(): void {
  if (countedThisSession) return;
  countedThisSession = true;
  void (async () => {
    try {
      const sessions = await getPreference<number>(SESSIONS_KEY);
      await setPreference(SESSIONS_KEY, (typeof sessions === 'number' ? sessions : 0) + 1);
    } catch {
      // A lost count only means one more peek, at most.
    }
  })();
}

/** A swipe drove the wall: the climber knows the gesture, so the peek stops for good. */
export async function markWallSwipeUsed(): Promise<void> {
  peekedThisSession = true;
  replayedThisSession = true;
  try {
    await setPreference(USED_KEY, true);
  } catch {
    // The session flags still stop it until the next launch.
  }
}

/** Tests and the developer reset: a fresh device. */
export async function clearWallSwipeHint(): Promise<void> {
  resetWallSwipeHintSessionForTests();
  await removePreference(SESSIONS_KEY);
  await removePreference(LEGACY_SESSIONS_KEY);
  await removePreference(USED_KEY);
}

/** Tests only: a new app session, storage untouched. */
export function resetWallSwipeHintSessionForTests(): void {
  peekedThisSession = false;
  replayedThisSession = false;
  countedThisSession = false;
  putOnBoardPresses = [];
  replayAsked = false;
  emitReplay();
}

function subscribeReplay(listener: () => void): () => void {
  replayListeners.add(listener);
  return () => {
    replayListeners.delete(listener);
  };
}

const readReplayAsked = (): boolean => replayAsked;

export type WallSwipePeekTriggers = {
  /** The button offers the swipe (`swipeAction`, the flag wired, not a story frame). */
  offered: boolean;
  /** Put on board's keep-lighting window is live on this button (`model.lightWindow`). */
  windowLive: boolean;
  /** VoiceOver or TalkBack is on: the peek never plays. */
  screenReaderOn: boolean;
};

/**
 * A counter that goes up each time the peek should play on this button: the
 * first window start in a session, and the session's one replay after the
 * third Put on board within 5 minutes. The button plays the peek on each change.
 */
export function useWallSwipePeek({ offered, windowLive, screenReaderOn }: WallSwipePeekTriggers): number {
  const [token, setToken] = useState(0);
  const replayOwed = useSyncExternalStore(subscribeReplay, readReplayAsked, readReplayAsked);

  useEffect(() => {
    if (!offered || !windowLive || screenReaderOn) return undefined;
    let cancelled = false;
    void shouldPlayWallSwipePeek().then((play) => {
      if (cancelled || !play || !claimWallSwipePeek()) return;
      setToken((current) => current + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [offered, windowLive, screenReaderOn]);

  useEffect(() => {
    if (!offered || !replayOwed || screenReaderOn) return undefined;
    let cancelled = false;
    void shouldPlayWallSwipeReplay().then((play) => {
      if (cancelled || !play || !claimWallSwipeReplay()) return;
      setToken((current) => current + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [offered, replayOwed, screenReaderOn]);

  return token;
}
