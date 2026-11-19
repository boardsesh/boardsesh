import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test';
import { CONSENT_COOKIE_NAME, CONSENT_VERSION, serializeConsentCookieValue } from '@boardsesh/consent';
import { GRAPHQL_URL, WWW_ORIGIN, type PartnerOAuthStack, type SeededAccount } from './stack';

function contextOptions(stack: PartnerOAuthStack) {
  return {
    ignoreHTTPSErrors: true,
    // Loopback stays direct: that is where the app's redirect lands.
    proxy: { server: stack.proxyServer, bypass: '127.0.0.1,localhost' },
  };
}

export async function newVisitor(
  browser: Browser,
  stack: PartnerOAuthStack,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(contextOptions(stack));
  // Analytics declined up front, as the main e2e suite does, so no banner sits over a form.
  await context.addCookies([
    {
      name: CONSENT_COOKIE_NAME,
      value: serializeConsentCookieValue({
        analytics: 'denied',
        version: CONSENT_VERSION,
        source: 'web',
        decidedAt: new Date().toISOString(),
      }),
      url: WWW_ORIGIN,
      sameSite: 'Lax',
    },
  ]);
  const page = await context.newPage();
  // A signed-in account with no analytics choice of its own is asked once, over
  // whatever page is open. Decline it the way a climber would.
  const consentPrompt = page.getByText('Help us improve Boardsesh?');
  await page.addLocatorHandler(consentPrompt, async () => {
    await page.getByRole('button', { name: 'No thanks', exact: true }).click();
    await expect(consentPrompt).toBeHidden();
  });
  return { context, page };
}

/** The first-party token www hands its own pages for GraphQL (`useWsAuthToken`). */
export async function firstPartyToken(page: Page): Promise<string> {
  const body = await page.evaluate(async () => {
    const response = await fetch('/api/internal/ws-auth', { cache: 'no-store' });
    return (await response.json()) as { token: string | null; authenticated: boolean };
  });
  expect(body.authenticated).toBe(true);
  if (!body.token) throw new Error('www returned no token for a signed-in session.');
  return body.token;
}

/** GraphQL from a www page to ws.boardsesh.com, the way the console and the logbook call it. */
export async function graphqlFromWww(page: Page, token: string, query: string, variables: Record<string, unknown>) {
  return page.evaluate(
    async ({ url, bearer, document, input }) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ query: document, variables: input }),
      });
      return {
        status: response.status,
        body: (await response.json()) as { data?: Record<string, unknown>; errors?: Array<{ message: string }> },
      };
    },
    { url: GRAPHQL_URL, bearer: token, document: query, input: variables },
  );
}

/** Wait for the sign-in component's mount effect before submitting its SSR form. */
export async function visitWithSignInReady(page: Page, url: string): Promise<void> {
  let formMounted = false;
  const observeMount = (request: Request) => {
    // SocialLoginButtons is a child of both sign-in forms. Its effect runs
    // after hydration attaches their submit handlers; no fixed delay is needed.
    if (request.url() === `${WWW_ORIGIN}/api/auth/providers-config`) formMounted = true;
  };
  page.on('request', observeMount);
  try {
    await page.goto(url);
    if (['/auth/login', '/oauth/sign-in'].includes(new URL(page.url()).pathname)) {
      await expect.poll(() => formMounted, { message: 'The sign-in form has hydrated' }).toBe(true);
    }
  } finally {
    page.off('request', observeMount);
  }
}

export async function signInOnLoginPage(page: Page, account: SeededAccount): Promise<void> {
  // A cheap landing page: the consent page without a signed link only shows a card.
  await visitWithSignInReady(page, `${WWW_ORIGIN}/auth/login?callbackUrl=${encodeURIComponent('/oauth/consent')}`);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${WWW_ORIGIN}/oauth/consent`);
}

/** The app's loopback redirect: a one-shot local server, as a CLI tool would run. */
export async function startLoopbackRedirect(): Promise<{
  server: Server;
  redirectUri: string;
  callback: Promise<URL>;
}> {
  let deliver: (url: URL) => void = () => undefined;
  const callback = new Promise<URL>((resolve) => {
    deliver = resolve;
  });
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? '/', `http://${incoming.headers.host}`);
    if (url.pathname !== '/callback') {
      outgoing.writeHead(404);
      outgoing.end();
      return;
    }
    outgoing.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    outgoing.end('<!doctype html><title>Crimp Notes</title><p>Connected. You can close this window.</p>');
    deliver(url);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { server, redirectUri: `http://127.0.0.1:${port}/callback`, callback };
}
