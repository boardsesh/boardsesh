import 'server-only';
import { createHash } from 'node:crypto';
import type { NextAuthOptions } from 'next-auth';
import type { Adapter } from 'next-auth/adapters';
import type { NextRequest } from 'next/server';
import { stringifySetCookie } from 'cookie';
import { providerSecurityMode } from '@boardsesh/auth-protocol';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import type { AuthServiceEnvironment } from '@boardsesh/auth-protocol/transport';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { BROWSER_CORRELATION_COOKIE, BROWSER_PROOF_COOKIE_PREFIX } from './browser-proof-cookies.server';
import { resolvePublicAuthOrigin } from './canonical-auth-url';
import { unavailableCredentialResponse } from './credential-admission-response.server';
import { readPresentedBrowserSelection, type PresentedBrowserSelection } from './presented-browser-selection.server';
import { readProviderSecurityAuthBody } from './provider-security-auth-body.server';
import {
  createProviderSecurityCommandClient,
  type ProviderSecurityCommandClient,
} from './provider-security-command-client.server';
import {
  assertProviderSecurityFlowSecret,
  captureProviderSecurityFlow,
  providerSecurityFlowCookieName,
  providerSecurityOperationKey,
  sealProviderSecurityFlow,
  type ProviderSecurityFlow,
} from './provider-security-flow.server';
import { providerSecurityCookieName, providerSecuritySessionFamily } from './provider-security-publication.server';
import { publicProviderSecurityReady } from './provider-security-readiness';
import { providerSecurityResumeLocaleSchema, providerSecurityResumeUrl } from './provider-security-resume';
import {
  captureProviderBrowserContext,
  requireProviderSecurityFlowActor,
  type ProviderBrowserContext,
} from './provider-security-selection.server';
import { webOAuthFlowHash } from './web-oauth-continuation.server';

const refuse = (): never => {
  throw new AuthBackendUnavailableError();
};
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const validNonce = (nonce: string | null): nonce is string => nonce !== null && /^[A-Za-z0-9_-]{1,1024}$/.test(nonce);
function protectedCookie(name: string): boolean {
  return (
    providerSecuritySessionFamily(name) ||
    name.startsWith(BROWSER_CORRELATION_COOKIE) ||
    name.startsWith(BROWSER_PROOF_COOKIE_PREFIX) ||
    name.startsWith('__Host-boardsesh.provider-security.')
  );
}

/** Request-local proof-only Google OAuth continuation. A STRING signIn result
 * exits installed NextAuth before its account adapter, JWT/session encoder or
 * signIn event. Only the backend's verified recent auth_time can mint evidence.
 * This does not mount a route or enable the public provider feature. */
