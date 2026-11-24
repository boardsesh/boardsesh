import { expect, test, type Browser, type Page, type Route } from '@playwright/test';
import * as oauth from 'oauth4webapi';
import { CREATE_OAUTH_CLIENT, DELETE_OAUTH_CLIENT } from '@boardsesh/graphql/operations';
import { edgeFetch } from './edge';
import {
  firstPartyToken,
  graphqlFromWww,
  newVisitor,
  signInOnLoginPage,
  startLoopbackRedirect,
  visitWithSignInReady,
} from './helpers';
import {
  API_HOST,
  CONFIDENTIAL_APP_ORIGIN,
  E2E_DEVELOPER_TERMS_VERSION,
  ISSUER,
  PUBLIC_APP_ORIGIN,
  RESOURCE,
  UNREGISTERED_APP_ORIGIN,
  WS_HOST,
  WWW_HOST,
  WWW_ORIGIN,
  readStack,
  type PartnerOAuthStack,
  type PartnerScenario,
} from './stack';

type ApplicationType = 'WEB' | 'NATIVE';
type ClientAuthentication = 'NONE' | 'CLIENT_SECRET_BASIC';
type JsonObject = Record<string, unknown>;
interface RegisteredClient {
  clientSecret: string | null;
  client: { clientId: string; redirectUris: string[] };
}
interface ClientFixture {
  stack: PartnerOAuthStack;
  developer: Page;
  climber: Page;
  registered: RegisteredClient;
  server: oauth.AuthorizationServer;
  client: oauth.Client;
  appFetch: ReturnType<typeof edgeFetch>;
}
const SCOPES = 'profile:read offline_access';

function tokenPair(body: { access_token?: unknown; refresh_token?: unknown } | null) {
  const accessToken = body?.access_token;
  const refreshToken = body?.refresh_token;
  expect(typeof accessToken).toBe('string');
  expect(typeof refreshToken).toBe('string');
  if (typeof accessToken !== 'string' || !accessToken || typeof refreshToken !== 'string' || !refreshToken)
    throw new Error('The token endpoint returned no usable token pair.');
  return { accessToken, refreshToken };
}

/** Preserve every part of the registered redirect except its OAuth response parameters. */
function callbackTarget(callback: URL) {
  const target = new URL(callback);
  for (const parameter of ['code', 'state', 'iss', 'error', 'error_description']) target.searchParams.delete(parameter);
  return target.toString();
}

async function createClient(
  developer: Page,
  applicationType: ApplicationType,
  authentication: ClientAuthentication,
  redirectUri: string,
) {
  const token = await firstPartyToken(developer);
  return graphqlFromWww(developer, token, CREATE_OAUTH_CLIENT, {
    input: {
      name: 'Partner qualification',
      publisherName: 'Local test developer',
      homepageUrl: 'https://partner.example/',
      privacyPolicyUrl: 'https://partner.example/privacy',
      applicationType,
      tokenEndpointAuthMethod: authentication,
      redirectUris: [redirectUri],
      acceptedTermsVersion: E2E_DEVELOPER_TERMS_VERSION,
    },
  });
}

async function withClient(
  browser: Browser,
  scenario: PartnerScenario,
  applicationType: ApplicationType,
  authentication: ClientAuthentication,
  redirectUri: string,
  run: (fixture: ClientFixture) => Promise<void>,
) {
  const stack = readStack(browser.browserType().name(), scenario);
  const developer = await newVisitor(browser, stack);
  const climber = await newVisitor(browser, stack);
  let registered: RegisteredClient | undefined;
  try {
    await signInOnLoginPage(developer.page, stack.developer);
    const registration = await createClient(developer.page, applicationType, authentication, redirectUri);
    expect(registration.status).toBe(200);
    expect(registration.body.errors).toBeUndefined();
    registered = registration.body.data?.createOAuthClient as RegisteredClient | undefined;
    if (!registered) throw new Error('The owned app registration returned no client.');
    expect(registered.client.redirectUris).toEqual([redirectUri]);
    if (authentication === 'NONE') expect(registered.clientSecret).toBeNull();
    else expect(registered.clientSecret).toBeTruthy();
    const appFetch = edgeFetch(stack.appEdgePort, stack.certificatePem, [API_HOST, WS_HOST, WWW_HOST]);
    const server = await oauth.processDiscoveryResponse(
      new URL(ISSUER),
      await oauth.discoveryRequest(new URL(ISSUER), { algorithm: 'oauth2', [oauth.customFetch]: appFetch }),
    );
    await run({
      stack,
      developer: developer.page,
      climber: climber.page,
      registered,
      server,
      client: { client_id: registered.client.clientId },
      appFetch,
    });
  } finally {
    try {
      if (registered) {
        const token = await firstPartyToken(developer.page);
        const removed = await graphqlFromWww(developer.page, token, DELETE_OAUTH_CLIENT, {
          clientId: registered.client.clientId,
        });
        expect(removed.body).toEqual({ data: { deleteOAuthClient: true } });
      }
    } finally {
      await Promise.all([developer.context.close(), climber.context.close()]);
    }
  }
}

