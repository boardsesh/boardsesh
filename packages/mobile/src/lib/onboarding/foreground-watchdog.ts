import type { AppStateStatus } from 'react-native';

/** The slice of React Native's `AppState` the watchdog needs, injectable for tests. */
export type AppStateSource = {
  currentState: AppStateStatus | null | undefined;
  addEventListener: (type: 'change', listener: (state: AppStateStatus) => void) => { remove: () => void };
};

type ForegroundWatchdogOptions = {
  timeoutMs: number;
  onExpire: () => void;
  appState: AppStateSource;
  /** Monotonic-enough clock for the pause bookkeeping. */
  now?: () => number;
};

/**
 * Calls `onExpire` once `timeoutMs` of FOREGROUND time has passed, unless the
 * returned `stop` runs first. Fires at most once.
 *
 * Only `active` counts. A launch gate cannot decide while the app is suspended,
 * so counting background time would report every climber who opened the app
 * and switched away within the window as stalled. The clock pauses when the app
 * leaves `active` and resumes with whatever was left when it comes back.
 */
export function startForegroundWatchdog({
  timeoutMs,
  onExpire,
  appState,
  now = Date.now,
}: ForegroundWatchdogOptions): () => void {
  let remainingMs = timeoutMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resumedAt = 0;
  let finished = false;

  const pause = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    remainingMs = Math.max(0, remainingMs - (now() - resumedAt));
  };

  const resume = () => {
    if (finished || timer !== null) return;
    resumedAt = now();
    timer = setTimeout(() => {
      timer = null;
      finished = true;
      subscription.remove();
      onExpire();
    }, remainingMs);
  };

  const subscription = appState.addEventListener('change', (nextState) => {
    if (nextState === 'active') resume();
    else pause();
  });
  if (appState.currentState === 'active') resume();

  return () => {
    if (finished) return;
    finished = true;
    pause();
    subscription.remove();
  };
}
