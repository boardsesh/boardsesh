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