async function authorization(fixture: ClientFixture, redirectUri: string, extra: Record<string, string> = {}) {
  const verifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const url = new URL(fixture.server.authorization_endpoint ?? '');
  url.search = new URLSearchParams({
    client_id: fixture.client.client_id,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    ...extra,
  }).toString();
  return { url, verifier, state };
}

async function requirePkce(fixture: ClientFixture, redirectUri: string) {
  await signInOnLoginPage(fixture.climber, fixture.stack.climber);
  const request = await authorization(fixture, redirectUri);
  request.url.searchParams.delete('code_challenge');
  request.url.searchParams.delete('code_challenge_method');
  await fixture.climber.goto(request.url.toString());
  await fixture.climber.waitForURL((url) => url.origin === new URL(redirectUri).origin);
  const refused = new URL(fixture.climber.url());
  expect(callbackTarget(refused)).toBe(redirectUri);
  expect(refused.searchParams.get('error')).toBe('invalid_request');
  expect(refused.searchParams.get('state')).toBe(request.state);
  expect(refused.searchParams.has('code')).toBe(false);
}

/** The real consent POST returns JSON with its handoff URL, including for a private scheme. */
async function approve(fixture: ClientFixture, request: Awaited<ReturnType<typeof authorization>>) {
  const page = fixture.climber;
  await visitWithSignInReady(page, request.url.toString());
  if (new URL(page.url()).pathname === '/oauth/sign-in') {
    await page.getByLabel('Email').fill(fixture.stack.climber.email);
    await page.getByLabel('Password').fill(fixture.stack.climber.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  return acceptConsent(fixture, request);
}

async function acceptConsent(fixture: ClientFixture, request: Awaited<ReturnType<typeof authorization>>) {
  const page = fixture.climber;
  await page.waitForURL((url) => url.origin === WWW_ORIGIN && url.pathname === '/oauth/consent');
  await expect(
    page.getByRole('heading', { name: 'Connect Partner qualification to your Boardsesh account?' }),
  ).toBeVisible();
  // Observe the browser's native fetch before returning its unchanged response
  // to the UI. DevTools can discard the body as soon as the UI navigates away;
  // this clone keeps the actual CORS-checked JSON handoff without routing or mocks.
  type ConsentResponse = { status: number; body: { redirect: boolean; url: string } };
  let captureConsent!: (response: ConsentResponse) => void;
  const decision = new Promise<ConsentResponse>((resolve) => {
    captureConsent = resolve;
  });
  await page.exposeFunction('capturePartnerConsent', captureConsent);
  await page.evaluate((endpoint) => {
    const nativeFetch = window.fetch.bind(window);
    const observer = window as typeof window & {
      capturePartnerConsent: (response: ConsentResponse) => Promise<void>;
    };
    window.fetch = async (...arguments_: Parameters<typeof fetch>) => {
      const response = await nativeFetch(...arguments_);
      if (response.url === endpoint) {
        await observer.capturePartnerConsent({ status: response.status, body: await response.clone().json() });
      }
      return response;
    };
  }, `${ISSUER}/oauth2/consent`);
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  const response = await decision;
  expect(response.status).toBe(200);
  const body = response.body;
  expect(body.redirect).toBe(true);
  const callback = new URL(body.url);
  const parameters = oauth.validateAuthResponse(fixture.server, fixture.client, callback, request.state);
  expect(parameters.get('code')).toBeTruthy();
  return { callback, parameters };
}

async function browserFetch(
  page: Page,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  return page.evaluate(
    async ({ target, options }) => {
      const response = await fetch(target, { ...options, credentials: 'omit' });
      return {
        status: response.status,
        body: (await response.json().catch(() => null)) as JsonObject | null,
        retryAfter: response.headers.get('retry-after'),
        authenticate: response.headers.get('www-authenticate'),
        limit: response.headers.get('ratelimit-limit'),
        remaining: response.headers.get('ratelimit-remaining'),
      };
    },
    { target: url, options: init },
  );
}

async function browserToken(page: Page, server: oauth.AuthorizationServer, fields: Record<string, string>) {
  return browserFetch(page, server.token_endpoint ?? '', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

test('early click and Enter preserve the signed request until sign-in hydrates', async ({ browser }) => {
  const loopback = await startLoopbackRedirect();
  try {
    await withClient(browser, 'hydration', 'NATIVE', 'NONE', loopback.redirectUri, async (fixture) => {
      const page = fixture.climber;
      const request = await authorization(fixture, loopback.redirectUri);
      let releaseScripts!: () => void;
      const scriptsReady = new Promise<void>((resolve) => {
        releaseScripts = resolve;
      });
      let heldScripts = 0;
      const holdScripts = async (route: Route) => {
        if (route.request().resourceType() === 'script') {
          heldScripts += 1;
          await scriptsReady;
        }
        await route.continue();
      };
      await page.route('**/*', holdScripts);
      try {
        // A deferred script prevents DOMContentLoaded. Assert the actual SSR
        // form after commit instead, with the real browser scripts still held.
        await page.goto(request.url.toString(), { waitUntil: 'commit' });
        await expect(page.getByRole('heading', { name: 'Sign in to connect an app' })).toBeVisible();
        const signedUrl = page.url();
        expect(new URL(signedUrl).pathname).toBe('/oauth/sign-in');
        expect(new URL(signedUrl).searchParams.get('sig')).toBeTruthy();
        expect(new URL(signedUrl).searchParams.get('state')).toBe(request.state);
        await expect.poll(() => heldScripts).toBeGreaterThan(0);
        const email = page.getByLabel('Email');
        const password = page.getByLabel('Password');
        const submit = page.getByRole('button', { name: 'Sign in', exact: true });
        await expect(email).toBeDisabled();
        await expect(password).toBeDisabled();
        await expect(submit).toBeDisabled();
        await expect(page.locator('form')).toHaveCount(0);
        expect(await email.evaluate((input) => input instanceof HTMLInputElement && input.form === null)).toBe(true);
        expect(await password.evaluate((input) => input instanceof HTMLInputElement && input.form === null)).toBe(true);
        let formNavigations = 0;
        page.on('request', (outgoing) => {
          if (outgoing.isNavigationRequest() && outgoing.frame() === page.mainFrame()) formNavigations += 1;
        });
        // Physical input bypasses Playwright's disabled-control waiting. The
        // browser itself must ignore both click and implicit Enter submission.
        for (const control of [submit, email, password]) {
          const box = await control.boundingBox();
          if (!box) throw new Error('The server-rendered sign-in control has no bounds.');
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await page.keyboard.type('early');
          await page.keyboard.press('Enter');
        }
        // Autofill may use requestSubmit(): before mount, there is no form
        // owner for it to submit, even though native form.submit ignores disabled.
        expect(
          await email.evaluate((input) => {
            if (!(input instanceof HTMLInputElement)) throw new Error('No native email input.');
            input.form?.requestSubmit();
            return input.form === null;
          }),
        ).toBe(true);
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        );
        expect(page.url()).toBe(signedUrl);
        expect(formNavigations).toBe(0);
        await expect(email).toHaveValue('');
        await expect(password).toHaveValue('');
        releaseScripts();
        await page.unrouteAll({ behavior: 'wait' });
        await expect(submit).toBeEnabled();
        expect(
          await email.evaluate((input) => input instanceof HTMLInputElement && input.form instanceof HTMLFormElement),
        ).toBe(true);
        await email.fill(fixture.stack.climber.email);
        await password.fill(fixture.stack.climber.password);
        await submit.click();
        const { callback, parameters } = await acceptConsent(fixture, request);
        expect((await loopback.callback).toString()).toBe(callback.toString());
        const tokens = await oauth.processAuthorizationCodeResponse(
          fixture.server,
          fixture.client,
          await oauth.authorizationCodeGrantRequest(
            fixture.server,
            fixture.client,
            oauth.None(),
            parameters,
            loopback.redirectUri,
            request.verifier,
            { additionalParameters: { resource: RESOURCE }, [oauth.customFetch]: fixture.appFetch },
          ),
        );
        const me = await fixture.appFetch(`${RESOURCE}/me`, {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        });
        expect(me.status).toBe(200);
        await expect(me.json()).resolves.toMatchObject({ displayName: fixture.stack.climber.name });
      } finally {
        releaseScripts();
        await page.unrouteAll({ behavior: 'wait' });
      }
    });
  } finally {
    loopback.server.closeAllConnections();
    await new Promise<void>((resolve) => loopback.server.close(() => resolve()));
  }
});

test('a public web app exchanges PKCE in browser JavaScript, refreshes and revokes its tokens', async ({ browser }) => {
  const redirectUri = `${PUBLIC_APP_ORIGIN}/callback`;
  await withClient(browser, 'public-web', 'WEB', 'NONE', redirectUri, async (fixture) => {
    await requirePkce(fixture, redirectUri);
    const request = await authorization(fixture, redirectUri);
    const accepted = await approve(fixture, request);
    await fixture.climber.waitForURL((url) => url.origin === PUBLIC_APP_ORIGIN && url.pathname === '/callback');
    expect(fixture.climber.url()).toBe(accepted.callback.toString());
    const exchanged = await browserToken(fixture.climber, fixture.server, {
      grant_type: 'authorization_code',
      client_id: fixture.client.client_id,
      redirect_uri: redirectUri,
      code: accepted.parameters.get('code')!,
      code_verifier: request.verifier,
      resource: RESOURCE,
    });
    expect(exchanged.status).toBe(200);
    expect(String(exchanged.body?.token_type).toLowerCase()).toBe('bearer');
    const { accessToken: access, refreshToken: refresh } = tokenPair(exchanged.body);
    const me = await browserFetch(fixture.climber, `${RESOURCE}/me`, {
      headers: { authorization: `Bearer ${access}` },
    });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ displayName: fixture.stack.climber.name });
    const renewed = await browserToken(fixture.climber, fixture.server, {
      grant_type: 'refresh_token',
      client_id: fixture.client.client_id,
      refresh_token: refresh,
      resource: RESOURCE,
    });
    expect(renewed.status).toBe(200);
    const rotated = tokenPair(renewed.body);
    expect(rotated.refreshToken).not.toBe(refresh);
    expect(rotated.accessToken).not.toBe(access);
    const afterRefresh = await browserFetch(fixture.climber, `${RESOURCE}/me`, {
      headers: { authorization: `Bearer ${rotated.accessToken}` },
    });
    expect(afterRefresh.status).toBe(200);
    expect(afterRefresh.body).toEqual(me.body);
    const revoked = await browserFetch(fixture.climber, fixture.server.revocation_endpoint ?? '', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: fixture.client.client_id,
        token: rotated.refreshToken,
        token_type_hint: 'refresh_token',
      }).toString(),
    });
    expect(revoked.status).toBe(200);
    const refused = await browserFetch(fixture.climber, `${RESOURCE}/me`, {
      headers: { authorization: `Bearer ${rotated.accessToken}` },
    });
    expect(refused.status).toBe(401);
    expect(refused.authenticate).toContain('invalid_token');
    const refreshAfterRevocation = await browserToken(fixture.climber, fixture.server, {
      grant_type: 'refresh_token',
      client_id: fixture.client.client_id,
      refresh_token: rotated.refreshToken,
    });
    expect(refreshAfterRevocation.status).toBe(400);
    expect(refreshAfterRevocation.body).toMatchObject({ error: 'invalid_grant' });
  });
});

