/**
 * Module-level mirror of the permanently enabled native offline engine, for the
 * non-React offline paths (the GraphQL read interceptor). The value is published
 * from React by `OfflineEngineFlagSync`; the Expo web fork publishes false.
 *
 * Defaults to `false` until the platform-specific root effect publishes. This
 * literal is NOT the platform decision — it is the value that
 * holds for the few microseconds before `OfflineEngineFlagSync`'s effect
 * publishes one. That component is the first child inside
 * `FeatureFlagsProvider` (`app/_layout.tsx`), so its effect flushes before any
 * screen's query effect and the window is effectively zero. Keeping the literal
 * here also keeps this module free of a `providers/` import, which is why it is
 * standalone in the first place.
 */

let offlineEngineEnabled = false;

export function setOfflineEngineEnabled(enabled: boolean): void {
  offlineEngineEnabled = enabled;
}

export function isOfflineEngineEnabled(): boolean {
  return offlineEngineEnabled;
}

export function __resetOfflineEngineForTests(): void {
  offlineEngineEnabled = false;
}
