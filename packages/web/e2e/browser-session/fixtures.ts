import { CONSENT_COOKIE_NAME, CONSENT_VERSION, serializeConsentCookieValue } from '@boardsesh/consent';
import { test as base, expect } from '@playwright/test';
import { PARENT_DOMAIN, readStack } from './stack';

/**
 * Every context goes through the stack's proxy, which is the only way both
 * engines reach the `.test` hosts without a hosts file: Chromium and WebKit each
 * honour a per-context proxy, and neither resolves the name itself. The proxy's
 * certificate is self-signed, so the context ignores HTTPS errors; `Secure`
 * cookies are still stored and sent over it, which `cookie-domain.spec.ts`
 * checks in each engine (docs/better-auth-browser-session.md, "Browser-session
 * e2e harness").
 */
export const test = base.extend({
  context: async ({ browser }, use) => {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      proxy: { server: readStack().proxyServer },
    });
    // Analytics declined up front, so no consent banner sits over a form. A
    // Domain cookie on the parent, so every host under it sees the same answer.
    await context.addCookies([
      {
        name: CONSENT_COOKIE_NAME,
        value: serializeConsentCookieValue({
          analytics: 'denied',
          version: CONSENT_VERSION,
          source: 'web',
          decidedAt: new Date().toISOString(),
        }),
        domain: `.${PARENT_DOMAIN}`,
        path: '/',
        secure: true,
        sameSite: 'Lax',
      },
    ]);
    await use(context);
    await context.close();
  },
});

export { expect };