test('a confidential web app needs its secret as well as PKCE, refreshes and disconnects', async ({ browser }) => {
  const redirectUri = `${CONFIDENTIAL_APP_ORIGIN}/callback`;
  await withClient(browser, 'confidential-web', 'WEB', 'CLIENT_SECRET_BASIC', redirectUri, async (fixture) => {
    await requirePkce(fixture, redirectUri);
    const request = await authorization(fixture, redirectUri);
    const { parameters } = await approve(fixture, request);
    await fixture.climber.waitForURL((url) => url.origin === CONFIDENTIAL_APP_ORIGIN);
    const viaEdge = { additionalParameters: { resource: RESOURCE }, [oauth.customFetch]: fixture.appFetch };
    for (const refusal of [
      { label: 'missing secret', authentication: oauth.None(), status: 400 },
      { label: 'wrong Basic secret', authentication: oauth.ClientSecretBasic('wrong-test-secret'), status: 401 },
    ]) {
      const refused = await oauth.authorizationCodeGrantRequest(
        fixture.server,
        fixture.client,
        refusal.authentication,
        parameters,
        redirectUri,
        request.verifier,
        viaEdge,
      );
      expect(refused.status, refusal.label).toBe(refusal.status);
      await expect(refused.clone().json(), refusal.label).resolves.toMatchObject({ error: 'invalid_client' });
      if (refusal.status === 401) expect(refused.headers.get('www-authenticate')).toMatch(/^Basic\b/i);
      else expect(refused.headers.get('www-authenticate')).toBeNull();
    }
    const authentication = oauth.ClientSecretBasic(fixture.registered.clientSecret!);
    const tokens = await oauth.processAuthorizationCodeResponse(
      fixture.server,
      fixture.client,
      await oauth.authorizationCodeGrantRequest(
        fixture.server,
        fixture.client,
        authentication,
        parameters,
        redirectUri,
        request.verifier,
        viaEdge,
      ),
    );
    const originalPair = tokenPair(tokens);
    const renewed = await oauth.processRefreshTokenResponse(
      fixture.server,
      fixture.client,
      await oauth.refreshTokenGrantRequest(
        fixture.server,
        fixture.client,
        authentication,
        originalPair.refreshToken,
        viaEdge,
      ),
    );
    const rotatedPair = tokenPair(renewed);
    expect(rotatedPair.refreshToken).not.toBe(originalPair.refreshToken);
    const headers = { authorization: `Bearer ${rotatedPair.accessToken}` };
    expect((await fixture.appFetch(`${RESOURCE}/me`, { headers })).status).toBe(200);
    expect((await fixture.appFetch(`${RESOURCE}/connection`, { method: 'DELETE', headers })).status).toBe(204);
    expect((await fixture.appFetch(`${RESOURCE}/me`, { headers })).status).toBe(401);
    const refused = await oauth.refreshTokenGrantRequest(
      fixture.server,
      fixture.client,
      authentication,
      rotatedPair.refreshToken,
      viaEdge,
    );
    expect(refused.status).toBe(400);
    await expect(oauth.processRefreshTokenResponse(fixture.server, fixture.client, refused)).rejects.toMatchObject({
      error: 'invalid_grant',
    });
  });
});

