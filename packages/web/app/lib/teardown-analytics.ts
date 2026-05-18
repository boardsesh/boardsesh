import { tearDownPostHog } from './analytics';

/**
 * Tear down all analytics clients when the user revokes analytics consent
 * mid-session. PostHog stops capturing and flushes pending events; Vercel
 * Analytics is already disabled reactively by the consent-aware
 * `<VercelAnalytics enabled>` prop in the layout so it needs no explicit
 * teardown here.
 *
 * Mirrors `tearDownErrorMonitoring()` for Sentry. The consent context's
 * granted→denied effect calls this so the user does not have to reload to
 * stop analytics traffic (GDPR Art. 7(3)).
 *
 * Best-effort: never throws. Safe to call even if PostHog was never
 * initialized.
 */
export async function tearDownAnalytics(): Promise<void> {
  await tearDownPostHog();
}
