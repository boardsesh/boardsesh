import 'server-only';
import { parseSetCookie, stringifySetCookie } from 'cookie';
import type { NextAuthOptions } from 'next-auth';
import { NextRequest } from 'next/server';
import { providerSecurityMode, type WebOAuthProvider } from '@boardsesh/auth-protocol';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import type { AuthServiceEnvironment } from '@boardsesh/auth-protocol/transport';
import type {
  AnonymousProviderResponseAdmission,
  AuthResponseAdmissionCompletion,
} from './auth-response-admission.server';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { resolvePublicAuthOrigin } from './canonical-auth-url';
import { unavailableCredentialResponse } from './credential-admission-response.server';
import { boundedAuthCookiePairs } from './public-auth-request.server';
import { readPresentedBrowserSelection, type PresentedBrowserSelection } from './presented-browser-selection.server';
import { readProviderSecurityAuthBody } from './provider-security-auth-body.server';
import { publicProviderSecurityReady } from './provider-security-readiness';
import { requireProviderCookieCapacity } from './provider-cookie-capacity.server';
import { buildBrowserProofCookieCandidate } from './browser-proof-cookies.server';
import { providerFrameworkProtectedCookie } from './provider-framework-cookies.server';
import {
  createProviderSecurityCommandClient,
  providerCandidateCredentialHash,
  type ProviderSecurityCommandClient,
} from './provider-security-command-client.server';
import {
  captureProviderBrowserContext,
  requireProviderSecurityFlowActor,
  type ProviderBrowserContext,
} from './provider-security-selection.server';
import { createProviderSecurityOAuthFlowReader } from './provider-security-flow-reader.server';
import { createProviderSecurityAuthPublication } from './provider-security-auth.server';
import { createProviderSecurityGoogleReauthentication } from './provider-security-google-reauth.server';
import {
  providerSecurityFlowCookieName,
  providerSecurityOperationKey,
  sealProviderSecurityFlow,
} from './provider-security-flow.server';
import {
  assertProviderOwnedSigninFlowSecret,
  openProviderOwnedSigninFlow,
  providerOwnedSigninCookieName,
  providerOwnedSigninNonceHash,
  sealProviderOwnedSigninFlow,
  requireProviderOwnedSigninActor,
  type ProviderOwnedSigninFlow,
} from './provider-owned-signin-flow.server';
import { createProviderOwnedSigninAuthPublication } from './provider-owned-signin-auth.server';
import {
  assertAnonymousProviderFlowSecret,
  anonymousProviderFlowCookieName,
  captureAnonymousProviderBrowserContext,
  openAnonymousProviderFlow,
  requireAnonymousProviderBrowser,
  sealAnonymousProviderFlow,
  type AnonymousProviderBrowserContext,
  type AnonymousProviderFlow,
} from './anonymous-provider-flow.server';
import { createAnonymousProviderAuthPublication } from './anonymous-provider-auth.server';
import {
  createAnonymousProviderCommandClient,
  type AnonymousProviderCommandClient,
} from './anonymous-provider-command-client.server';
import { resumeAppleOAuthCallback, webOAuthFlowHash } from './web-oauth-continuation.server';
import { validatedExpoReturnUrl } from './expo-web-oauth-return';
import {
  providerSecurityCookieName,
  sameProviderSecurityCursor,
  type PrepareProviderSecurityCookies,
} from './provider-security-publication.server';
import type { QualifiedWebOAuthProviderDelegate } from './web-oauth-request.server';

interface Publication {
  readonly options: NextAuthOptions;
  quarantine(response: Response): Response;
  acknowledgeAdmission(response: Response): void;
  run(invoke: () => Promise<Response>): Promise<Response>;
}
export interface ProviderOAuthOuter {
  readonly options: NextAuthOptions;
  readonly delegate: QualifiedWebOAuthProviderDelegate;
  readonly anonymousAdmission?: AnonymousProviderResponseAdmission;
  readonly completeAdmission?: AuthResponseAdmissionCompletion;
  quarantine(response: Response): Response;
  run(invoke: () => Promise<Response>): Promise<Response>;
}
type Context = { readonly params: Promise<{ readonly nextauth: readonly string[] }> };
const refuse = (): never => {
  throw new AuthBackendUnavailableError();
};
const unavailableOuter = (base: NextAuthOptions): ProviderOAuthOuter => ({
  options: base,
  delegate: { start: async () => refuse(), callback: async () => refuse() },
  quarantine: () => unavailableCredentialResponse(),
  run: async () => unavailableCredentialResponse(),
});

