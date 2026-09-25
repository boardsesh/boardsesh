// posthog-js caps the UA it sends at 1000 characters too (997 plus "...").
const MAX_RAW_USER_AGENT_LENGTH = 1000;

// The Expo browser app runs the RN PostHog SDK in a real browser. Sending the
// native constant here would stamp every visitor, crawlers included, with a
// non-bot UA, so PostHog's `$virt_is_bot` could never flag a crawler that
// renders /app (#5653). Send the browser's own UA. A browser that exposes none
// gets null, and the caller leaves `$raw_user_agent` unset so PostHog flags the
// event, the same as www (packages/web/app/lib/analytics.ts): a real browser
// always has a UA.
export function resolveAnalyticsUserAgent(): string | null {
  const browserUserAgent = typeof navigator === 'undefined' ? '' : (navigator.userAgent ?? '');
  return browserUserAgent ? browserUserAgent.slice(0, MAX_RAW_USER_AGENT_LENGTH) : null;
}