test('a native private scheme gets the exact browser consent handoff and HTTP silent refusal', async ({ browser }) => {
  const redirectUri = 'com.example.qualification:/oauth/callback';
  await withClient(browser, 'native-scheme', 'NATIVE', 'NONE', redirectUri, async (fixture) => {
    const request = await authorization(fixture, redirectUri);
    const { callback, parameters } = await approve(fixture, request);
    expect(callbackTarget(callback)).toBe(redirectUri);
    expect(callback.searchParams.get('iss')).toBe(ISSUER);
    const tokens = await oauth.processAuthorizationCodeResponse(
      fixture.server,
      fixture.client,
      await oauth.authorizationCodeGrantRequest(
        fixture.server,
        fixture.client,
        oauth.None(),
        parameters,
        redirectUri,
        request.verifier,
        { additionalParameters: { resource: RESOURCE }, [oauth.customFetch]: fixture.appFetch },
      ),
    );
    expect(
      (await fixture.appFetch(`${RESOURCE}/me`, { headers: { authorization: `Bearer ${tokens.access_token}` } }))
        .status,
    ).toBe(200);
    // The same browser context supplies its real climber cookies and local
    // proxy, but stops at the HTTP redirect. Unsupported private schemes are
    // not consistently exposed as navigation responses by WebKit automation.
    const silent = await authorization(fixture, redirectUri, { prompt: 'none' });
    const refused = await fixture.climber.context().request.get(silent.url.toString(), { maxRedirects: 0 });
    expect(refused.url()).toBe(silent.url.toString());
    expect(refused.status()).toBe(302);
    const location = new URL(refused.headers().location ?? '');
    expect(callbackTarget(location)).toBe(redirectUri);
    expect(location.searchParams.get('iss')).toBe(ISSUER);
    expect(location.searchParams.get('error')).toBe('consent_required');
    expect(location.searchParams.get('state')).toBe(silent.state);
    expect(location.searchParams.has('code')).toBe(false);
  });
});

