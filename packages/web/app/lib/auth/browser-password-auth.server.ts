import 'server-only';
import NextAuth, { type NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { decode, encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { parseSetCookie } from 'cookie';
import { withPartnerSignInFailureReturn } from '@/app/lib/partner-oauth/sign-in-failure-return';
import type { BrowserSourceCredential } from '@boardsesh/auth-protocol/browser-binding-v1';
import type { BrowserPasswordReply } from '@boardsesh/auth-protocol/browser-password-v1';
import type { WebCredentialProof } from '@boardsesh/auth-protocol';
import { AuthBackendUnavailableError, type AuthServiceEnvironment } from './auth-command-transport.server';
import { withAuthResponseAdmission } from './auth-response-admission.server';
import { isAllowedAppOrigin } from './app-origin-allowlist';
import { readSettledPasswordBody } from './browser-password-body.server';
import { cancelSettledPasswordBody } from './browser-password-body';
import { browserPasswordPendingCookieName } from './browser-password-custody.server';
import type { BrowserPasswordCommandClient } from './browser-password-command-client.server';
import {
  captureBrowserPasswordSource,
  requirePreparedPasswordSource,
  requireSameBrowserPasswordSource,
  type BrowserPasswordSourceContext,
} from './browser-password-selection.server';
import { readPresentedBrowserSelection, type PresentedBrowserSelection } from './presented-browser-selection.server';
import {
  providerCookieFamily,
  providerFrameworkCandidate,
  providerFrameworkProtectedCookie,
} from './provider-framework-cookies.server';

type Prepared = Extract<BrowserPasswordReply, { operation: 'prepare'; outcome: 'prepared' }>;
type AuthRouteContext = { params: Promise<{ nextauth: string[] }> };
type InstalledHandler = (request: NextRequest, context: AuthRouteContext) => Promise<Response>;
export type PasswordFrameworkPreparation =
  | {
      readonly status: 'prepared';
      readonly prepared: Prepared;
      readonly candidate: BrowserSourceCredential;
      readonly destination: string;
    }
  | { readonly status: 'framework-result'; readonly destination: string; readonly responseStatus: number };
const refuse = (): never => {
  throw new AuthBackendUnavailableError();
};
function claimsMatch(claims: Record<string, unknown>, proof: WebCredentialProof): boolean {
  return (
    claims.sub === proof.userId &&
    claims.authSessionId === proof.authSessionId &&
    claims.gen === proof.generation &&
    proof.authenticatedAt !== null &&
    claims.auth_time === Date.parse(proof.authenticatedAt) / 1_000 &&
    claims.link_guarded === true &&
    claims.legacy_no_sid === undefined
  );
}

/** Request-local actual installed CredentialsProvider path. Its only cookie
 * family is unpublished; source admission sees a cookie-free quarantined body. */
export function createBrowserPasswordAuthPreparation(
  base: NextAuthOptions,
  request: NextRequest,
  input: {
    readonly source: BrowserPasswordSourceContext;
    readonly operationKey: string;
    readonly canonicalOrigin: string;
    readonly email: string;
    readonly password: string;
    readonly credentialKind: 'legacy-jwe' | 'canonical-token';
  },
  settings: {
    readonly client: BrowserPasswordCommandClient;
    readonly environment: AuthServiceEnvironment;
    readonly passwordAccepted: () => void;
    readonly readSelection?: (header: string | null) => Promise<PresentedBrowserSelection>;
    readonly invoke?: (request: NextRequest, context: AuthRouteContext, options: NextAuthOptions) => Promise<Response>;
  },
) {
  const environment = Object.freeze({ ...settings.environment });
  const source = input.source;
  const cookieHeader = request.headers.get('cookie');
  const pendingName = browserPasswordPendingCookieName(input.operationKey);
  const client = settings.client;
  const readSelection = settings.readSelection ?? ((header) => readPresentedBrowserSelection(header, { environment }));
  const secret = environment.NEXTAUTH_SECRET;
  const encoder = base.jwt?.encode ?? encode;
  const callback = base.callbacks?.jwt;
  const event = base.events?.signIn;
  let prepared: Prepared | undefined;
  let candidate: BrowserSourceCredential | undefined;
  let failed = false,
    started = false,
    aborted = false,
    authorized = 0,
    signedIn = 0,
    encoded = 0,
    notified = 0;
  let quarantined: Response | undefined, acknowledged: Response | undefined;
  let frameworkDestination: string | undefined;
  const fail = (): never => {
    failed = true;
    return refuse();
  };
  const check = () => {
    if (
      failed ||
      request.signal.aborted ||
      !Number.isSafeInteger(Date.now()) ||
      Date.now() >=
        Math.min(
          Date.parse(source.cursor.bindingExpiresAt),
          source.session ? Date.parse(source.session.expiresAt) : Infinity,
          prepared ? Date.parse(prepared.preparation.expiresAt) : Infinity,
        )
    )
      return fail();
  };
  if (
    !secret ||
    secret.trim() !== secret ||
    Buffer.byteLength(secret) < 32 ||
    (base.secret !== undefined && base.secret !== secret) ||
    base.session?.strategy !== 'jwt' ||
    !callback ||
    (cookieHeader ?? '').split(';').some((pair) => providerCookieFamily(pair.trim().split('=', 1)[0], pendingName))
  )
    return fail();
  const options: NextAuthOptions = {
    ...base,
    adapter: undefined,
    secret,
    debug: false,
    cookies: {
      ...base.cookies,
      sessionToken: { name: pendingName, options: { path: '/', httpOnly: true, secure: true, sameSite: 'lax' } },
    },
    providers: [
      CredentialsProvider({
        name: 'Email',
        credentials: { email: { type: 'email' }, password: { type: 'password' } },
        async authorize(credentials) {
          check();
          if (++authorized !== 1 || credentials?.email !== input.email || credentials.password !== input.password)
            return fail();
          let reply: Awaited<ReturnType<BrowserPasswordCommandClient['prepare']>>;
          try {
            reply = await client.prepare({
              source: source.source,
              email: input.email,
              password: input.password,
              credentialKind: input.credentialKind,
              nonceHash: input.operationKey,
            });
          } catch {
            return fail();
          }
          if (reply.outcome === 'invalid_credentials') return null;
          if (reply.operation !== 'prepare' || reply.outcome !== 'prepared') return fail();
          prepared = reply;
          settings.passwordAccepted();
          requirePreparedPasswordSource(reply.preparation, source);
          check();
          return { ...reply.user, webCredentialProof: Object.freeze({ ...reply.preparation.credentialProof }) };
        },
      }),
    ],
    callbacks: {
      ...base.callbacks,
      async signIn(parameters) {
        check();
        if (
          ++signedIn !== 1 ||
          !prepared ||
          parameters.account?.provider !== 'credentials' ||
          parameters.account.type !== 'credentials' ||
          parameters.user.id !== prepared.user.id
        )
          return fail();
        return prepared.preparation.verification.required && !prepared.preparation.verification.verified
          ? '/auth/verify-request?error=EmailNotVerified'
          : true;
      },
      async jwt(parameters) {
        check();
        if (!prepared || parameters.account?.provider !== 'credentials' || parameters.user?.id !== prepared.user.id)
          return fail();
        let claims: Awaited<ReturnType<NonNullable<NonNullable<NextAuthOptions['callbacks']>['jwt']>>>;
        try {
          claims = await callback(parameters);
        } catch {
          return fail();
        }
        check();
        if (!claimsMatch(claims, prepared.preparation.credentialProof)) return fail();
        return claims;
      },
      session: async () => fail(),
    },
    jwt: {
      ...base.jwt,
      async encode(parameters) {
        check();
        if (
          ++encoded !== 1 ||
          !prepared ||
          !parameters.token ||
          parameters.secret !== secret ||
          !claimsMatch(parameters.token, prepared.preparation.credentialProof)
        )
          return fail();
        const expiry = Date.parse(prepared.preparation.credentialExpiresAt) / 1_000;
        if (!Number.isSafeInteger(expiry)) return fail();
        let credential: string;
        if (input.credentialKind === 'canonical-token') {
          const proposal = prepared.proposedCanonicalToken;
          if (!proposal || !/^[A-Za-z0-9_-]{43}$/.test(proposal)) return fail();
          credential = proposal;
        } else {
          const maxAge = expiry - Math.floor(Date.now() / 1_000);
          if (maxAge <= 0) return fail();
          credential = await encoder({ ...parameters, maxAge });
          const actual = await decode({ token: credential, secret: parameters.secret, salt: parameters.salt });
          if (!actual || actual.exp !== expiry || !claimsMatch(actual, prepared.preparation.credentialProof))
            return fail();
        }
        check();
        if (!credential || Buffer.byteLength(credential) > 16_384) return fail();
        candidate = Object.freeze(
          input.credentialKind === 'canonical-token'
            ? { kind: input.credentialKind, token: credential }
            : { kind: input.credentialKind, credential },
        );
        return credential;
      },
    },
    events: {
      createUser: async () => fail(),
      updateUser: async () => fail(),
      linkAccount: async () => fail(),
      session: async () => fail(),
      async signIn(parameters) {
        check();
        if (
          ++notified !== 1 ||
          !prepared ||
          !candidate ||
          parameters.user.id !== prepared.user.id ||
          parameters.account?.provider !== 'credentials'
        )
          return fail();
        try {
          await event?.({ ...parameters, isNewUser: false });
        } catch {
          return fail();
        }
        check();
      },
    },
    logger: {
      error: () => {
        failed = true;
      },
      warn() {},
      debug() {},
    },
  };
  async function abort() {
    if (!prepared || aborted) return;
    aborted = true;
    await client
      .abort({
        source: source.source,
        operationToken: prepared.operationToken,
        browserIntentToken: prepared.browserIntentToken,
        preparation: prepared.preparation,
      })
      .catch(() => undefined);
  }
  async function quarantine(response: Response): Promise<Response> {
    const ownedResponses = new Set<Response>([response]);
    try {
      check();
      const rawHeaders = response.headers.getSetCookie();
      if (rawHeaders.length > 24 || rawHeaders.reduce((total, header) => total + Buffer.byteLength(header), 0) > 32_768)
        return fail();
      for (const header of rawHeaders) {
        const name = parseSetCookie(header).name;
        if (providerFrameworkProtectedCookie(name) && !providerCookieFamily(name, pendingName)) return fail();
      }
      const pending = rawHeaders.filter((header) => providerCookieFamily(parseSetCookie(header).name, pendingName));
      if (
        candidate &&
        providerFrameworkCandidate(pending, pendingName) !==
          (candidate.kind === 'canonical-token' ? candidate.token : candidate.credential)
      )
        return fail();
      if (!candidate && pending.some((header) => Boolean(parseSetCookie(header).value))) return fail();
      const rawBytes = await readSettledPasswordBody(response.body, request.signal, 16_384);
      check();
      // Decorators see only a fully settled, bounded framework body. Freeze the
      // finished destination before candidate custody or any durable publication.
      const buffered = new Response(rawBytes, { status: response.status, headers: response.headers });
      ownedResponses.add(buffered);
      const decorated = await withPartnerSignInFailureReturn(request, buffered);
      ownedResponses.add(decorated);
      const bytes = await readSettledPasswordBody(decorated.body, request.signal, 16_384);
      check();
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        return fail();
      }
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !('url' in body) ||
        typeof body.url !== 'string' ||
        body.url.length > 4_096
      )
        return fail();
      const destination = new URL(body.url, input.canonicalOrigin);
      if (
        destination.protocol !== 'https:' ||
        destination.username ||
        destination.password ||
        destination.hash ||
        (destination.origin !== input.canonicalOrigin && !isAllowedAppOrigin(destination.origin))
      )
        return fail();
      frameworkDestination = destination.href;
      const headers = new Headers(decorated.headers);
      headers.delete('Set-Cookie');
      quarantined = new Response(bytes, { status: response.status, statusText: response.statusText, headers });
      return quarantined;
    } finally {
      // Own the installed body before the first clock/header check. Even an
      // already-aborted or invalid response keeps preparation pending until
      // its disposal settles; secondary cancel errors never replace refusal.
      for (const owned of ownedResponses) await cancelSettledPasswordBody(owned.body);
    }
  }
  return Object.freeze({
    options,
    abort,
    async run(): Promise<PasswordFrameworkPreparation> {
      if (started) return fail();
      started = true;
      try {
        check();
        const context: AuthRouteContext = { params: Promise.resolve({ nextauth: ['callback', 'credentials'] }) };
        const invoke =
          settings.invoke ??
          ((current, route, configured) => (NextAuth(configured) as InstalledHandler)(current, route));
        const complete = (response: Response) => {
          if (response !== quarantined) return fail();
          acknowledged = response;
        };
        const response = await withAuthResponseAdmission(
          request,
          context,
          async () => quarantine(await invoke(request, context, options)),
          source.session ? complete : undefined,
          undefined,
          source.session
            ? undefined
            : { purpose: 'password-prepare', canonicalOrigin: input.canonicalOrigin, cursor: source.cursor, complete },
        );
        check();
        if (response !== quarantined || response !== acknowledged || !frameworkDestination) return fail();
        const again = captureBrowserPasswordSource(cookieHeader, await readSelection(cookieHeader));
        requireSameBrowserPasswordSource(source, again);
        check();
        if (!candidate) {
          if (prepared && (!prepared.preparation.verification.required || prepared.preparation.verification.verified))
            return fail();
          await abort();
          return Object.freeze({
            status: 'framework-result',
            destination: frameworkDestination,
            responseStatus: response.status,
          });
        }
        if (
          !prepared ||
          authorized !== 1 ||
          signedIn !== 1 ||
          encoded !== 1 ||
          notified !== 1 ||
          response.status !== 200
        )
          return fail();
        return Object.freeze({ status: 'prepared', prepared, candidate, destination: frameworkDestination });
      } catch {
        await abort();
        return fail();
      }
    },
  });
}
