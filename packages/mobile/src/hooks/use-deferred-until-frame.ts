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
  const [ready, setReady] = useState(false);

  useEffect(() => {
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
