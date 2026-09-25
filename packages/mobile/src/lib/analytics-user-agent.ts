import { MOBILE_USER_AGENT } from './mobile-user-agent';

// The `$raw_user_agent` super property PostHog classifies bots from. Native
// builds send the static app constant: the RN SDK has no browser UA to offer.
// The Expo browser app resolves analytics-user-agent.web.ts instead, which
// sends the real browser UA so crawlers rendering /app are classed as bots.
export function resolveAnalyticsUserAgent(): string {
  return MOBILE_USER_AGENT;
}
