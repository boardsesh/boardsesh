// Pure in-memory slot for the party-profile UUID, resolved synchronously and
// early by analytics-bootstrap.ts (imported once, from app/_layout.tsx, before
// anything that triggers posthog-client.ts's own module-eval side effect).
// posthog-client.ts reads this slot when constructing the PostHog client, so
// the SDK's app-lifecycle autocapture (Application Installed/Opened) can
// bootstrap its anonymous distinct_id to the same stable id
// PartyProfileProvider later identifies the authenticated user from.
//
// Deliberately dependency-free (no expo-secure-store, no react-native) so
// importing it from posthog-client.ts/analytics.ts doesn't pull the RN
// Flow-syntax barrel into their module graph — those two stay importable from
// the node-env test runner, which analytics-bootstrap.ts (and the
// expo-secure-store read it performs) is not.
let bootstrapDistinctId: string | null = null;

export function setAnalyticsBootstrapId(id: string | null): void {
  bootstrapDistinctId = id;
}

export function getAnalyticsBootstrapId(): string | null {
  return bootstrapDistinctId;
}
