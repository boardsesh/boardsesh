// Constants and types shared between client and server analytics modules so
// the wire format (header name, distinct id length cap) and event-property
// shape stays in sync across packages.

export const SERVER_DISTINCT_ID_HEADER = 'x-bs-distinct-id';
export const MAX_DISTINCT_ID_LENGTH = 256;

// Sentinel distinct id for OG image fetches. These come from preview bots
// (Slack, iMessage, Twitter) which we can't attribute to a real person, so
// every OG event collapses into one PostHog person to keep counts stable.
// Defined here rather than per-route so a typo in one OG handler can't
// silently fork into a second person.
export const OG_BOT_DISTINCT_ID = 'og-bot';

// The client always sends a crypto.randomUUID() (anonymous partyProfile.id) or
// the NextAuth user id, both of which are RFC 4122 UUIDs. Reject anything else
// so a malicious client can't inject arbitrary text into PostHog properties.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidDistinctId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= MAX_DISTINCT_ID_LENGTH && UUID_PATTERN.test(value)
  );
}

export type AnalyticsAllowedPropertyValue = string | number | boolean | null | undefined;
export type AnalyticsEventProperties = Record<string, AnalyticsAllowedPropertyValue>;
export type AnalyticsSanitizedProperties = Record<string, string | number | boolean | null>;
