import { useEffect } from 'react';
import { useFeatureFlags } from '../providers/feature-flags-provider';
import { parseObserveSampleRate, resolveObserveDispatchEnabled } from '../lib/observe-config';
import { configureObserve } from '../lib/observe-runtime';

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
 */
export function useObserveRuntimeConfig(): void {
  const flags = useFeatureFlags();
  const dispatchFlag = flags['observe-dispatch-enabled'];
  const sampleRateFlag = flags['observe-sample-rate'];

  useEffect(() => {
    configureObserve({
      dispatchingEnabled: resolveObserveDispatchEnabled(dispatchFlag),
      sampleRate: parseObserveSampleRate(sampleRateFlag),
    });
  }, [dispatchFlag, sampleRateFlag]);
}
