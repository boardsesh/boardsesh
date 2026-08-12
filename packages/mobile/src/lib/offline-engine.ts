/**
 * Module-level mirror of the `offline-board-downloads` feature flag, for the
 * non-React offline paths (the GraphQL read interceptor) that can't call
 * `useFeatureFlag`. The value is published from React by `OfflineEngineFlagSync`
 * so the single flag decision — PostHog + env override + tester overrides —
 * happens in one place and this store never disagrees with the UI.
 *
 * Defaults to `false` even though the flag gate itself now defaults to ON
 * (issue #4312). This literal is NOT the flag decision — it is the value that
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
