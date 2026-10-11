/**
 * Request header a client sets on PostHog capture requests through the backend
 * proxy (`/api/posthog`), and only while the climber has a current "Allow".
 * The proxy forwards the visitor's IP to PostHog for GeoIP only when the header
 * carries {@link ANALYTICS_CONSENT_HEADER_GRANTED}. Without it (feature flags,
 * the anonymous OTA health event, kiosk telemetry, an older client) the proxy
 * strips the IP. A missing header can only lose location, never add it.
 */
export const ANALYTICS_CONSENT_HEADER = 'x-boardsesh-analytics-consent';
export const ANALYTICS_CONSENT_HEADER_GRANTED = 'granted';

/**
 * PostHog ingestion paths that carry events, relative to the PostHog host.
 * `@posthog/core` and posthog-react-native send everything, replay included,
 * through `/batch/`; the others are the SDKs' older single-event and replay
 * endpoints. Clients mark only these with {@link ANALYTICS_CONSENT_HEADER}, and
 * the proxy forwards the visitor IP only on these, so flags, the SDK config
 * request, surveys, logs and any endpoint PostHog adds later stay unmarked and
 * stripped by construction.
 */
export const ANALYTICS_CAPTURE_PATH = /^\/(batch|e|i\/v0\/e|s)\/?$/;

/**
 * True when an SDK request URL is a capture request: its path, after the
 * PostHog host's own path, is an {@link ANALYTICS_CAPTURE_PATH}.
 */
export function isAnalyticsCaptureUrl(url: string, host: string): boolean {
  try {
    const request = new URL(url);
    const base = new URL(host);
    if (request.origin !== base.origin) return false;
    const basePath = base.pathname.replace(/\/+$/, '');
    if (!request.pathname.startsWith(`${basePath}/`)) return false;
    return ANALYTICS_CAPTURE_PATH.test(request.pathname.slice(basePath.length));
  } catch {
    return false;
  }
}
