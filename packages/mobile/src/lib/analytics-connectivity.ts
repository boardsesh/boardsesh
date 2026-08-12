import { onlineManager } from '@tanstack/react-query';
import type { PostHog } from 'posthog-react-native';
import { getPostHogClient } from './posthog-client';

// The `connectivity` super property: 'online' | 'offline', stamped onto every
// event this client sends until it is re-registered. It exists because nothing
// in the app's telemetry said whether the network was usable at capture time —
// so "does anyone actually use Boardsesh away from signal?" (the whole point of
// offline mode, issue #4317) was unanswerable from any existing event.
//
// PostHog resolves super properties at CAPTURE time, not at flush time, and the
// RN SDK persists its queue to disk ('file' persistence) and deliberately does
// NOT dequeue a batch that failed with a network error (@posthog/core's
// `_flushRoute` only persists the dequeue when the failure is not a
// PostHogFetchNetworkError). So events captured while offline survive an app
// kill, flush on reconnect, and still carry `connectivity: 'offline'` — which is
// what makes this property worth registering rather than derivable server-side.
//
// Best-known connectivity, NOT ground truth: it mirrors React Query's
// `onlineManager`, which the app seeds from NetInfo asynchronously and which
// defaults to online (query-provider.tsx), and which tracks `isConnected` rather
// than `isInternetReachable`. A genuinely-offline cold start can therefore stamp
// its first events 'online', and a captive portal / dead gym-wifi upstream reads
// 'online' throughout. Both errors point the same way — they under-count offline
// usage — so a number derived from this property is a floor, never an inflation.
export type ConnectivityState = 'online' | 'offline';

export const CONNECTIVITY_SUPER_PROPERTY = 'connectivity';

export function currentConnectivityState(): ConnectivityState {
  return onlineManager.isOnline() ? 'online' : 'offline';
}

// Registers the current connectivity as a super property. Pass the client when
// the caller already holds one (analytics.reset() does), otherwise it resolves
// the singleton. Best-effort like registerMobileUserAgent / registerAppEnvironment
// in posthog-client.ts: a failure here must never break the calling path, and it
// is a silent no-op when analytics is disabled (dev / no key → null client).
export function registerConnectivitySuperProperty(client?: Pick<PostHog, 'register'> | null): void {
  const target = client ?? getPostHogClient();
  if (!target) return;
  try {
    void Promise.resolve(target.register({ [CONNECTIVITY_SUPER_PROPERTY]: currentConnectivityState() })).catch(
      (error: unknown) => {
        if (__DEV__) console.warn('[analytics] failed to register connectivity super property', error);
      },
    );
  } catch (error) {
    if (__DEV__) console.warn('[analytics] failed to register connectivity super property', error);
  }
}

// Registers connectivity now and keeps it current for the rest of the launch.
// Re-registers only on an actual online↔offline transition — `onlineManager`
// notifies its subscribers on every setOnline call, including same-value ones
// from NetInfo's chatty change stream, and each register() is a persisted write.
// Returns the unsubscribe so the caller can tear the subscription down.
export function startConnectivityTracking(): () => void {
  let registeredState = currentConnectivityState();
  registerConnectivitySuperProperty();
  return onlineManager.subscribe(() => {
    const nextState = currentConnectivityState();
    if (nextState === registeredState) return;
    registeredState = nextState;
    registerConnectivitySuperProperty();
  });
}
