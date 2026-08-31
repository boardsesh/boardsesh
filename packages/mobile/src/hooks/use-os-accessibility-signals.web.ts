import type { OsAccessibilitySignals } from './use-os-accessibility-signals';

/**
 * Browsers do not expose the OS accessibility settings this hook reads through
 * React Native Web's `AccessibilityInfo`, so the web build reports every signal
 * as `'unknown'` — which suppresses every board-look suggestion — but `ready:
 * true`, so a caller waiting on the settled flag does not spin forever.
 *
 * Frozen because the object is a constant: callers memoize on identity, and a
 * fresh object per render would re-fire their effects on every tick.
 *
 * TODO: an honest web fork is possible if it is ever wanted. Browsers expose
 * `matchMedia('(prefers-contrast: more)')` and `matchMedia('(forced-colors:
 * active)')`, which map onto the increase-contrast signal; there is no
 * greyscale-display media query, so that one would stay `'unknown'`.
 */
const WEB_SIGNALS: OsAccessibilitySignals = Object.freeze({
  increaseContrast: 'unknown',
  grayscale: 'unknown',
  ready: true,
});

export type { OsAccessibilitySignals, SignalState, OsAccessibilitySignalId } from './use-os-accessibility-signals';

export function useOsAccessibilitySignals(): OsAccessibilitySignals {
  return WEB_SIGNALS;
}
