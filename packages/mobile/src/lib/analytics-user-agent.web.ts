import { MOBILE_USER_AGENT } from './mobile-user-agent';

// posthog-js does the same cap on the UA it sends.
const MAX_RAW_USER_AGENT_LENGTH = 1000;

// The Expo browser app runs the RN PostHog SDK in a real browser. Sending the
// native constant here would stamp every visitor, crawlers included, with a
// non-bot UA, so PostHog's `$virt_is_bot` could never flag a crawler that
// renders /app (#5653). Send the browser's own UA; fall back to the constant
// only when the browser exposes none, since an empty UA is itself read as a bot.
export function resolveAnalyticsUserAgent(): string {
  const browserUserAgent = typeof navigator === 'undefined' ? '' : (navigator.userAgent ?? '');
  return browserUserAgent ? browserUserAgent.slice(0, MAX_RAW_USER_AGENT_LENGTH) : MOBILE_USER_AGENT;
}
