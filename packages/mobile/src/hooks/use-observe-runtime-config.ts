import { useEffect, useRef } from 'react';
import { AppState, type NativeEventSubscription } from 'react-native';
import { useFeatureFlags, useFeatureFlagsResolved } from '../providers/feature-flags-provider';
import { parseObserveSampleRate, resolveObserveDispatchEnabled } from '../lib/observe-config';
import { configureObserve, dispatchObserveEvents, discardObserveEvents } from '../lib/observe-runtime';
import { useAnalyticsConsent } from '../lib/consent-hooks';
import { isProductAnalyticsGranted } from '../lib/consent-state';

/**
 * Re-applies the Observe dispatch settings whenever the PostHog flags change.
 *
 * `observe-bootstrap.ts` has already configured the SDK with the shipped
 * defaults by the time this runs — it has to, because the router integration
 * cannot be turned on after a screen mounts. This only ever adjusts the two
 * settings that ARE safe to change at runtime, and `buildObserveConfig` passes
 * the same integrations constant back so the integration never looks toggled.
 *
 * Startup sampling and dispatch are both disabled. Pending native metrics are
 * discarded before a resolved flag and effective consent can enable dispatch.
 *
 * A no-op when no runtime is registered (node tests, Expo web).
 *
 * On a cold start this first applies the unresolved bag, then deliberately
 * re-applies it when PostHog's answer becomes final even if the values stayed at
 * their defaults. Configuration and listener setup share one effect, so the
 * first foreground flush always follows the final configuration.
 */
export function useObserveRuntimeConfig(): void {
  const consentGranted = useAnalyticsConsent();
  const flags = useFeatureFlags();
  const flagsResolved = useFeatureFlagsResolved();
  const dispatchFlag = flags['observe-dispatch-enabled'];
  const sampleRateFlag = flags['observe-sample-rate'];
  const appStateSubscription = useRef<NativeEventSubscription | null>(null);

  useEffect(() => {
    let cancelled = false;
    configureObserve({ dispatchingEnabled: false, sampleRate: 0 });
    void discardObserveEvents()
      .then(() => {
        if (
          cancelled ||
          !consentGranted ||
          !isProductAnalyticsGranted() ||
          !flagsResolved ||
          !resolveObserveDispatchEnabled(dispatchFlag)
        )
          return;
        configureObserve({ dispatchingEnabled: true, sampleRate: parseObserveSampleRate(sampleRateFlag) });
        if (AppState.currentState === 'active') void dispatchObserveEvents();
      })
      .catch(() => {
        /* Discard failure keeps dispatch disabled. */
      });
    // Keep configuration before the first flush in the same effect. Flag updates
    // reconfigure the SDK without replacing the listener or flushing again.
    if (!flagsResolved || appStateSubscription.current)
      return () => {
        cancelled = true;
      };

    let previousAppState = AppState.currentState;
    appStateSubscription.current = AppState.addEventListener('change', (nextAppState) => {
      const enteredForeground = nextAppState === 'active' && previousAppState !== 'active';
      previousAppState = nextAppState;
      // Rapid transitions may overlap best-effort native queue flushes; the app
      // lifecycle does not wait for telemetry dispatch or its network requests.
      if (enteredForeground) void dispatchObserveEvents();
    });
    return () => {
      cancelled = true;
    };
  }, [dispatchFlag, flagsResolved, sampleRateFlag, consentGranted]);

  useEffect(
    () => () => {
      appStateSubscription.current?.remove();
      appStateSubscription.current = null;
    },
    [],
  );
}
