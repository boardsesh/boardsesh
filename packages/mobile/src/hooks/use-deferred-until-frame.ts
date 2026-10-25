import { useEffect, useState } from 'react';

/**
 * Defer mounting heavy content until the next frame after `active` becomes true,
 * so a modal/present animation gets a cheap first frame and the heavy content
 * fills in one frame later — without waiting for an idle period.
 *
 * Returns `false` until a single `requestAnimationFrame` fires after `active`
 * turns true, then `true`. A rAF does not wait for an idle period, so
 * no fallback timer is needed — the frame always comes. Resets to `false` when
 * `active` goes false, so the next activation re-defers. Stays ready across
 * in-place content changes while `active` holds true (e.g. the play-drawer board
 * swiping between climbs once the drawer is open).
 */
export function useDeferredUntilFrame(active: boolean): boolean {
  // Screenshot mode: seed `ready` true on the FIRST render (lazy init, before any
  // effect commits) so the heavy content is present in the very first frame — the
  // rAF defer otherwise leaves the surface blank when Android's `adb screencap`
  // (Maestro) captures the open animation. The effect below keeps it in sync on
  // re-activation. Folds out of normal builds.
  const [ready, setReady] = useState(() => process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' && active);

  useEffect(() => {
    // Screenshot mode: no defer — mirror `active` straight into `ready` so a
    // re-activation (or reset) tracks it. The first render is already handled by
    // the lazy initializer above.
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') {
      setReady(active);
      return;
    }

    if (!active) {
      setReady(false);
      return;
    }

    // Re-defer from scratch on each (re)activation, then flip ready on the next
    // frame — the present animation runs natively over the placeholder meanwhile.
    setReady(false);
    const handle = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(handle);
  }, [active]);

  return ready;
}