function permitsLegacyProviderRequest(environment: AuthServiceEnvironment, cookies: string | null): boolean {
  return (
    browserBindingMode(environment) === 'legacy' &&
    !boundedAuthCookiePairs(cookies).some((cookie) => cookie.name.startsWith('__Host-boardsesh.'))
  );
}

/** The canonical Host plus fixed server configuration authorizes OAuth. A
 * standalone server's internal URL and forwarded headers never choose it. */
export function captureProviderOAuthRequest(
  requested: NextRequest,
  suppliedEnvironment: AuthServiceEnvironment = process.env,
): NextRequest {
  const headers = new Headers(requested.headers);
  const environment = Object.freeze({ ...suppliedEnvironment });
  const url = new URL(requested.url);
  if (!/^\/api\/auth\/(?:signin|callback)\/(?:google|apple)(?:\/|$)/.test(url.pathname))
    return new NextRequest(requested.clone(), { headers });
  if (providerSecurityMode(environment) === 'legacy') {
    if (!permitsLegacyProviderRequest(environment, headers.get('cookie'))) return refuse();
    return new NextRequest(requested.clone(), { headers });
  }
  const origin = resolvePublicAuthOrigin(environment);
  if (
    !origin ||
    new URL(origin).protocol !== 'https:' ||
    headers.get('host') !== new URL(origin).host ||
    !/^\/api\/auth\/(?:signin|callback)\/(?:google|apple)$/.test(url.pathname) ||
    (url.pathname.includes('/signin/') && headers.get('origin') !== origin)
  )
    return refuse();
  const canonical = new URL(`${url.pathname}${url.search}`, origin);
  return new NextRequest(canonical, {
    method: requested.method,
    headers,
    signal: requested.signal,
    ...(requested.body ? { body: requested.clone().body } : {}),
  });
}

function captureIssuer(base: NextAuthOptions): NextAuthOptions {
  return {
    ...base,
    callbacks: { ...base.callbacks },
    jwt: { ...base.jwt },
    events: { ...base.events },
    cookies: Object.fromEntries(
      Object.entries(base.cookies ?? {}).map(([name, cookie]) => [name, { ...cookie, options: { ...cookie.options } }]),
    ),
    providers: base.providers.map<NextAuthOptions['providers'][number]>((configured) => {
      if (configured.type !== 'oauth') return configured;
      const authorization = configured.authorization;
      const optionsAuthorization = configured.options?.authorization;
      return {
        ...configured,
        ...(typeof authorization === 'object'
          ? { authorization: { ...authorization, params: { ...authorization.params } } }
          : {}),
        options: configured.options
          ? {
              ...configured.options,
              ...(typeof optionsAuthorization === 'object'
                ? { authorization: { ...optionsAuthorization, params: { ...optionsAuthorization.params } } }
                : {}),
            }
          : undefined,
      };
    }),
  };
}

