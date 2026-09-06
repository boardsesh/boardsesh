import { useEffect, useRef } from 'react';
import { setOutageDetectionEnabled } from '../lib/connectivity/connectivity-store';
import { setInteractiveRequestDeadlineEnabled } from '../lib/graphql/request-timeout';
import { selectOfflineMode, useConnectivityField } from '../lib/connectivity/use-connectivity';
import { disposeWsClient } from '../lib/graphql/ws-client';
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
 * It also closes the realtime socket when a climber switches offline mode ON.
 * graphql-ws reconnects on its own schedule and knows nothing about the store,
 * so without this a phone in offline mode would keep dialling the party/comment
 * subscriptions forever — the one flavour of traffic "stop talking to the
 * server" would not actually stop. Nothing happens on the way back: the client is lazy,
 * so the next consumer that needs it builds a fresh one.
 *
 * The dispose is the CUT; the GATE lives one layer down. `disposeWsClient()`
 * only drops the cached client, so on its own the next `getWsClient()` would
 * open a fresh socket — which is what a cold launch with the mode restored, a
 * BLE auto-connect bind or the drawer host's active-board restore would do.
 * `ws-client-core` therefore hands out an INERT client while offline mode is on:
 * every operation fails locally with `BackendUnavailableError('offline_mode')`
 * and no socket is created. A new consumer that calls `getWsClient()` gets that
 * for free.
 *
 * Parking is still the polite behaviour, and the live consumers do it —
 * `use-session-realtime` defers its join and re-joins on the store edge,
 * `board-presence-provider` hands the shared hook a null client — because a
 * parked consumer produces no rejection noise and resumes with a catch-up
 * instead of a retry storm.
 *
 * Renders nothing.
 */
export function ConnectivityBridge() {
  const detectionEnabled = useBackendOutageDetectionEnabled();
  const deadlineEnabled = useInteractiveRequestDeadlineEnabled();
  // Narrowed to the one field: the full snapshot changes twice per probe rung,
  // and re-rendering a component that renders nothing on every tick is pure cost.
  const offlineMode = useConnectivityField(selectOfflineMode);
  // Seeded from the first render rather than `false`, so a launch that ALREADY
  // restored offline mode does not dispose a socket nobody has opened yet.
  const previousOfflineModeRef = useRef(offlineMode);

  useEffect(() => {
    setOutageDetectionEnabled(detectionEnabled);
  }, [detectionEnabled]);

  // Same shape for the 20 s interactive deadline: a separate switch, because a
  // device on a marginal link can legitimately outlast the deadline while the
  // server is healthy, and that escape hatch must not also disable detection.
  useEffect(() => {
    setInteractiveRequestDeadlineEnabled(deadlineEnabled);
  }, [deadlineEnabled]);

  useEffect(() => {
    const wasOfflineMode = previousOfflineModeRef.current;
    previousOfflineModeRef.current = offlineMode;
    if (offlineMode && !wasOfflineMode) disposeWsClient();
  }, [offlineMode]);

  return null;
}
