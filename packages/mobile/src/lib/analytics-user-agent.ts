import { MOBILE_USER_AGENT } from './mobile-user-agent';

// The `$raw_user_agent` super property PostHog classifies bots from. Native
// builds send the static app constant: the RN SDK has no browser UA to offer.
// The Expo browser app resolves analytics-user-agent.web.ts instead, which
// sends the real browser UA so crawlers rendering /app are classed as bots.
// Returns null only in the .web fork (a browser with no UA); the signature
// matches so posthog-client.ts compiles against either.
export function resolveAnalyticsUserAgent(): string | null {
  return MOBILE_USER_AGENT;
}
