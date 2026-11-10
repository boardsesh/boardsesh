import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import * as oauth from 'oauth4webapi';
import { CONSENT_COOKIE_NAME, CONSENT_VERSION, serializeConsentCookieValue } from '@boardsesh/consent';
import { CREATE_OAUTH_CLIENT, SAVE_TICK } from '@boardsesh/graphql/operations';
import { edgeFetch } from './edge';
import {
  API_HOST,
  E2E_DEVELOPER_TERMS_VERSION,
  GRAPHQL_URL,
  ISSUER,
  RESOURCE,
  WS_HOST,
  WWW_HOST,
  WWW_ORIGIN,
  readStack,
  type PartnerOAuthStack,
  type SeededAccount,
} from './stack';

/**
 * One partner app's whole life with one climber, end to end, on the real www
 * pages and the real backend (#6981 F18):
 *
 * 1. A developer signs in on www and registers a public native app through the
 *    console's GraphQL operation, with a publisher name and the current
 *    developer terms accepted.
 * 2. The app sends the climber's browser to authorize. The climber signs in on
 *    the www sign-in page and presses Allow on the www consent page.
 * 3. The app checks `state` and `iss`, and exchanges the code with PKCE and
 *    `resource=https://api.boardsesh.com/v1`.
 * 4. The app reads `/v1/me`, bootstraps the logbook snapshot (which holds a tick
 *    from long before the connection), then sees a tick the climber logs
 *    afterwards on `/v1/logbook/changes` and `/v1/logbook/ticks/{id}`.
 * 5. The app refreshes; the rotated pair works.
 * 6. The climber disconnects the app in Connected apps on www settings, and
 *    the app's next call gets 401 and its refresh `invalid_grant`.
 *
 * The app is oauth4webapi, an OAuth client nobody here wrote. Its server reaches
 * the edge over TLS with the edge's certificate; the climber's browser reaches
 * it through the proxy. Nothing is mocked between them and the two servers.
 */

const APP_NAME = 'Crimp Notes';
const PUBLISHER_NAME = 'Fingerboard Labs';
const SCOPES = 'profile:read logbook:read offline_access';
/** Registered without a port: loopback redirects match on any port (RFC 8252 section 7.3). */
const REGISTERED_REDIRECT = 'http://127.0.0.1/callback';

interface LogbookPage {
  changes: Array<{
    type: string;
    id?: string;
    tick?: { id: string; status: string; comment: string | null; climb: { name: string | null } };
  }>;
  cursor: string;
  hasMore: boolean;
}

function contextOptions(stack: PartnerOAuthStack) {
  return {
    ...devices['Desktop Chrome'],
    ignoreHTTPSErrors: true,
    // Loopback stays direct: that is where the app's redirect lands.
    proxy: { server: stack.proxyServer, bypass: '127.0.0.1,localhost' },
  };
}