test('loopback ports may vary, but paths and web/native redirect types cannot', async ({ browser }) => {
  const loopback = await startLoopbackRedirect();
  try {
    await withClient(browser, 'loopback', 'NATIVE', 'NONE', 'http://127.0.0.1/callback', async (fixture) => {
      for (const redirect of ['http://127.0.0.1/other-path', `${PUBLIC_APP_ORIGIN}/unregistered`]) {
        const request = await authorization(fixture, redirect);
        const response = await fixture.climber.goto(request.url.toString());
        expect(response?.status()).toBe(400);
        const refused = new URL(fixture.climber.url());
        expect(`${refused.origin}${refused.pathname}`).toBe(`${ISSUER}/error`);
        expect(refused.searchParams.get('error')).toBe('invalid_redirect');
        expect(refused.searchParams.has('code')).toBe(false);
        expect(refused.searchParams.has('state')).toBe(false);
      }
      const request = await authorization(fixture, loopback.redirectUri);
      const { callback } = await approve(fixture, request);
      expect((await loopback.callback).toString()).toBe(callback.toString());
      expect(callbackTarget(callback)).toBe(loopback.redirectUri);
      // Use the actual registration mutation: web apps cannot register native-only redirects.
      for (const redirect of [
        'http://127.0.0.1/callback',
        'com.example.qualification:/oauth/callback',
        'http://localhost/callback',
      ]) {
        const refused = await createClient(fixture.developer, 'WEB', 'NONE', redirect);
        expect(refused.body.errors).toEqual([
          expect.objectContaining({
            message: 'A web app can only use https:// redirect URIs.',
            extensions: expect.objectContaining({ code: 'BAD_USER_INPUT', reason: 'INVALID_INPUT' }),
          }),
        ]);
        expect(refused.body.data?.createOAuthClient).toBeFalsy();
      }
    });
  } finally {
    loopback.server.closeAllConnections();
    await new Promise<void>((resolve) => loopback.server.close(() => resolve()));
  }
});

