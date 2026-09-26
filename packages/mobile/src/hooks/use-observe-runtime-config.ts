import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useFeatureFlags, useFeatureFlagsResolved } from '../providers/feature-flags-provider';
import { parseObserveSampleRate, resolveObserveDispatchEnabled } from '../lib/observe-config';
import { configureObserve, dispatchObserveEvents } from '../lib/observe-runtime';

/**
 * Re-applies the Observe dispatch settings whenever the PostHog flags change.
 *
 * `observe-bootstrap.ts` has already configured the SDK with the shipped
 * defaults by the time this runs — it has to, because the router integration
 * cannot be turned on after a screen mounts. This only ever adjusts the two
 * settings that ARE safe to change at runtime, and `buildObserveConfig` passes
 * the same integrations constant back so the integration never looks toggled.
 *
 * Flags resolve asynchronously, so a cold start always collects at the shipped
 * default for a moment. That is intended per docs/feature-flags.md — an
 * unresolved flag reads as the shipped default rather than as "off", so a device
 * that never reaches PostHog keeps reporting instead of going quiet forever.
 *
 * A no-op when no runtime is registered (node tests, Expo web).
 *
 * On a cold start this first applies the unresolved bag, then deliberately
 * re-applies it when PostHog's answer becomes final even if the values stayed at
 * their defaults. The latter effect run precedes the first manual flush below,
 * so that foreground flush never uses a provisional kill switch or sample rate.
 */
export function useObserveRuntimeConfig(): void {
  const flags = useFeatureFlags();
  const flagsResolved = useFeatureFlagsResolved();
  const dispatchFlag = flags['observe-dispatch-enabled'];
  const sampleRateFlag = flags['observe-sample-rate'];

  useEffect(() => {
    configureObserve({
      dispatchingEnabled: resolveObserveDispatchEnabled(dispatchFlag),
      sampleRate: parseObserveSampleRate(sampleRateFlag),
    });
    // Re-apply once when the flag bag becomes final, even when its values still
    // equal the shipped defaults. This effect is declared before the lifecycle
    // effect so final configuration always reaches native before its first flush.
  }, [dispatchFlag, flagsResolved, sampleRateFlag]);

  useEffect(() => {
    if (!flagsResolved) return;

    let previousAppState = AppState.currentState;
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      const enteredForeground = nextAppState === 'active' && previousAppState !== 'active';
      previousAppState = nextAppState;
      if (enteredForeground) void dispatchObserveEvents();
    });
    if (previousAppState === 'active') void dispatchObserveEvents();

    return () => subscription.remove();
  }, [flagsResolved]);
}
