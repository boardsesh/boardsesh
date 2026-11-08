import type { PostHog } from 'posthog-react-native';

type SuperPropertiesClearedListener = (client: PostHog) => void;

const listeners = new Set<SuperPropertiesClearedListener>();

/**
 * Runs `listener` every time the consent path calls `client.reset([])`, which
 * wipes every registered super property. `posthog-client.ts` puts back the two
 * it owns (app + connectivity); the launch-scoped ones (`low_power_mode`,
 * `color_scheme`, `ui_variant`, gym, offline engine state, connect-step arm)
 * live in modules that import `posthog-client`, so they subscribe here instead
 * of being imported by it. Without this a consent change mid-launch (flags
 * resolving on a fresh install, then the climber tapping Allow) left them off
 * every later event of the launch.
 *
 * Its own module so the 18 tests that replace `posthog-client` with a factory
 * mock don't each have to stub it.
 */
export function subscribeSuperPropertiesCleared(listener: SuperPropertiesClearedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifySuperPropertiesCleared(client: PostHog): void {
  for (const listener of listeners) listener(client);
}
