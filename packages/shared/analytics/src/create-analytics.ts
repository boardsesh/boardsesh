import type { AnalyticsPropertyValue, PostHogClient } from './client';
import { sanitizeForPosthog } from './sanitize';

// Properties as call sites pass them: optional fields may be `undefined` and are
// stripped by sanitizeForPosthog before reaching the SDK.
export type AnalyticsEventProperties = Record<string, AnalyticsPropertyValue | undefined>;

export type AnalyticsApi = {
  // Fire-and-forget event. Returns void to match the web call-site ergonomics
  // (the existing ~94 sites ignore the return). Skipped silently when gated.
  track(name: string, properties?: AnalyticsEventProperties): void;
  // The capture/identity methods return whether a client was present and the
  // call was forwarded — preserves the boolean contract the web wrapper exposes.
  capture(name: string, properties?: AnalyticsEventProperties): boolean;
  identify(distinctId: string, properties?: AnalyticsEventProperties): boolean;
  setPersonProperties(set?: AnalyticsEventProperties, setOnce?: AnalyticsEventProperties): boolean;
  alias(newId: string): boolean;
  reset(): boolean;
};

export type CreateAnalyticsOptions = {
  // Return true to drop the call entirely. Evaluated per call so it can react to
  // navigation/runtime state — web passes its admin-page check, mobile its
  // env/`__DEV__` gate. Omit to never skip.
  shouldSkip?: () => boolean;
  // Invoked before every track() with the raw (unsanitized) name + properties.
  // Platforms wire this to a dev-only console logger.
  onDebug?: (name: string, properties?: AnalyticsEventProperties) => void;
};

// Platform-neutral wrapper around a lazily-resolved PostHog client. Everything
// that is identical across web and mobile lives here: the skip gate, undefined
// stripping, the null-client guard, and the "did it send" boolean. Each platform
// supplies getClient() — its own gated, lazily-constructed SDK instance — and,
// optionally, a shouldSkip predicate and a debug hook.
export function createAnalytics(
  getClient: () => PostHogClient | null,
  options: CreateAnalyticsOptions = {},
): AnalyticsApi {
  const { shouldSkip, onDebug } = options;

  function resolveClient(): PostHogClient | null {
    if (shouldSkip?.()) return null;
    return getClient();
  }

  return {
    track(name, properties) {
      if (shouldSkip?.()) return;
      onDebug?.(name, properties);
      const client = getClient();
      if (!client) return;
      client.capture(name, sanitizeForPosthog(properties));
    },
    capture(name, properties) {
      const client = resolveClient();
      if (!client) return false;
      client.capture(name, sanitizeForPosthog(properties));
      return true;
    },
    identify(distinctId, properties) {
      const client = resolveClient();
      if (!client) return false;
      client.identify(distinctId, sanitizeForPosthog(properties));
      return true;
    },
    setPersonProperties(set, setOnce) {
      const client = resolveClient();
      if (!client) return false;
      client.setPersonProperties(sanitizeForPosthog(set), sanitizeForPosthog(setOnce));
      return true;
    },
    alias(newId) {
      const client = resolveClient();
      if (!client) return false;
      client.alias(newId);
      return true;
    },
    reset() {
      const client = resolveClient();
      if (!client) return false;
      client.reset();
      return true;
    },
  };
}
