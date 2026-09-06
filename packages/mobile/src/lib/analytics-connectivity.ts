import type { PostHog } from 'posthog-react-native';
import {
  getConnectivitySnapshot,
  subscribeConnectivity,
  type ConnectivityReason,
} from './connectivity/connectivity-store';
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
// Since #4862 it reads the connectivity store rather than React Query's
// `onlineManager`, which closes most of the under-count this comment used to
// warn about: a dead BACKEND on a healthy phone now stamps 'offline' instead of
// 'online', and so do a captive portal and a dead gym-wifi upstream once the
// probe has classified them. Two honest gaps remain, and both still point the
// same way — they under-count offline usage, never inflate it: a cold start
// stamps 'online' until NetInfo answers, and an outage stamps 'online' until the
// first request fails and the probe confirms it.
export type ConnectivityState = 'online' | 'offline';

export const CONNECTIVITY_SUPER_PROPERTY = 'connectivity';

// The companion property, and the reason the pair is worth carrying instead of
// one boolean: 'offline' alone cannot tell a climber in a tunnel from a climber
// whose app is fine and whose SERVER is down. Those are opposite findings — one
// is the product working as designed, the other is an outage — and every event
// captured during either carries this, so the split holds across the whole
// dataset rather than only the connectivity events.
export const OFFLINE_REASON_SUPER_PROPERTY = 'offline_reason';

export function currentConnectivityState(): ConnectivityState {
  return getConnectivitySnapshot().effectiveOffline ? 'offline' : 'online';
}

/** `null` whenever the app is online — an explicit clear, never a stale reason. */
export function currentOfflineReason(): ConnectivityReason | null {
  return getConnectivitySnapshot().reason;
}

// Registers the current connectivity as super properties. Pass the client when
// the caller already holds one (analytics.reset() does), otherwise it resolves
// the singleton. Both properties go in ONE register() call: each call is a
// persisted write, and a state registered without its reason (or the reverse)
// would put a self-contradicting pair on every event captured in between.
// Best-effort like registerMobileUserAgent / registerAppEnvironment in
// posthog-client.ts: a failure here must never break the calling path, and it is
// a silent no-op when analytics is disabled (dev / no key → null client).
export function registerConnectivitySuperProperty(client?: Pick<PostHog, 'register'> | null): void {
  const target = client ?? getPostHogClient();
  if (!target) return;
  try {
    const properties = {
      [CONNECTIVITY_SUPER_PROPERTY]: currentConnectivityState(),
      [OFFLINE_REASON_SUPER_PROPERTY]: currentOfflineReason(),
    };
    void Promise.resolve(target.register(properties)).catch((error: unknown) => {
      if (__DEV__) console.warn('[analytics] failed to register connectivity super property', error);
    });
  } catch (error) {
    if (__DEV__) console.warn('[analytics] failed to register connectivity super property', error);
  }
}

// Registers connectivity now and keeps it current for the rest of the launch.
// Re-registers only on an actual change to either property — the store notifies
// on every snapshot change, including ones neither property cares about (a probe
// starting, a failure counter ticking), and each register() is a persisted write.
// Returns the unsubscribe so the caller can tear the subscription down.
export function startConnectivityTracking(): () => void {
  let registeredState = currentConnectivityState();
  let registeredReason = currentOfflineReason();
  registerConnectivitySuperProperty();
  return subscribeConnectivity(() => {
    const nextState = currentConnectivityState();
    const nextReason = currentOfflineReason();
    if (nextState === registeredState && nextReason === registeredReason) return;
    registeredState = nextState;
    registeredReason = nextReason;
    registerConnectivitySuperProperty();
  });
}
