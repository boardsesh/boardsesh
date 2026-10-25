import { useEffect, useState } from 'react';
import { scheduleIdleTask } from '../lib/schedule-idle-task';

/**
 * Defer heavy content until a frame has painted and the JS thread has idle time.
 * The bounded fallback still mounts it when a busy JS thread delays idle work.
 * Reset on deactivation or resetKey changes; omit resetKey to stay ready across
 * in-place content changes while a drawer remains open.
 */
export function useDeferredAfterInteractions(active: boolean, resetKey?: string | number, timeoutMs = 350): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Screenshot mode: mount heavy content synchronously (no defer) so it
    // composites in the same frames as the open animation. The deferred mount
    // lands at a variable time (idle callback, else the timeout fallback),
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

    const handle = scheduleIdleTask(markReady);
    const fallback = setTimeout(markReady, timeoutMs);

    return () => {
      handle.cancel();
      clearTimeout(fallback);
    };
  }, [active, resetKey, timeoutMs]);

  return ready;
}
