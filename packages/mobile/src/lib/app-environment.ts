/**
 * The resolved app "environment" for analytics / crash-reporting tags — shared by
 * Sentry (sentry.ts) and PostHog (posthog-client.ts) so both report the same
 * value for the same build, rather than each rolling its own resolution and
 * risking drift.
 *
 * Preview OTA bundles (the `pr-*` channels) are published with
 * EXPO_PUBLIC_SENTRY_ENVIRONMENT=preview (mobile-ota-preview.yml) — the value is
 * inlined into that JS bundle, so a tester who switches to a pr channel reports
 * `environment: preview` on both SDKs and their activity stays out of each
 * tool's production view. Store / production builds leave it unset and default
 * to 'production'.
 *
 * The env var is named EXPO_PUBLIC_SENTRY_ENVIRONMENT for historical reasons —
 * it was introduced for Sentry alone (#3808) before PostHog had the same gap
 * (#3814). It is now DELIBERATELY reused here rather than adding a second,
 * identical EXPO_PUBLIC_POSTHOG_ENVIRONMENT var and touching every mobile CI
 * workflow that publishes it (mobile-ota-preview.yml, mobile-ota-production.yml,
 * mobile-ota-check.yml, mobile-ota-backport.yml, android-apk-*.yml,
 * ios-testflight-rn.yml). Do not "clean this up" by renaming the var or
 * splitting it back into a per-SDK one — the two SDKs are meant to agree, and a
 * split reintroduces the risk of one being fixed and the other forgotten, which
 * is exactly how #3814 happened for PostHog after #3808 fixed Sentry.
 *
 * `environment` is init-only in both SDKs (no runtime setter), so it can't be
 * derived from Updates.channel after launch; the build-time env var is the
 * equivalent signal. Exported as a pure function so the resolution is
 * unit-testable independent of either SDK's enablement gate.
 */
export function resolveAppEnvironment(): string {
  return process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT || 'production';
}
