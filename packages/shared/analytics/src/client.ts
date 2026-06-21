// Minimal structural interface shared by both PostHog SDKs Boardsesh uses:
// posthog-js-lite (web) and posthog-react-native (mobile). Both extend the same
// `@posthog/core` base class, so this subset is satisfied by each platform's
// client without casts.
//
// It is declared locally (not imported from a posthog package) on purpose: this
// package stays dependency-free, neither platform SDK leaks into the other, and
// a future SDK bump on one platform can't silently change the shared contract —
// it would surface as a compile error where the real client is handed to
// createAnalytics().
export type AnalyticsPropertyValue = string | number | boolean | null;
export type AnalyticsProperties = Record<string, AnalyticsPropertyValue>;

export interface PostHogClient {
  capture(event: string, properties?: AnalyticsProperties): void;
  identify(distinctId: string, properties?: AnalyticsProperties): void;
  alias(alias: string): void;
  reset(): void;
  setPersonProperties(set?: AnalyticsProperties, setOnce?: AnalyticsProperties): void;
}
