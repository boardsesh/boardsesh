/**
 * Tear down the Sentry client when the user revokes error-monitoring
 * consent mid-session. `Sentry.init` is gated at page-load time only, so
 * without an explicit teardown a previously-initialized client keeps
 * collecting until the next reload — long enough to be a GDPR Art. 7(3)
 * issue ("data collection must stop promptly on revocation").
 *
 * Dynamic-imports `@sentry/nextjs` so this module doesn't pull Sentry
 * into bundles where consent is never granted. If Sentry was never
 * initialized this is a no-op (`getClient()` returns undefined).
 */
export async function tearDownErrorMonitoring(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const Sentry = await import('@sentry/nextjs');
    const client = Sentry.getClient();
    if (!client) return;
    // close() flushes pending events with a short timeout then disables
    // the client. After this returns, captureException is a no-op until
    // a fresh init runs (which only happens on next page load).
    await client.close(2000);
  } catch (error) {
    // Best-effort — never block the consent UI on telemetry teardown.
    console.warn('[consent] failed to tear down Sentry:', error);
  }
}
