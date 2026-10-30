import { useEffect, useState } from 'react';
import { getPreference, removePreference, setPreference } from './preference-store';

/**
 * The wall button's one-time frost peek (#7113, hint B): the frost wipes in
 * 28 pt from the trailing edge and springs back, to show the button can be
 * swiped. It plays the first time a swipeable state shows in an app session,
 * in at most `MAX_PEEK_SESSIONS` sessions, and never again once the swipe has
 * driven the wall. The ‹‹ chevrons (hint A) stay regardless.
 *
 * Built like `reset-zoom-hint.ts`: AsyncStorage rather than SecureStore, since
 * this is a device-local UI marker and the keychain outlives an uninstall.
 */
const SESSIONS_KEY = 'wallSwipePeekSessions';
const USED_KEY = 'wallSwipeUsed';
export const MAX_PEEK_SESSIONS = 3;

/** In memory: this app session has played its peek (or decided not to). */
let peekedThisSession = false;

/**
 * Whether the peek should play now. False in screenshot mode (a captured
 * button never carries a half-wiped frost), after this session's peek, once
 * the swipe has been used, or after three sessions. A store error reads as
 * "no": a hint that reappears on every open is the nagging it must avoid.
 */
export async function shouldPlayWallSwipePeek(): Promise<boolean> {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return false;
  if (peekedThisSession) return false;
  try {
    if ((await getPreference<boolean>(USED_KEY)) === true) return false;
    const sessions = await getPreference<number>(SESSIONS_KEY);
    return typeof sessions !== 'number' || sessions < MAX_PEEK_SESSIONS;
  } catch {
    return false;
  }
}

/**
 * Claim this session's peek: true for the first caller only, so two buttons
 * mounted at once never both play it. In memory only: a session counts towards
 * the three once the peek actually plays (`recordWallSwipePeekPlayed`).
 */
export function claimWallSwipePeek(): boolean {
  if (peekedThisSession) return false;
  peekedThisSession = true;
  return true;
}

/** The peek played on screen: this session counts towards the three. */
export function recordWallSwipePeekPlayed(): void {
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
  try {
    await setPreference(USED_KEY, true);
  } catch {
    // The session flag still stops it until the next launch.
  }
}

/** Tests and the developer reset: a fresh device. */
export async function clearWallSwipeHint(): Promise<void> {
  peekedThisSession = false;
  await removePreference(SESSIONS_KEY);
  await removePreference(USED_KEY);
}

/** Tests only: a new app session, storage untouched. */
export function resetWallSwipeHintSessionForTests(): void {
  peekedThisSession = false;
}

/**
 * A counter that goes up once when the peek should play on this button: the
 * first time `offered` turns true in a session, while the hint still has
 * sessions left. The button plays the peek on each change.
 */
export function useWallSwipePeek(offered: boolean): number {
  const [token, setToken] = useState(0);
  useEffect(() => {
    if (!offered) return undefined;
    let cancelled = false;
    void shouldPlayWallSwipePeek().then((play) => {
      if (cancelled || !play || !claimWallSwipePeek()) return;
      setToken((current) => current + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [offered]);
  return token;
}