function googleOptions(base: NextAuthOptions, reauthenticate = false): NextAuthOptions {
  return {
    ...base,
    providers: base.providers.map<NextAuthOptions['providers'][number]>((configured) => {
      if (configured.type !== 'oauth' || (configured.options?.id ?? configured.id) !== 'google') return configured;
      const clientId = configured.options?.clientId ?? configured.clientId;
      const clientSecret = configured.options?.clientSecret ?? configured.clientSecret;
      if (!clientId || !clientSecret) return refuse();
      const authorization = configured.options?.authorization ?? configured.authorization;
      const challenge = reauthenticate
        ? {
            authorization: {
              ...(typeof authorization === 'string' ? { url: authorization } : authorization),
              params: {
                ...(typeof authorization === 'object' ? authorization.params : {}),
                prompt: 'login',
                max_age: 0,
              },
            },
          }
        : {};
      return {
        ...configured,
        checks: ['state', 'pkce', 'nonce'],
        idToken: true,
        allowDangerousEmailAccountLinking: false,
        ...challenge,
        options: {
          ...configured.options,
          clientId,
          clientSecret,
          checks: ['state', 'pkce', 'nonce'],
          idToken: true,
          allowDangerousEmailAccountLinking: false,
          ...challenge,
        },
      };
    }),
  };
}
function proofCookies(observedCookieHeader: string | null): PrepareProviderSecurityCookies {
  return ({ candidate, cursor, credentialExpiresAt }) => {
    const deadline = Math.min(Date.parse(credentialExpiresAt), Date.parse(cursor.bindingExpiresAt));
    const planned = buildBrowserProofCookieCandidate({
      cursor: { bindingId: cursor.bindingId, version: cursor.version },
      proof: { kind: candidate.kind, rawCredential: candidate.credential },
      proofMaxAgeSeconds: Math.floor((deadline - Date.now()) / 1000),
      observedCookieHeader,
      retainObservedProofCookies: true,
    });
    return Object.freeze({
      cursor,
      candidateCredentialHash: providerCandidateCredentialHash(candidate),
      headers: Object.freeze(
        planned.headers.map(
          (header) => `${header.replace(/; Max-Age=[0-9]+/i, '')}; Expires=${new Date(deadline).toUTCString()}`,
        ),
      ),
    });
  };
}
async function authorizationUrl(response: Response): Promise<URL> {
  let destination = response.headers.get('Location');
  if (!destination && /^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) {
    const body = await readProviderSecurityAuthBody(response.clone());
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body ?? new Uint8Array()));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 ||
      !('url' in parsed) ||
      typeof parsed.url !== 'string'
    )
      return refuse();
    destination = parsed.url;
  }
  if (!destination) return refuse();
  const url = new URL(destination);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return refuse();
  return url;
}
function nonceFor(provider: WebOAuthProvider, url: URL): string | null {
  if (provider === 'apple') return null;
  const nonces = url.searchParams.getAll('nonce');
  if (nonces.length !== 1 || !/^[A-Za-z0-9_-]{1,1024}$/.test(nonces[0])) return refuse();
  return nonces[0];
}
function actualReturn(
  response: Response,
  options: NextAuthOptions,
  provider: WebOAuthProvider,
  origin: string,
): string {
  const name = options.cookies?.callbackUrl?.name;
  if (!name) return refuse();
  const observed = response.headers
    .getSetCookie()
    .map((header) => parseSetCookie(header))
    .filter((cookie) => cookie.name === name && cookie.value);
  if (observed.length !== 1 || !observed[0].value) return refuse();
  const url = new URL(decodeURIComponent(observed[0].value));
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href.length > 4096) return refuse();
  if (url.origin !== origin && validatedExpoReturnUrl(url.href, provider, origin) !== url.href) return refuse();
  return url.href;
}
function carrier(response: Response, name: string, content: string, expiresAt: string): string {
  const header = stringifySetCookie({
    name,
    value: content,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    expires: new Date(expiresAt),
  });
  response.headers.append('Set-Cookie', header);
  return header;
}
async function ordinaryStartFields(request: NextRequest): Promise<void> {
  if (
    request.headers.has('content-encoding') ||
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded'
  )
    return refuse();
  const content = await readProviderSecurityAuthBody(new Response(request.clone().body, { headers: request.headers }));
  if (content === null || content.byteLength > 16_384) return refuse();
  const fields = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(content));
  const allowed = new Set(['csrfToken', 'callbackUrl', 'json']);
  if ([...fields.keys()].some((key) => !allowed.has(key) || fields.getAll(key).length !== 1)) return refuse();
}

/** Top-level request composition. Its run() must enclose the actual admission,
 * scoped flow/Apple clears and partner/Expo response decorators before commit. */