export function createProviderSecurityGoogleReauthentication(
  base: NextAuthOptions,
  request: NextRequest,
  input: ProviderSecurityFlow,
  settings: {
    readonly locale?: unknown;
    readonly environment?: AuthServiceEnvironment;
    readonly ready?: () => boolean;
    readonly readSelection?: (cookies: string | null) => Promise<PresentedBrowserSelection>;
    readonly clientFactory?: () => ProviderSecurityCommandClient;
  } = {},
) {
  const environment = Object.freeze({ ...(settings.environment ?? process.env) });
  const ready = settings.ready ?? publicProviderSecurityReady;
  const readSelection =
    settings.readSelection ?? ((cookies) => readPresentedBrowserSelection(cookies, { environment }));
  const clientFactory = settings.clientFactory ?? (() => createProviderSecurityCommandClient({ environment }));
  const cookies = request.headers.get('cookie');
  const signal = request.signal;
  const requestUrl = new URL(request.url);
  const method = request.method;
  const flow = captureProviderSecurityFlow(input, new Date());
  const operationKey = providerSecurityOperationKey(flow.intentToken);
  const cookieName = providerSecurityFlowCookieName(operationKey, true);
  const origin = resolvePublicAuthOrigin(environment);
  const locale = providerSecurityResumeLocaleSchema.parse(settings.locale ?? 'en-US');
  if (!origin) return refuse();
  const returnUrl = providerSecurityResumeUrl(origin, operationKey, locale);
  const configured = base.providers.find((provider) => provider.id === 'google');
  if (!configured || configured.type !== 'oauth') return refuse();
  const clientId = configured.options?.clientId ?? configured.clientId;
  const clientSecret = configured.options?.clientSecret ?? configured.clientSecret;
  if (!clientId || !clientSecret) return refuse();
  const callback = method === 'GET' && requestUrl.pathname === '/api/auth/callback/google';
  const start = method === 'POST' && requestUrl.pathname === '/api/auth/signin/google';
  if ((!callback && !start) || flow.providerFlowHash !== null) return refuse();
  if (start && (flow.googleFlowHash !== null || flow.googleNonce !== null)) return refuse();
  if (callback) {
    const state = requestUrl.searchParams.getAll('state');
    if (
      state.length !== 1 ||
      !state[0] ||
      webOAuthFlowHash('google', state[0]) !== flow.googleFlowHash ||
      !validNonce(flow.googleNonce)
    )
      return refuse();
  }
  let current: ProviderBrowserContext | undefined;
  let stage: ProviderSecurityFlow | undefined;
  let stagedHeader: string | undefined;
  let quarantined: Response | undefined;
  let admissionCompleted = false;
  let failed = false;
  let running = false;
  let signInCalled = false;
  let startBound = false;
  const fail = (): never => {
    failed = true;
    return refuse();
  };
  const check = () => {
    if (
      failed ||
      signal.aborted ||
      Date.parse(flow.expiresAt) <= Date.now() ||
      (stage?.reauthenticationExpiresAt !== null &&
        stage?.reauthenticationExpiresAt !== undefined &&
        Date.parse(stage.reauthenticationExpiresAt) <= Date.now())
    )
      return fail();
  };
  const actor = () => {
    check();
    if (!running || !current) return fail();
    return current;
  };
  const requireCurrent = async () => {
    check();
    const selected = await readSelection(cookies);
    check();
    if (selected.status !== 'admitted') return fail();
    const captured = captureProviderBrowserContext(selected);
    requireProviderSecurityFlowActor(flow, captured);
    return captured;
  };
  const bound = () => ({
    actor: actor().actor,
    intentToken: flow.intentToken,
    browserIntentToken: flow.browserIntentToken,
  });
  const readonlyAdapter: Adapter = {
    async getUserByAccount(account) {
      actor();
      if (signInCalled || account.provider !== 'google' || !account.providerAccountId) return fail();
      return null;
    },
    getUser: async () => fail(),
    getUserByEmail: async () => fail(),
    createUser: async () => fail(),
    updateUser: async () => fail(),
    deleteUser: async () => fail(),
    linkAccount: async () => fail(),
    unlinkAccount: async () => fail(),
    createSession: async () => fail(),
    getSessionAndUser: async () => fail(),
    updateSession: async () => fail(),
    deleteSession: async () => fail(),
    createVerificationToken: async () => fail(),
    useVerificationToken: async () => fail(),
  };
  const options: NextAuthOptions = {
    ...base,
    providers: [
      {
        ...configured,
        checks: ['state', 'pkce', 'nonce'],
        idToken: true,
        allowDangerousEmailAccountLinking: false,
        options: {
          ...configured.options,
          clientId,
          clientSecret,
          checks: ['state', 'pkce', 'nonce'],
          idToken: true,
          allowDangerousEmailAccountLinking: false,
        },
      },
    ],
    adapter: readonlyAdapter,
    session: { ...base.session, strategy: 'jwt' },
    callbacks: {
      async signIn({ account, profile }) {
        actor();
        if (
          !callback ||
          signInCalled ||
          account?.type !== 'oauth' ||
          account.provider !== 'google' ||
          typeof account.id_token !== 'string' ||
          !account.id_token ||
          typeof profile?.sub !== 'string' ||
          profile.sub !== account.providerAccountId ||
          flow.googleFlowHash === null ||
          !validNonce(flow.googleNonce)
        )
          return fail();
        signInCalled = true;
        const result = await clientFactory().command('reauthenticate-google', {
          ...bound(),
          flowHash: flow.googleFlowHash,
          nonce: flow.googleNonce,
          idToken: account.id_token,
        });
        check();
        if (result.operation !== 'reauthenticate-google' || result.outcome !== 'proved') return fail();
        const deadline = Math.min(Date.parse(result.expiresAt), Date.parse(flow.expiresAt));
        if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 5 * 60_000)
          return fail();
        stage = {
          ...flow,
          reauthenticationToken: result.reauthenticationToken,
          reauthenticationExpiresAt: new Date(deadline).toISOString(),
        };
        // Returning true would enter NextAuth's account/session mutation path.
        return returnUrl;
      },
      redirect: async () => returnUrl,
      jwt: async () => fail(),
      session: async () => fail(),
    },
    jwt: { ...base.jwt, encode: async () => fail(), decode: async () => fail() },
    events: {
      createUser: async () => fail(),
      updateUser: async () => fail(),
      linkAccount: async () => fail(),
      signIn: async () => fail(),
      signOut: async () => fail(),
      session: async () => fail(),
    },
    logger: {
      error: () => {
        failed = true;
      },
      warn: () => {},
      debug: () => {},
    },
  };
  const validateResponse = async (response: Response) => {
    const body = await readProviderSecurityAuthBody(response);
    check();
    if (response.status < 200 || response.status >= 400 || response.headers.has('Content-Encoding')) return fail();
    const location = response.headers.get('Location');
    let destination = location;
    if (!destination && body !== null) {
      const json: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      if (
        typeof json !== 'object' ||
        json === null ||
        !('url' in json) ||
        typeof json.url !== 'string' ||
        'error' in json
      )
        return fail();
      destination = json.url;
    }
    if (!destination) return fail();
    if (callback) {
      if (!signInCalled || !stage || destination !== returnUrl) return fail();
    } else {
      const google = new URL(destination);
      if (
        !startBound ||
        !stage ||
        google.protocol !== 'https:' ||
        google.hostname !== 'accounts.google.com' ||
        google.port ||
        google.username ||
        google.password ||
        google.hash ||
        google.pathname !== '/o/oauth2/v2/auth' ||
        google.searchParams.getAll('state').length !== 1 ||
        webOAuthFlowHash('google', google.searchParams.get('state') ?? '') !== stage.googleFlowHash ||
        google.searchParams.getAll('nonce').length !== 1 ||
        google.searchParams.get('nonce') !== stage.googleNonce
      )
        return fail();
    }
    return body;
  };
  return Object.freeze({
    options,
    returnUrl,
    async bindStart(value: {
      readonly provider: string;
      readonly state: string;
      readonly flowHash: string;
      readonly response: Response;
    }): Promise<Response> {
      const provider = value.provider;
      const state = value.state;
      const flowHash = value.flowHash;
      const response = value.response;
      actor();
      if (!start || startBound || provider !== 'google' || webOAuthFlowHash('google', state) !== flowHash)
        return fail();
      startBound = true;
      const copy = response.clone();
      const body = await readProviderSecurityAuthBody(copy);
      const decoded: unknown =
        copy.headers.has('Location') || body === null
          ? null
          : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      const destination =
        copy.headers.get('Location') ??
        (typeof decoded === 'object' && decoded !== null && 'url' in decoded && typeof decoded.url === 'string'
          ? decoded.url
          : null);
      if (!destination) return fail();
      const url = new URL(destination);
      const nonce = url.searchParams.getAll('nonce');
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'accounts.google.com' ||
        url.port ||
        url.username ||
        url.password ||
        url.hash ||
        url.searchParams.getAll('state').length !== 1 ||
        url.searchParams.get('state') !== state ||
        nonce.length !== 1 ||
        !validNonce(nonce[0])
      )
        return fail();
      const result = await clientFactory().command('bind-google-reauthentication', {
        ...bound(),
        flowHash,
        nonceHash: sha256(nonce[0]),
      });
      check();
      if (result.operation !== 'bind-google-reauthentication' || result.outcome !== 'bound') return fail();
      stage = { ...flow, googleFlowHash: flowHash, googleNonce: nonce[0] };
      return response;
    },
    quarantine(response: Response): Response {
      actor();
      if (quarantined) return fail();
      const headers = new Headers(response.headers);
      headers.delete('Set-Cookie');
      for (const header of response.headers.getSetCookie()) {
        const name = providerSecurityCookieName(header);
        if (protectedCookie(name)) return fail();
        headers.append('Set-Cookie', header);
      }
      quarantined = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      return quarantined;
    },
    acknowledgeAdmission(response: Response): void {
      actor();
      if (!quarantined || response !== quarantined || admissionCompleted) return fail();
      admissionCompleted = true;
    },
    async run(invoke: (selectedOptions: NextAuthOptions) => Promise<Response>): Promise<Response> {
      if (running) return unavailableCredentialResponse();
      running = true;
      try {
        if (
          !ready() ||
          providerSecurityMode(environment) !== 'backend-staging' ||
          browserBindingMode(environment) !== 'backend-staging'
        )
          return unavailableCredentialResponse();
        assertProviderSecurityFlowSecret(environment.NEXTAUTH_SECRET ?? '');
        current = await requireCurrent();
        const returned = await invoke(options);
        // Wrappers may retain their Response reference. Copy every public field
        // once before buffering/admission awaits, and publish only this snapshot.
        const response = new Response(returned.body, {
          status: returned.status,
          statusText: returned.statusText,
          headers: new Headers(returned.headers),
        });
        if (!quarantined || !admissionCompleted) return fail();
        if (response.headers.getSetCookie().some((header) => protectedCookie(providerSecurityCookieName(header))))
          return fail();
        const body = await validateResponse(response);
        await requireCurrent();
        if (!stage) return fail();
        stagedHeader = stringifySetCookie({
          name: cookieName,
          value: await sealProviderSecurityFlow(stage, environment.NEXTAUTH_SECRET ?? ''),
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          path: '/',
          expires: new Date(flow.expiresAt),
        });
        check();
        // Keep every observed actor/operation cookie; no garbage collection or
        // synthetic omission can make this header fit before proof publication.
        if (
          Buffer.byteLength(cookies ?? '') > 32_768 ||
          Buffer.byteLength(`${cookies ?? ''}; ${stagedHeader.split(';', 1)[0]}`) > 8192 ||
          Buffer.byteLength(stagedHeader) > 4096
        )
          return fail();
        const headers = new Headers(response.headers);
        headers.delete('Content-Length');
        headers.append('Set-Cookie', stagedHeader);
        headers.set('Cache-Control', 'private, no-store');
        headers.set('Referrer-Policy', 'no-referrer');
        headers.set('X-Robots-Tag', 'noindex, follow');
        let headerBytes = 0;
        let headerCount = 0;
        headers.forEach((content, name) => {
          headerBytes += Buffer.byteLength(`${name}: ${content}\r\n`);
          headerCount += 1;
        });
        if (headerBytes > 32_768 || headerCount + headers.getSetCookie().length > 32) return fail();
        return new Response(body, { status: response.status, statusText: response.statusText, headers });
      } catch {
        return unavailableCredentialResponse();
      }
    },
  });
}
