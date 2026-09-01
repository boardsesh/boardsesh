import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, type EventSubscription, Platform } from 'react-native';
import { useIsAppBackgrounded } from '../lib/app-visibility';

/**
 * The two OS accessibility settings the Board look screen is allowed to notice.
 *
 * Built to the shape of `use-reduce-transparency` / `use-reduce-motion` (a `.ts`,
 * a `.web.ts` and a test), with ONE deliberate departure: **the default posture
 * is inverted.** Those hooks default to a conservative `true` because being
 * wrong costs a single frame of glass. Here being wrong costs an unwanted
 * interruption — a banner suggesting a board look nobody asked about — so every
 * signal starts `'unknown'` with `ready: false`, and a caller must wait for
 * `ready` before it may show anything.
 *
 * Why a three-state signal instead of a boolean: `AccessibilityInfo` RESOLVES
 * `false` for a query the running platform does not implement rather than
 * rejecting, so a plain boolean cannot tell "the climber has it off" from "this
 * platform never answers". Verified against the installed React Native source
 * (`Libraries/Components/AccessibilityInfo/AccessibilityInfo.js`):
 *
 * | Query                          | iOS  | Android          |
 * | ------------------------------ | ---- | ---------------- |
 * | `isGrayscaleEnabled`           | real | real             |
 * | `isDarkerSystemColorsEnabled`  | real | hardcoded false  |
 * | `isHighTextContrastEnabled`    | hardcoded false | real  |
 *
 * The table below encodes that as a DECLARED fact (`query: null` = never ask)
 * instead of inferring it from an untrustworthy `false`.
 *
 * Queries can also REJECT — on Android when the native method is missing, and on
 * iOS too when an older native binary runs a newer JS bundle — so every call
 * carries a `.catch` that lands on `'unknown'`, never on `'off'`.
 *
 * Events: `AccessibilityInfo.addEventListener` returns a silent no-op
 * subscription (`{remove(){}}`) for a name the running platform does not map —
 * it looks alive forever and never fires. The public names below are the ones RN
 * actually maps on each platform; note `grayscaleChanged` is the public name on
 * BOTH (RN maps it to the native `grayscaleModeDidChange` on Android itself, so
 * subscribing to that native name from JS would get the no-op subscription).
 */

/** 'unknown' = not queryable on this platform, the query rejected, or not read yet. */
export type SignalState = 'on' | 'off' | 'unknown';

export type OsAccessibilitySignals = {
  increaseContrast: SignalState;
  grayscale: SignalState;
  /** Every queryable signal has settled (resolved OR rejected). */
  ready: boolean;
};

export type OsAccessibilitySignalId = 'increaseContrast' | 'grayscale';

/** The RN public event names we may subscribe to. Anything else is a no-op sub. */
type AccessibilitySignalEventName = 'grayscaleChanged' | 'darkerSystemColorsChanged' | 'highTextContrastChanged';

type PlatformSignal = {
  /** `null` = this platform hardcodes `false`; asking would be a lie, so we don't. */
  query: (() => Promise<boolean>) | null;
  /** `null` = no mapped event here; subscribing would return a dead subscription. */
  eventName: AccessibilitySignalEventName | null;
};

const SIGNAL_IDS: readonly OsAccessibilitySignalId[] = ['increaseContrast', 'grayscale'];

const UNSUPPORTED_SIGNAL: PlatformSignal = { query: null, eventName: null };

/**
 * Module-scope platform table.
 *
 * iOS "Increase Contrast" and Android "High contrast text" are different
 * settings with the same intent, which is why they share one signal id — the
 * copy that names them differs per platform, the rule does not. Android's toggle
 * is buried (Settings > Accessibility > Text and display > High contrast text)
 * and rarely on, so the contrast rule will fire far less often there. That is a
 * hit-rate difference, not a correctness one.
 */
function signalsForPlatform(os: string): Record<OsAccessibilitySignalId, PlatformSignal> {
  if (os === 'ios') {
    return {
      increaseContrast: {
        query: () => AccessibilityInfo.isDarkerSystemColorsEnabled(),
        eventName: 'darkerSystemColorsChanged',
      },
      grayscale: { query: () => AccessibilityInfo.isGrayscaleEnabled(), eventName: 'grayscaleChanged' },
    };
  }
  if (os === 'android') {
    return {
      increaseContrast: {
        query: () => AccessibilityInfo.isHighTextContrastEnabled(),
        eventName: 'highTextContrastChanged',
      },
      grayscale: { query: () => AccessibilityInfo.isGrayscaleEnabled(), eventName: 'grayscaleChanged' },
    };
  }
  return { increaseContrast: UNSUPPORTED_SIGNAL, grayscale: UNSUPPORTED_SIGNAL };
}

const PLATFORM_SIGNALS = signalsForPlatform(Platform.OS);

const INITIAL_SIGNALS: OsAccessibilitySignals = {
  increaseContrast: 'unknown',
  grayscale: 'unknown',
  ready: false,
};

function withSignal(
  previous: OsAccessibilitySignals,
  id: OsAccessibilitySignalId,
  state: SignalState,
): OsAccessibilitySignals {
  if (previous[id] === state) return previous;
  // Written out per key rather than with a computed one so the object stays
  // exactly `OsAccessibilitySignals` with no index signature widening.
  return id === 'grayscale' ? { ...previous, grayscale: state } : { ...previous, increaseContrast: state };
}

export function useOsAccessibilitySignals(): OsAccessibilitySignals {
  const [signals, setSignals] = useState<OsAccessibilitySignals>(INITIAL_SIGNALS);

  // Re-poll on the background -> foreground edge. The realistic flow is leaving
  // for Settings, flipping the toggle and coming back; the change events cover
  // the in-app case, but a platform that maps no event for a signal has nothing
  // else to notice with.
  const backgrounded = useIsAppBackgrounded();
  const wasBackgrounded = useRef(backgrounded);
  const [pollToken, setPollToken] = useState(0);

  useEffect(() => {
    if (wasBackgrounded.current && !backgrounded) setPollToken((token) => token + 1);
    wasBackgrounded.current = backgrounded;
  }, [backgrounded]);

  useEffect(() => {
    let cancelled = false;

    const reads = SIGNAL_IDS.map((id) => {
      const { query } = PLATFORM_SIGNALS[id];
      if (!query) return null;
      return query()
        .then((enabled): SignalState => (enabled ? 'on' : 'off'))
        .catch((): SignalState => 'unknown')
        .then((state) => {
          if (!cancelled) setSignals((previous) => withSignal(previous, id, state));
        });
    }).filter((read): read is Promise<void> => read !== null);

    if (reads.length === 0) {
      // Nothing to wait for: settle immediately so a caller doesn't spin. Every
      // signal stays 'unknown', which suppresses every suggestion.
      setSignals((previous) => (previous.ready ? previous : { ...previous, ready: true }));
      return () => {
        cancelled = true;
      };
    }

    void Promise.all(reads).then(() => {
      if (!cancelled) setSignals((previous) => (previous.ready ? previous : { ...previous, ready: true }));
    });

    return () => {
      cancelled = true;
    };
  }, [pollToken]);

  useEffect(() => {
    const subscriptions: EventSubscription[] = [];
    for (const id of SIGNAL_IDS) {
      const { eventName } = PLATFORM_SIGNALS[id];
      if (!eventName) continue;
      subscriptions.push(
        AccessibilityInfo.addEventListener(eventName, (enabled: boolean) => {
          setSignals((previous) => withSignal(previous, id, enabled ? 'on' : 'off'));
        }),
      );
    }
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, []);

  return signals;
}