export async function createProviderOAuthOuter(
  requested: NextRequest,
  context: Context,
  inputOptions: NextAuthOptions,
  dependencies: {
    readonly environment?: AuthServiceEnvironment;
    readonly ready?: () => boolean;
    readonly readSelection?: (cookies: string | null) => Promise<PresentedBrowserSelection>;
    readonly providerClientFactory?: () => ProviderSecurityCommandClient;
    readonly anonymousClientFactory?: () => AnonymousProviderCommandClient;
    readonly prepareCookiePublication?: PrepareProviderSecurityCookies;
  } = {},
): Promise<ProviderOAuthOuter | null> {
  const request = new NextRequest(requested.clone(), { headers: new Headers(requested.headers) });
  const base = captureIssuer(inputOptions);
  const environment = Object.freeze({ ...(dependencies.environment ?? process.env) });
  const ready = dependencies.ready ?? publicProviderSecurityReady;
  const cookies = request.headers.get('cookie');
  const signal = request.signal;
  const headers = new Headers(request.headers);
  const url = new URL(request.url);
  const method = request.method;
  const route = [...(await context.params).nextauth];
  const [action, provider] = route;
  if (!['signin', 'callback'].includes(action) || (provider !== 'google' && provider !== 'apple')) return null;
  try {
    if (providerSecurityMode(environment) === 'legacy')
      return permitsLegacyProviderRequest(environment, cookies) ? null : unavailableOuter(base);
    if (
      !ready() ||
      browserBindingMode(environment) !== 'backend-staging' ||
      environment.CURRENT_STORE_WEB_OAUTH_MODE !== 'backend-staging'
    )
      return unavailableOuter(base);
    const origin = resolvePublicAuthOrigin(environment);
    if (
      !origin ||
      new URL(origin).protocol !== 'https:' ||
      headers.get('host') !== new URL(origin).host ||
      url.origin !== origin ||
      route.length !== 2 ||
      url.pathname !== `/api/auth/${action}/${provider}` ||
      url.href.length > 8192 ||
      signal.aborted
    )
      return refuse();
    if (action === 'signin' && (method !== 'POST' || url.search || headers.get('origin') !== origin)) return refuse();
    if (action === 'callback' && method !== 'GET') return refuse(); // Raw Apple POST normalizes before this factory.
    const observed = boundedAuthCookiePairs(cookies);
    const ownedCarriers = observed.filter((cookie) => cookie.name.startsWith('__Host-boardsesh.provider-signin.'));
    const anonymousCarriers = observed.filter((cookie) =>
      cookie.name.startsWith('__Host-boardsesh.anonymous-provider.'),
    );
    const ordinaryCarriers = [...ownedCarriers, ...anonymousCarriers];
    if (
      ordinaryCarriers.length > 4 ||
      ordinaryCarriers.some((cookie) => !/^[a-f0-9]{64}$/.test(cookie.name.slice(cookie.name.lastIndexOf('.') + 1))) ||
      new Set(ordinaryCarriers.map((cookie) => cookie.name)).size !== ordinaryCarriers.length
    )
      return refuse();
    const readSelection =
      dependencies.readSelection ?? ((header) => readPresentedBrowserSelection(header, { environment }));
    const providerFactory =
      dependencies.providerClientFactory ?? (() => createProviderSecurityCommandClient({ environment }));
    const anonymousFactory =
      dependencies.anonymousClientFactory ?? (() => createAnonymousProviderCommandClient({ environment }));
    const prepareCookies = dependencies.prepareCookiePublication ?? proofCookies(cookies);
    const explicit = await createProviderSecurityOAuthFlowReader({ environment, ready, readSelection }).read(
      request,
      base,
      { action, provider },
    );
    if (explicit.status === 'refused') return refuse();
    if (signal.aborted) return refuse();
    let publication: Publication | undefined;
    let owned: ProviderBrowserContext | undefined;
    let anonymous: AnonymousProviderBrowserContext | undefined;
    let selectedOptions = googleOptions(base);
    let bindStart: QualifiedWebOAuthProviderDelegate['start'] | undefined;
    let stagedHeader: string | undefined;
    let quarantined: Response | undefined;
    let acknowledged = false;
    let running = false;
    let startCalled = false;
    if (explicit.status === 'explicit') {
      owned = explicit.actor;
      if (explicit.purpose === 'reauthenticate-google') {
        const reauthentication = createProviderSecurityGoogleReauthentication(
          googleOptions(base, true),
          request,
          explicit.flow,
          {
            locale: explicit.returnUrl.includes('/es/settings')
              ? 'es'
              : explicit.returnUrl.includes('/fr/settings')
                ? 'fr'
                : explicit.returnUrl.includes('/de/settings')
                  ? 'de'
                  : explicit.returnUrl.includes('/it/settings')
                    ? 'it'
                    : 'en-US',
            environment,
            ready,
            readSelection,
            clientFactory: providerFactory,
          },
        );
        publication = { ...reauthentication, run: (invoke) => reauthentication.run(() => invoke()) };
        selectedOptions = reauthentication.options;
        bindStart = (input) => reauthentication.bindStart(input);
      } else if (action === 'callback') {
        if (!explicit.flowHash || !explicit.flow.reauthenticationToken) return refuse();
        publication = createProviderSecurityAuthPublication(
          selectedOptions,
          {
            provider,
            actor: owned.actor,
            sourceCredentialProof: owned.sourceCredentialProof,
            credentialExpiresAt: owned.credentialExpiresAt,
            intentToken: explicit.flow.intentToken,
            browserIntentToken: explicit.flow.browserIntentToken,
            reauthenticationToken: explicit.flow.reauthenticationToken,
            flowHash: explicit.flowHash,
            returnUrl: explicit.returnUrl,
          },
          { requestUrl: request.url, prepareCookiePublication: prepareCookies, clientFactory: providerFactory },
        );
        selectedOptions = publication.options;
      } else {
        bindStart = async (input) => {
          const staged = { ...explicit.flow, providerFlowHash: input.flowHash };
          const sealed = await sealProviderSecurityFlow(staged, environment.NEXTAUTH_SECRET ?? '');
          const response = new Response(input.response.body, {
            status: input.response.status,
            statusText: input.response.statusText,
            headers: new Headers(input.response.headers),
          });
          stagedHeader = carrier(
            response,
            providerSecurityFlowCookieName(providerSecurityOperationKey(staged.intentToken), true),
            sealed,
            staged.expiresAt,
          );
          requireProviderCookieCapacity(cookies, response.headers);
          const result = await providerFactory().command('bind', {
            actor: explicit.actor.actor,
            intentToken: staged.intentToken,
            browserIntentToken: staged.browserIntentToken,
            flowHash: input.flowHash,
          });
          if (result.outcome !== 'bound') return refuse();
          return response;
        };
      }
    } else {
      const selected = await readSelection(cookies);
      if (selected.status === 'admitted') owned = captureProviderBrowserContext(selected);
      else anonymous = captureAnonymousProviderBrowserContext(cookies, selected);
      if (action === 'callback') {
        const states = url.searchParams.getAll('state');
        const state =
          provider === 'apple' && url.searchParams.has('boardseshOAuthContinue')
            ? (await resumeAppleOAuthCallback(request, base, url.searchParams.get('boardseshOAuthContinue') ?? ''))
                .state
            : states.length === 1 && states[0]
              ? states[0]
              : refuse();
        const hash = webOAuthFlowHash(provider, state);
        const ownedCookie = ownedCarriers.filter((cookie) => cookie.name === providerOwnedSigninCookieName(hash));
        const anonymousCookie = anonymousCarriers.filter(
          (cookie) => cookie.name === anonymousProviderFlowCookieName(hash),
        );
        if (ownedCookie.length + anonymousCookie.length !== 1) return refuse();
        if (ownedCookie.length) {
          if (!owned) return refuse();
          const flow = await openProviderOwnedSigninFlow(
            ownedCookie[0].content,
            hash,
            environment.NEXTAUTH_SECRET ?? '',
          );
          if (flow.provider !== provider) return refuse();
          requireProviderOwnedSigninActor(flow, owned);
          publication = createProviderOwnedSigninAuthPublication(selectedOptions, request, flow, owned, {
            environment,
            prepareCookiePublication: prepareCookies,
            readSelection,
            clientFactory: providerFactory,
          });
        } else {
          if (!anonymous) return refuse();
          const flow = await openAnonymousProviderFlow(
            anonymousCookie[0].content,
            hash,
            environment.NEXTAUTH_SECRET ?? '',
          );
          if (flow.provider !== provider) return refuse();
          requireAnonymousProviderBrowser(flow, anonymous);
          publication = createAnonymousProviderAuthPublication(selectedOptions, request, flow, anonymous, {
            environment,
            prepareCookiePublication: prepareCookies,
            readSelection,
            clientFactory: anonymousFactory,
          });
        }
        selectedOptions = publication.options;
      } else {
        await ordinaryStartFields(request);
        assertProviderOwnedSigninFlowSecret(environment.NEXTAUTH_SECRET ?? '');
        assertAnonymousProviderFlowSecret(environment.NEXTAUTH_SECRET ?? '');
        if (ordinaryCarriers.length >= 4) return refuse();
        bindStart = async (input) => {
          const authorization = await authorizationUrl(input.response);
          if (
            authorization.searchParams.getAll('state').length !== 1 ||
            authorization.searchParams.get('state') !== input.state
          )
            return refuse();
          const nonce = nonceFor(provider, authorization);
          const returnUrl = actualReturn(input.response, input.options, provider, origin);
          const issuedAt = new Date().toISOString();
          const response = new Response(input.response.body, {
            status: input.response.status,
            statusText: input.response.statusText,
            headers: new Headers(input.response.headers),
          });
          if (owned) {
            const result = await providerFactory().command('signin-intent', {
              actor: owned.actor,
              provider,
              flowHash: input.flowHash,
              nonceHash: providerOwnedSigninNonceHash(nonce),
            });
            if (result.outcome !== 'recorded' || !sameProviderSecurityCursor(result.browserCursor, owned.browserCursor))
              return refuse();
            const flow: ProviderOwnedSigninFlow = {
              version: 1,
              provider,
              actorKind: owned.actor.kind,
              actorCredentialHash: owned.credentialHash,
              browserBindingHash: owned.browserCursor.bindingId,
              browserVersion: owned.browserCursor.version,
              browserBindingExpiresAt: owned.browserCursor.bindingExpiresAt,
              sourceCredentialProof: owned.sourceCredentialProof,
              credentialExpiresAt: owned.credentialExpiresAt,
              issuedAt,
              expiresAt: new Date(
                Math.min(
                  Date.parse(result.expiresAt),
                  Date.parse(owned.credentialExpiresAt),
                  Date.parse(owned.browserCursor.bindingExpiresAt),
                  Date.parse(issuedAt) + 900_000,
                ),
              ).toISOString(),
              intentToken: result.intentToken,
              browserIntentToken: result.browserIntentToken,
              flowHash: input.flowHash,
              nonce,
              returnUrl,
              preparation: null,
              preparationToken: null,
            };
            stagedHeader = carrier(
              response,
              providerOwnedSigninCookieName(input.flowHash),
              await sealProviderOwnedSigninFlow(flow, environment.NEXTAUTH_SECRET ?? ''),
              flow.expiresAt,
            );
          } else {
            if (!anonymous) return refuse();
            const result = await anonymousFactory().command('intent', {
              browser: anonymous.browser,
              provider,
              flowHash: input.flowHash,
              nonceHash: providerOwnedSigninNonceHash(nonce),
              credentialKind: 'canonical-token',
            });
            if (result.outcome !== 'recorded' || !sameProviderSecurityCursor(result.browserCursor, anonymous.cursor))
              return refuse();
            const flow: AnonymousProviderFlow = {
              version: 1,
              provider,
              credentialKind: 'canonical-token',
              browserBindingHash: anonymous.cursor.bindingId,
              browserVersion: anonymous.cursor.version,
              browserBindingExpiresAt: anonymous.cursor.bindingExpiresAt,
              issuedAt,
              expiresAt: new Date(
                Math.min(
                  Date.parse(result.expiresAt),
                  Date.parse(anonymous.cursor.bindingExpiresAt),
                  Date.parse(issuedAt) + 900_000,
                ),
              ).toISOString(),
              intentToken: result.intentToken,
              browserIntentToken: result.browserIntentToken,
              flowHash: input.flowHash,
              nonce,
              returnUrl,
              preparation: null,
              preparationToken: null,
            };
            stagedHeader = carrier(
              response,
              anonymousProviderFlowCookieName(input.flowHash),
              await sealAnonymousProviderFlow(flow, environment.NEXTAUTH_SECRET ?? ''),
              flow.expiresAt,
            );
          }
          requireProviderCookieCapacity(cookies, response.headers);
          return response;
        };
      }
    }
    const requireSource = async () => {
      if (signal.aborted) return refuse();
      const observedSelection = await readSelection(cookies);
      if (owned) {
        if (observedSelection.status !== 'admitted') return refuse();
        const repeated = captureProviderBrowserContext(observedSelection);
        requireProviderSecurityFlowActor(
          {
            actorKind: owned.actor.kind,
            actorCredentialHash: owned.credentialHash,
            browserBindingHash: owned.browserCursor.bindingId,
            browserVersion: owned.browserCursor.version,
            browserBindingExpiresAt: owned.browserCursor.bindingExpiresAt,
            sourceCredentialProof: owned.sourceCredentialProof,
            credentialExpiresAt: owned.credentialExpiresAt,
          },
          repeated,
        );
      } else {
        if (!anonymous) return refuse();
        const repeated = captureAnonymousProviderBrowserContext(cookies, observedSelection);
        if (
          !sameProviderSecurityCursor(repeated.cursor, anonymous.cursor) ||
          repeated.browser.bindingToken !== anonymous.browser.bindingToken
        )
          return refuse();
      }
    };
    const complete = (response: Response) => {
      if (publication) publication.acknowledgeAdmission(response);
      else {
        if (acknowledged || response !== quarantined) return refuse();
        acknowledged = true;
      }
    };
    return Object.freeze({
      options: selectedOptions,
      delegate: {
        async start(input) {
          if (
            !running ||
            action !== 'signin' ||
            startCalled ||
            input.provider !== provider ||
            !bindStart ||
            input.flowHash !== webOAuthFlowHash(provider, input.state)
          )
            return refuse();
          startCalled = true;
          return bindStart(input);
        },
        async callback(input) {
          if (!running || action !== 'callback' || !publication || input.provider !== provider) return refuse();
          return input.invoke(input.request, input.options);
        },
      } satisfies QualifiedWebOAuthProviderDelegate,
      ...(anonymous ? { anonymousAdmission: { cursor: anonymous.cursor, complete } } : { completeAdmission: complete }),
      quarantine(response: Response) {
        if (publication) return publication.quarantine(response);
        if (quarantined) return refuse();
        for (const header of response.headers.getSetCookie()) {
          if (header !== stagedHeader && providerFrameworkProtectedCookie(providerSecurityCookieName(header)))
            return refuse();
        }
        quarantined = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers(response.headers),
        });
        return quarantined;
      },
      async run(invoke: () => Promise<Response>) {
        if (running) return unavailableCredentialResponse();
        running = true;
        if (publication) return publication.run(invoke);
        try {
          await requireSource();
          const returned = await invoke();
          const responseHeaders = new Headers(returned.headers);
          const status = returned.status;
          const statusText = returned.statusText;
          const body = await readProviderSecurityAuthBody(returned);
          if (!quarantined || !acknowledged || responseHeaders.has('Content-Encoding')) return refuse();
          requireProviderCookieCapacity(cookies, responseHeaders);
          await requireSource();
          return new Response(body, { status, statusText, headers: responseHeaders });
        } catch {
          return unavailableCredentialResponse();
        }
      },
    });
  } catch {
    return unavailableOuter(base);
  }
}
