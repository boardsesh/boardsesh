// Constants and types shared between client and server analytics modules so
// the wire format (header name, distinct id length cap) and event-property
// shape stays in sync across packages.

export const SERVER_DISTINCT_ID_HEADER = 'x-bs-distinct-id';
export const MAX_DISTINCT_ID_LENGTH = 256;

export type AnalyticsAllowedPropertyValue = string | number | boolean | null | undefined;
export type AnalyticsEventProperties = Record<string, AnalyticsAllowedPropertyValue>;
export type AnalyticsSanitizedProperties = Record<string, string | number | boolean | null>;
