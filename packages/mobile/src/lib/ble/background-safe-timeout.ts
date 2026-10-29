import { sessionPresenceNative } from '../../../modules/live-activity/src/index';

/**
 * A `setTimeout` that still fires while Android has paused JS timers (#7038).
 *
 * React Native's JavaTimerManager stops firing JS timers once the activity
 * pauses (`onHostPause`), while the JS thread keeps running. A connect started
 * from the session notification's bulb runs with the app in the background, so a
 * watchdog built on `setTimeout` alone only fires when the app comes back. On
 * Android this races the JS timer against SessionPresence's native `delay`,
 * whose clock keeps running while the activity is paused (it stops in deep
 * sleep, like every uptime clock, so a locked phone hears it after unlock).
 * Whichever lands first runs the callback; the other is ignored.
 *
 * SessionPresence is Android's module alone, so iOS (whose JS timers keep
 * running) gets the plain JS timer, as does a binary that predates the native
 * method (an OTA'd bundle on an older build).
 *
 * Returns a cancel function. Cancelling is a JS flag: the native delay still
 * resolves later, into a callback that does nothing.
 */
export function setBackgroundSafeTimeout(callback: () => void, delayMs: number): () => void {
  let done = false;
  // Reads `jsTimer` before its const below: safe, only the native `.then` (a later microtask) calls this.
  const fire = () => {
    if (done) return;
    done = true;
    clearTimeout(jsTimer);
    callback();
  };
  const jsTimer = setTimeout(fire, delayMs);

  if (sessionPresenceNative && typeof sessionPresenceNative.delay === 'function') {
    // A rejected native delay leaves the JS timer in charge, as on an old binary.
    sessionPresenceNative.delay(delayMs).then(fire, () => {});
  }

  return () => {
    done = true;
    clearTimeout(jsTimer);
  };
}