test('registered browser JavaScript reads real 401 and 429 replies; an unregistered origin cannot', async ({
  browser,
}) => {
  await withClient(browser, 'cors', 'WEB', 'NONE', `${PUBLIC_APP_ORIGIN}/callback`, async (fixture) => {
    await fixture.climber.goto(`${PUBLIC_APP_ORIGIN}/`);
    const unauthorized = await browserFetch(fixture.climber, `${RESOURCE}/me`, {
      headers: { authorization: 'Bearer nonexistent-qualification-token' },
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body).toMatchObject({ error: 'invalid_token' });
    expect(unauthorized.authenticate).toContain('invalid_token');
    // The only bucket we fill belongs to this run's newly registered client.
    // Redis uses fixed minute buckets. WebKit can cross a minute boundary while
    // sending the burst, so allow enough requests to fill either of two buckets.
    const requestsPerMinute = 60;
    const maximumAttempts = requestsPerMinute * 2 + 1;
    const fields = {
      grant_type: 'authorization_code',
      client_id: fixture.client.client_id,
      code: 'nonexistent-qualification-code',
      code_verifier: oauth.generateRandomCodeVerifier(),
      redirect_uri: `${PUBLIC_APP_ORIGIN}/callback`,
      resource: RESOURCE,
    };
    let limited: Awaited<ReturnType<typeof browserToken>> | undefined;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const reply = await browserToken(fixture.climber, fixture.server, fields);
      if (reply.status === 429) {
        limited = reply;
        break;
      }
      expect(reply.status).toBe(400);
      expect(reply.body).toMatchObject({ error: 'invalid_grant' });
    }
    expect(limited?.status).toBe(429);
    expect(limited?.body).toMatchObject({ error: 'rate_limited' });
    expect(Number(limited?.retryAfter)).toBeGreaterThan(0);
    expect(limited?.limit).toBe(String(requestsPerMinute));
    expect(limited?.remaining).toBe('0');
    const preflight = await fixture.appFetch(`${RESOURCE}/me`, {
      method: 'OPTIONS',
      headers: {
        origin: PUBLIC_APP_ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBe(PUBLIC_APP_ORIGIN);
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    await fixture.climber.goto(`${UNREGISTERED_APP_ORIGIN}/`);
    const blocked = await fixture.climber.evaluate(async (url) => {
      try {
        await fetch(url, { headers: { authorization: 'Bearer nonexistent-qualification-token' } });
        return false;
      } catch (error) {
        return error instanceof TypeError;
      }
    }, `${RESOURCE}/me`);
    expect(blocked).toBe(true);
  });
});
