import { useEffect } from 'react';
import { setOutageDetectionEnabled } from '../lib/connectivity/connectivity-store';
import { setInteractiveRequestDeadlineEnabled } from '../lib/graphql/request-timeout';
import {
  useBackendOutageDetectionEnabled,
  useInteractiveRequestDeadlineEnabled,
} from '../providers/feature-flags-provider';

/**
 * Publishes the `backend-outage-detection` kill switch into the connectivity
 * store (issue #4862), which is a module-level singleton that non-React code —
 * the GraphQL client, the auth interceptor, the offline adapter — reads
 * directly and therefore cannot see a React context.
 *
 * MOUNT REQUIREMENT: this must sit at the app root, next to
 * `OfflineEngineFlagSync` in `app/_layout.tsx`, and inside `FeatureFlagsProvider`.
 * Mounted anywhere conditional (a screen, a tab) the flag would only reach the
 * store while that screen happened to be alive, and flipping the kill switch
 * during an outage would do nothing for a climber sitting on a different tab.
 *
 * The flag resolves asynchronously, so this effect runs at least twice on a cold
 * open — once with the default (enabled) and again if PostHog says otherwise.
 * That is the intended shape: `setDetectionEnabled(false)` resets the backend to
 * `unknown` and cancels the probe ladder, so a late kill switch fully undoes
 * whatever the store concluded before it arrived.
 *
 * Renders nothing.
 */
export function ConnectivityBridge() {
  const detectionEnabled = useBackendOutageDetectionEnabled();
  const deadlineEnabled = useInteractiveRequestDeadlineEnabled();

  useEffect(() => {
    setOutageDetectionEnabled(detectionEnabled);
  }, [detectionEnabled]);

  // Same shape for the 20 s interactive deadline: a separate switch, because a
  // device on a marginal link can legitimately outlast the deadline while the
  // server is healthy, and that escape hatch must not also disable detection.
  useEffect(() => {
    setInteractiveRequestDeadlineEnabled(deadlineEnabled);
  }, [deadlineEnabled]);

  return null;
}