async function newVisitor(
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
async function firstPartyToken(page: Page): Promise<string> {
  const body = await page.evaluate(async () => {
    const response = await fetch('/api/internal/ws-auth', { cache: 'no-store' });
    return (await response.json()) as { token: string | null; authenticated: boolean };
  });
  expect(body.authenticated).toBe(true);
  if (!body.token) throw new Error('www returned no token for a signed-in session.');
  return body.token;
}

/** GraphQL from a www page to ws.boardsesh.com, the way the console and the logbook call it. */
async function graphqlFromWww(page: Page, token: string, query: string, variables: Record<string, unknown>) {
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

async function signInOnLoginPage(page: Page, account: SeededAccount): Promise<void> {
  // A cheap landing page: the consent page without a signed link only shows a card.
  await page.goto(`${WWW_ORIGIN}/auth/login?callbackUrl=${encodeURIComponent('/oauth/consent')}`);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForURL(`${WWW_ORIGIN}/oauth/consent`);
}

/** The app's loopback redirect: a one-shot local server, as a CLI tool would run. */
async function startLoopbackRedirect(): Promise<{ server: Server; redirectUri: string; callback: Promise<URL> }> {
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

test.describe.configure({ mode: 'serial' });

test('an app registers, connects a climber on www, syncs the logbook, refreshes and is disconnected', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const stack = readStack();
  const appFetch = edgeFetch(stack.appEdgePort, stack.certificatePem, [API_HOST, WS_HOST, WWW_HOST]);
  const viaEdge = { [oauth.customFetch]: appFetch };

  // ---------------------------------------------------------------------
  // 1. The developer registers the app through the console's GraphQL.
  // ---------------------------------------------------------------------
  const developer = await newVisitor(browser, stack);
  await signInOnLoginPage(developer.page, stack.developer);
  const developerToken = await firstPartyToken(developer.page);
  const registration = await graphqlFromWww(developer.page, developerToken, CREATE_OAUTH_CLIENT, {
    input: {
      name: APP_NAME,
      publisherName: PUBLISHER_NAME,
      homepageUrl: 'https://crimp-notes.example/',
      privacyPolicyUrl: 'https://crimp-notes.example/privacy',
      applicationType: 'NATIVE',
      tokenEndpointAuthMethod: 'NONE',
      redirectUris: [REGISTERED_REDIRECT],
      // What the console sends once the developer ticks the terms box, for the
      // version this backend publishes.
      acceptedTermsVersion: E2E_DEVELOPER_TERMS_VERSION,
    },
  });
  expect(registration.body.errors).toBeUndefined();
  const created = registration.body.data?.createOAuthClient as {
    clientSecret: string | null;
    client: { clientId: string; publisherName: string | null; redirectUris: string[] };
  };
  // A public app gets no secret; PKCE protects its code.
  expect(created.clientSecret).toBeNull();
  expect(created.client.publisherName).toBe(PUBLISHER_NAME);
  expect(created.client.redirectUris).toEqual([REGISTERED_REDIRECT]);
  await developer.context.close();

  const client: oauth.Client = { client_id: created.client.clientId };
  const clientAuth = oauth.None();

  // ---------------------------------------------------------------------
  // 2. The app discovers the server and sends the climber to authorize.
  // ---------------------------------------------------------------------
  const issuer = new URL(ISSUER);
  const authorizationServer = await oauth.processDiscoveryResponse(
    issuer,
    await oauth.discoveryRequest(issuer, { algorithm: 'oauth2', ...viaEdge }),
  );
  expect(authorizationServer.issuer).toBe(ISSUER);
  // RFC 9207: the server promises `iss` on every authorization response, so the
  // app can, and oauth4webapi then must, check it below.
  expect(authorizationServer.authorization_response_iss_parameter_supported).toBe(true);

  const loopback = await startLoopbackRedirect();
  try {
    const verifier = oauth.generateRandomCodeVerifier();
    const state = oauth.generateRandomState();
    const authorizeUrl = new URL(authorizationServer.authorization_endpoint ?? '');
    authorizeUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: loopback.redirectUri,
      scope: SCOPES,
      state,
      code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      resource: RESOURCE,
    }).toString();

    // -------------------------------------------------------------------
    // 3. The climber signs in on www and approves on the consent page.
    // -------------------------------------------------------------------
    const climber = await newVisitor(browser, stack);
    await climber.page.goto(authorizeUrl.toString());
    await climber.page.waitForURL((url) => url.origin === WWW_ORIGIN && url.pathname === '/oauth/sign-in');
    await expect(climber.page.getByRole('heading', { name: 'Sign in to connect an app' })).toBeVisible();
    await climber.page.getByLabel('Email').fill(stack.climber.email);
    await climber.page.getByLabel('Password').fill(stack.climber.password);
    await climber.page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // Back through authorize, now with a fresh www session, onto the consent screen.
    await climber.page.waitForURL((url) => url.origin === WWW_ORIGIN && url.pathname === '/oauth/consent', {
      timeout: 60_000,
    });
    await expect(
      climber.page.getByRole('heading', { name: `Connect ${APP_NAME} to your Boardsesh account?` }),
    ).toBeVisible();
    await expect(climber.page.getByText(`Made by ${PUBLISHER_NAME}`)).toBeVisible();
    await expect(climber.page.getByText('See every tick in your logbook, on every board')).toBeVisible();
    await expect(climber.page.getByText('See your display name and profile photo')).toBeVisible();
    await expect(
      climber.page.getByText("Boardsesh hasn't reviewed this app. Only connect apps you trust."),
    ).toBeVisible();
    await climber.page.getByRole('button', { name: 'Allow', exact: true }).click();

    const callbackUrl = await loopback.callback;
    await climber.page.waitForURL((url) => url.hostname === '127.0.0.1');

    // -------------------------------------------------------------------
    // 4. The app checks the response and exchanges the code.
    // -------------------------------------------------------------------
    // Checks `state`, and that `iss` is this issuer (RFC 9207).
    const callbackParameters = oauth.validateAuthResponse(authorizationServer, client, callbackUrl, state);
    const exchanged = await oauth.processAuthorizationCodeResponse(
      authorizationServer,
      client,
      await oauth.authorizationCodeGrantRequest(
        authorizationServer,
        client,
        clientAuth,
        callbackParameters,
        loopback.redirectUri,
        verifier,
        { additionalParameters: { resource: RESOURCE }, ...viaEdge },
      ),
    );
    expect(exchanged.token_type.toLowerCase()).toBe('bearer');
    expect(exchanged.refresh_token).toBeTruthy();
    expect((exchanged.scope ?? '').split(' ').sort()).toEqual(SCOPES.split(' ').sort());
    let accessToken = exchanged.access_token;
    let refreshToken = exchanged.refresh_token as string;

    const callApi = async (path: string, token = accessToken, method = 'GET') =>
      appFetch(new URL(`${RESOURCE.replace(/\/v1$/, '')}${path}`), {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });

    // -------------------------------------------------------------------
    // 5. Who is connected.
    // -------------------------------------------------------------------
    const me = await callApi('/v1/me');
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { id: string; displayName: string | null };
    expect(meBody.id).toMatch(/^usr_[A-Za-z0-9]+$/);
    // The app's own id for the climber, never the Boardsesh account id.
    expect(meBody.id).not.toContain(stack.climber.userId);
    expect(meBody.displayName).toBe(stack.climber.name);

    // -------------------------------------------------------------------
    // 6. Bootstrap: a complete snapshot, then catch-up, until hasMore is false.
    // -------------------------------------------------------------------
    const readChanges = async (cursor?: string): Promise<LogbookPage> => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const query = new URLSearchParams({ limit: '100' });
        if (cursor) query.set('cursor', cursor);
        const response = await callApi(`/v1/logbook/changes?${query}`);
        if (response.status === 200) return (await response.json()) as LogbookPage;
        // A snapshot being built answers 503 with Retry-After; a real client waits.
        if (response.status === 503) {
          const waitSeconds = Math.min(Number(response.headers.get('retry-after')) || 1, 2);
          await new Promise((done) => setTimeout(done, waitSeconds * 1000));
          continue;
        }
        throw new Error(`/v1/logbook/changes answered ${response.status}: ${await response.text()}`);
      }
      throw new Error('/v1/logbook/changes stayed unavailable.');
    };

    const mirror = new Map<string, NonNullable<LogbookPage['changes'][number]['tick']>>();
    const apply = (page: LogbookPage) => {
      for (const change of page.changes) {
        if (change.type === 'tick' && change.tick) mirror.set(change.tick.id, change.tick);
        if (change.type === 'tick.deleted' && change.id) mirror.delete(change.id);
      }
    };
    let snapshotPage = await readChanges();
    apply(snapshotPage);
    for (let pages = 1; snapshotPage.hasMore; pages += 1) {
      if (pages > 50) throw new Error('The bootstrap never finished.');
      snapshotPage = await readChanges(snapshotPage.cursor);
      apply(snapshotPage);
    }
    let cursor = snapshotPage.cursor;
    // The climber's whole logbook is one tick from 400 days ago, before this app existed.
    expect([...mirror.keys()]).toEqual([stack.historyTickId]);
    expect(mirror.get(stack.historyTickId)).toMatchObject({
      status: 'send',
      comment: 'Logged long before the app existed',
      climb: { name: stack.climb.name },
    });

    // -------------------------------------------------------------------
    // 7. The climber logs a tick in Boardsesh; the app's next sync has it.
    // -------------------------------------------------------------------
    // The climber's tab is on the app's loopback page now; back to www, still signed in.
    await climber.page.goto(`${WWW_ORIGIN}/oauth/consent`);
    const climberToken = await firstPartyToken(climber.page);
    const saved = await graphqlFromWww(climber.page, climberToken, SAVE_TICK, {
      input: {
        boardType: stack.climb.boardType,
        climbUuid: stack.climb.uuid,
        layoutId: stack.climb.layoutId,
        angle: 40,
        isMirror: false,
        status: 'flash',
        attemptCount: 1,
        quality: 5,
        isBenchmark: false,
        comment: 'Flashed it after the app connected',
        climbedAt: new Date().toISOString(),
      },
    });
    expect(saved.body.errors).toBeUndefined();
    const savedTick = saved.body.data?.saveTick as { uuid: string } | undefined;
    if (!savedTick) throw new Error('saveTick returned no tick.');
    const newTickId = savedTick.uuid;

    // The feed serves a change once every write that started before it has
    // finished: usually within a second. Poll as an app syncing on open would.
    await expect
      .poll(
        async () => {
          let page: LogbookPage;
          do {
            page = await readChanges(cursor);
            apply(page);
            cursor = page.cursor;
          } while (page.hasMore);
          return mirror.has(newTickId);
        },
        { timeout: 20_000, intervals: [250, 500, 1_000] },
      )
      .toBe(true);
    expect(mirror.get(newTickId)).toMatchObject({
      status: 'flash',
      comment: 'Flashed it after the app connected',
      climb: { name: stack.climb.name },
    });
    const single = await callApi(`/v1/logbook/ticks/${encodeURIComponent(newTickId)}`);
    expect(single.status).toBe(200);
    expect(await single.json()).toMatchObject({ id: newTickId, status: 'flash' });

    // -------------------------------------------------------------------
    // 8. Refresh: a new pair, and the new access token works.
    // -------------------------------------------------------------------
    const refreshed = await oauth.processRefreshTokenResponse(
      authorizationServer,
      client,
      await oauth.refreshTokenGrantRequest(authorizationServer, client, clientAuth, refreshToken, {
        additionalParameters: { resource: RESOURCE },
        ...viaEdge,
      }),
    );
    expect(refreshed.refresh_token).toBeTruthy();
    expect(refreshed.refresh_token).not.toBe(refreshToken);
    expect(refreshed.access_token).not.toBe(accessToken);
    accessToken = refreshed.access_token;
    refreshToken = refreshed.refresh_token as string;
    expect((await callApi('/v1/me')).status).toBe(200);

    // -------------------------------------------------------------------
    // 9. The climber disconnects in Connected apps on www; the app's next
    //    call is refused.
    // -------------------------------------------------------------------
    await climber.page.goto(`${WWW_ORIGIN}/settings`);
    const connectedApps = climber.page.getByRole('region', { name: 'Connected apps' });
    // The row the www settings page shows for this app; it opens the app's detail.
    await connectedApps.getByRole('button', { name: new RegExp(APP_NAME) }).click();
    const detail = climber.page.getByRole('dialog', { name: APP_NAME });
    await expect(detail.getByText(`What ${APP_NAME} can see`)).toBeVisible();
    await expect(detail.getByText('Sees every tick in your logbook, on every board')).toBeVisible();
    await detail.getByRole('button', { name: `Disconnect ${APP_NAME}` }).click();
    // Through the console's `disconnectApp` mutation, with the climber's own session.
    const disconnectRequest = climber.page.waitForRequest(
      (request) => request.url() === GRAPHQL_URL && (request.postData() ?? '').includes('disconnectApp'),
    );
    const confirm = climber.page.getByRole('dialog', { name: `Disconnect ${APP_NAME}?` });
    await confirm.getByRole('button', { name: 'Disconnect', exact: true }).click();
    const disconnectResponse = await (await disconnectRequest).response();
    expect(disconnectResponse?.status()).toBe(200);
    expect(await disconnectResponse?.json()).toEqual({ data: { disconnectApp: true } });
    await expect(climber.page.getByText(`${APP_NAME} disconnected`)).toBeVisible();
    await expect(connectedApps.getByRole('button', { name: new RegExp(APP_NAME) })).toHaveCount(0);

    const afterDisconnect = await callApi('/v1/me');
    expect(afterDisconnect.status).toBe(401);
    expect(afterDisconnect.headers.get('www-authenticate') ?? '').toContain('error="invalid_token"');
    expect((await callApi(`/v1/logbook/changes?cursor=${encodeURIComponent(cursor)}`)).status).toBe(401);
    const refreshAfterDisconnect = await oauth.refreshTokenGrantRequest(
      authorizationServer,
      client,
      clientAuth,
      refreshToken,
      { additionalParameters: { resource: RESOURCE }, ...viaEdge },
    );
    await expect(
      oauth.processRefreshTokenResponse(authorizationServer, client, refreshAfterDisconnect),
    ).rejects.toMatchObject({ error: 'invalid_grant' });

    await climber.context.close();
  } finally {
    loopback.server.closeAllConnections();
    await new Promise<void>((done) => loopback.server.close(() => done()));
  }
});
