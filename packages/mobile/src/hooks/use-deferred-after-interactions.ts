import { useEffect, useState } from 'react';
import { InteractionManager } from 'react-native';
import { AFTER_INTERACTIONS_FALLBACK_TIMEOUT_MS } from '../lib/after-interactions';

/**
 * Defer mounting heavy content until just after an open/transition animation,
 * WITHOUT the risk that a starved interaction queue leaves it permanently
 * unmounted.
 *
 * Returns `false` until the JS interaction queue settles after `active` becomes
 * true (so the heavy content mounts AFTER the animation rather than blocking its
 * first frame), then `true`. Crucially it ALSO flips `true` after `timeoutMs` as
 * a safety net: `InteractionManager.runAfterInteractions` can be starved
 * indefinitely if any interaction handle (e.g. a bottom-sheet present animation,
 * or a leaked handle anywhere in the app) never clears — which would otherwise
 * leave the deferred content blank until the surface is reopened. The timeout
 * guarantees the content mounts within a bounded time regardless.
 *
 * Resets to `false` whenever `active` goes false or `resetKey` changes, so the
 * next transition re-defers. Omit `resetKey` to stay ready across in-place
 * content changes (e.g. the play-drawer board, which should render immediately
 * when you swipe to the next climb once the drawer is already open).
 */
export function useDeferredAfterInteractions(
  active: boolean,
  resetKey?: string | number,
  timeoutMs = AFTER_INTERACTIONS_FALLBACK_TIMEOUT_MS,
): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Screenshot mode: mount heavy content synchronously (no defer) so it
    // composites in the same frames as the open animation. The deferred mount
    // lands at a variable time (runAfterInteractions, else the timeout fallback),
    // and Android's `adb screencap` (Maestro) captured the play-drawer board-view
    // blank ~half the time as a result — the carousel-free board-presence sheet,
    // which renders synchronously, never flaked. Folds out of normal builds.
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') {
      setReady(active);
      return;
    }

    if (!active) {
      setReady(false);
      return;
    }

    // Re-defer from scratch on each (re)activation / resetKey change.
    setReady(false);

    let settled = false;
    const markReady = () => {
      if (settled) return;
      settled = true;
      setReady(true);
    };

    const handle = InteractionManager.runAfterInteractions(markReady);
    const fallback = setTimeout(markReady, timeoutMs);

    return () => {
      handle.cancel();
      clearTimeout(fallback);
    };
  }, [active, resetKey, timeoutMs]);

  return ready;
}
