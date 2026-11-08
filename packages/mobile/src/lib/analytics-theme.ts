import type { PostHog } from 'posthog-react-native';
import { getPostHogClient } from './posthog-client';

/**
 * The `color_scheme` and `ui_variant` super properties: what the app is
 * actually rendering (the resolved scheme after the in-app Appearance
 * override, and the resolved UI variant), stamped onto every event so any
 * metric can be split by light/dark and Liquid Glass/Material.
 *
 * Own module, same shape as `analytics-low-power-mode.ts`, because it has to
 * survive `analytics.reset()`: PostHog's reset clears every registered super
 * property, and the theme only changes when the climber changes it.
 */
export type ThemeSuperProperties = {
  color_scheme: 'light' | 'dark';
  ui_variant: 'liquidGlass' | 'material';
};

let lastRegistered: ThemeSuperProperties | undefined;

function register(properties: ThemeSuperProperties, client?: Pick<PostHog, 'register'> | null): void {
  const target = client ?? getPostHogClient();
  if (!target) return;
  try {
    void Promise.resolve(target.register({ ...properties })).catch((error: unknown) => {
      if (__DEV__) console.warn('[analytics] failed to register theme properties', error);
    });
  } catch (error) {
    if (__DEV__) console.warn('[analytics] failed to register theme properties', error);
  }
}

/**
 * Registers the resolved theme now and remembers it for the rest of the
 * launch. Best effort and a silent no-op when analytics is disabled. Skips the
 * write when neither value changed, since every `register()` is a persisted
 * write.
 */
export function registerThemeProperties(properties: ThemeSuperProperties): void {
  if (lastRegistered?.color_scheme === properties.color_scheme && lastRegistered.ui_variant === properties.ui_variant) {
    return;
  }
  lastRegistered = { ...properties };
  register(lastRegistered);
}

/** Puts the remembered values back after `analytics.reset()` wiped them. */
export function reregisterThemeProperties(client?: Pick<PostHog, 'register'> | null): void {
  if (lastRegistered === undefined) return;
  register(lastRegistered, client);
}

/** Test-only: forget the remembered values. */
export function _resetThemePropertiesForTests(): void {
  lastRegistered = undefined;
}
