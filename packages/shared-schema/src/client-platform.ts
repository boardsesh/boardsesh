/**
 * How a client tells the backend which platform it is, for the first-party
 * active-user count (`user_activity_days`, see docs/analytics-consent.md).
 *
 * HTTP requests send the header; graphql-ws connections send the connection
 * param in `connection_init`. A request with neither is counted as `unknown`.
 * The value is a coarse label for a statistic, never an authorisation input.
 */
export const CLIENT_PLATFORM_HEADER = 'x-boardsesh-platform';
export const CLIENT_PLATFORM_CONNECTION_PARAM = 'clientPlatform';

export const CLIENT_PLATFORMS = ['web', 'ios', 'android'] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];
