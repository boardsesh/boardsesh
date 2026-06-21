import type { AnalyticsProperties, AnalyticsPropertyValue } from './client';

// Drop `undefined` values so PostHog never receives an explicit `undefined`
// property. Call sites routinely spread optional fields (`{ boardLayout, error }`)
// where one is undefined; without this they'd serialize as null and pollute the
// property's type in PostHog. Mirrors the web wrapper's original behaviour, now
// shared across platforms.
export function sanitizeForPosthog(
  properties?: Record<string, AnalyticsPropertyValue | undefined>,
): AnalyticsProperties | undefined {
  if (!properties) return undefined;
  const sanitized: AnalyticsProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) sanitized[key] = value;
  }
  return sanitized;
}
