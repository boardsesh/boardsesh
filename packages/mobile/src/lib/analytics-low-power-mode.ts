import type { PostHog } from 'posthog-react-native';
import { getPostHogClient } from './posthog-client';

/**
 * The `low_power_mode` super property: whether the phone was in iOS Low Power
 * Mode / Android Battery Saver when an event fired, stamped onto every event.
 *
 * Added for issue #5187, where holds drew seconds late only in Low Power Mode
 * and nothing in the data could say which sessions were in it. With this on
 * every event, `Board Render Failed` (and anything else) can be split by it.
 *
 * Own module, same shape as `analytics-offline-engine-state.ts`, because it
 * has to survive `analytics.reset()`: PostHog's reset clears every registered
 * super property, and the mode only changes on a power-state transition, so a
 * sign-out would otherwise drop it for the rest of the launch.
 */
export const LOW_POWER_MODE_SUPER_PROPERTY = 'low_power_mode';

let lastRegisteredValue: boolean | undefined;

function register(lowPowerMode: boolean, client?: Pick<PostHog, 'register'> | null): void {
  const target = client ?? getPostHogClient();
  if (!target) return;
  try {
    void Promise.resolve(target.register({ [LOW_POWER_MODE_SUPER_PROPERTY]: lowPowerMode })).catch((error: unknown) => {
      if (__DEV__) console.warn('[analytics] failed to register low power mode', error);
    });
  } catch (error) {
    if (__DEV__) console.warn('[analytics] failed to register low power mode', error);
  }
}

/**
 * Registers the value now and remembers it for the rest of the launch. Best
 * effort: a failure never breaks the caller, and it is a silent no-op when
 * analytics is disabled. Skips the write when the value has not changed, since
 * every `register()` is a persisted write.
 */
export function registerLowPowerMode(lowPowerMode: boolean): void {
  if (lastRegisteredValue === lowPowerMode) return;
  lastRegisteredValue = lowPowerMode;
  register(lowPowerMode);
}

/**
 * Puts the remembered value back after `analytics.reset()` wiped it. No-op
 * before the tracker has published anything.
 */
export function reregisterLowPowerMode(client?: Pick<PostHog, 'register'> | null): void {
  if (lastRegisteredValue === undefined) return;
  register(lastRegisteredValue, client);
}

/** Test-only: forget the remembered value. */
export function _resetLowPowerModeForTests(): void {
  lastRegisteredValue = undefined;
}
