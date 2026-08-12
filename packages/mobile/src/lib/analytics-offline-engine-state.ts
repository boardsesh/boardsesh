import type { PostHog } from 'posthog-react-native';
import { getPostHogClient } from './posthog-client';

/**
 * The `offline_engine_state` super property: HOW the offline engine got its
 * state this launch, stamped onto every subsequent event.
 *
 * - `flag-on` / `flag-off` — PostHog resolved `offline-board-downloads`.
 * - `default-on` — the flag never landed, so the #4312 bake decided it.
 * - `web-off` — Expo web, which has no offline engine regardless of the flag.
 *
 * It lives in its own module (rather than an inline `registerSuperProperties`
 * call in the bridge) because it has to survive `analytics.reset()`: PostHog's
 * reset clears every registered super property, and the state is registered
 * exactly once per launch from a flag effect that will not re-run. Remembering
 * the last value here is what lets `reset()` put it straight back — same reason
 * `connectivity` is re-registered (issue #4317). Without it, every event after
 * a sign-out, forced 401, or account switch would drop the property and the
 * bake measurement would end at the first logout of the launch.
 */
export type OfflineEngineState = 'flag-on' | 'flag-off' | 'default-on' | 'web-off';

export const OFFLINE_ENGINE_STATE_SUPER_PROPERTY = 'offline_engine_state';

let lastRegisteredState: OfflineEngineState | undefined;

function register(state: OfflineEngineState, client?: Pick<PostHog, 'register'> | null): void {
  const target = client ?? getPostHogClient();
  if (!target) return;
  try {
    void Promise.resolve(target.register({ [OFFLINE_ENGINE_STATE_SUPER_PROPERTY]: state })).catch((error: unknown) => {
      if (__DEV__) console.warn('[analytics] failed to register the offline engine state', error);
    });
  } catch (error) {
    if (__DEV__) console.warn('[analytics] failed to register the offline engine state', error);
  }
}

/**
 * Registers the state now and remembers it for the rest of the launch. Best
 * effort like `registerConnectivitySuperProperty`: a failure must never break
 * the caller, and it is a silent no-op when analytics is disabled (dev / no
 * key). The value is remembered even then, so a client that appears later
 * still gets it on the next re-registration.
 */
export function registerOfflineEngineState(state: OfflineEngineState): void {
  lastRegisteredState = state;
  register(state);
}

/**
 * Puts the remembered state back after `analytics.reset()` wiped it. No-op
 * before the flag effect has decided anything — there is nothing to restore,
 * and the effect's own registration is still coming.
 */
export function reregisterOfflineEngineState(client?: Pick<PostHog, 'register'> | null): void {
  if (lastRegisteredState === undefined) return;
  register(lastRegisteredState, client);
}

export function __resetOfflineEngineStateForTests(): void {
  lastRegisteredState = undefined;
}
