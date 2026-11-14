import 'server-only';
import { decode, encode } from 'next-auth/jwt';
import type { NextAuthOptions } from 'next-auth';
import type { Adapter, AdapterUser } from 'next-auth/adapters';
import type { NextRequest } from 'next/server';
import { stringifySetCookie } from 'cookie';
import { anonymousProviderPreparationSchema } from '@boardsesh/auth-protocol';
import type { AuthServiceEnvironment } from '@boardsesh/auth-protocol/transport';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { unavailableCredentialResponse } from './credential-admission-response.server';
import { readPresentedBrowserSelection, type PresentedBrowserSelection } from './presented-browser-selection.server';
import { readProviderSecurityAuthBody } from './provider-security-auth-body.server';
import { requireProviderCookieCapacity } from './provider-cookie-capacity.server';
import {
  createAnonymousProviderCommandClient,
  type AnonymousProviderCommandClient,
  type AnonymousProviderOperationReply,
} from './anonymous-provider-command-client.server';
import {
  anonymousProviderFlowSchema,
  anonymousProviderFlowCookieName,
  anonymousProviderPendingCookieName,
  captureAnonymousProviderBrowserContext,
  requireAnonymousProviderBrowser,
  sealAnonymousProviderFlow,
  type AnonymousProviderBrowserContext,
  type AnonymousProviderFlow,
} from './anonymous-provider-flow.server';
import { providerOwnedSigninNonceHash } from './provider-owned-signin-flow.server';
import { providerCandidateCredentialHash } from './provider-security-command-client.server';
import {
  providerCookieFamily,
  providerFrameworkCandidate,
  providerFrameworkProtectedCookie,
} from './provider-framework-cookies.server';
import {
  prepareProviderSecurityPublicationResponse,
  providerSecurityClaimsMatch,
  providerSecurityCookieName,
  sameProviderSecurityCursor,
  type PrepareProviderSecurityCookies,
  type ProviderSecurityCandidate,
} from './provider-security-publication.server';

type Prepared = Extract<AnonymousProviderOperationReply<'prepare'>, { outcome: 'prepared' }>;
const refuse = (): never => {
  throw new AuthBackendUnavailableError();
};

/** Installed NextAuth verifies the provider; its account/session adapter is
 * read-only. Only the backend preparation fixes the identity and credential. */
export function createAnonymousProviderAuthPublication(
  base: NextAuthOptions,
  request: NextRequest,
  input: AnonymousProviderFlow,
  browserInput: AnonymousProviderBrowserContext,
  settings: {
    readonly prepareCookiePublication: PrepareProviderSecurityCookies;
    readonly environment?: AuthServiceEnvironment;
    readonly clientFactory?: () => AnonymousProviderCommandClient;
    readonly readSelection?: (cookies: string | null) => Promise<PresentedBrowserSelection>;
  },
) {
  const flow = anonymousProviderFlowSchema.parse(input);
  const current = Object.freeze({
    browser: Object.freeze({ ...browserInput.browser }),
    cursor: Object.freeze({ ...browserInput.cursor }),
  });
  requireAnonymousProviderBrowser(flow, current);
  const environment = Object.freeze({ ...(settings.environment ?? process.env) });
  const cookieHeader = request.headers.get('cookie');
  const signal = request.signal;
  const pendingName = anonymousProviderPendingCookieName(flow.flowHash);
  const configured = base.providers.find((provider) => (provider.options?.id ?? provider.id) === flow.provider);
  const clientId = configured?.type === 'oauth' ? (configured.options?.clientId ?? configured.clientId) : undefined;
  const clientSecret =
    configured?.type === 'oauth' ? (configured.options?.clientSecret ?? configured.clientSecret) : undefined;
  const encoder = base.jwt?.encode ?? encode;
  const jwtCallback = base.callbacks?.jwt;
  const signInEvent = base.events?.signIn;
  const readSelection =
    settings.readSelection ?? ((cookies) => readPresentedBrowserSelection(cookies, { environment }));
  const client = (settings.clientFactory ?? (() => createAnonymousProviderCommandClient({ environment })))();
  if (
    !base.adapter ||
    base.session?.strategy !== 'jwt' ||
    configured?.type !== 'oauth' ||
    !clientId ||
    !clientSecret ||
    flow.preparation !== null ||
    flow.preparationToken !== null ||
    (flow.provider === 'google' ? !flow.nonce : flow.nonce !== null) ||
    typeof settings.prepareCookiePublication !== 'function' ||
    (cookieHeader ?? '').split(';').some((piece) => providerCookieFamily(piece.trim().split('=', 1)[0], pendingName))
  )
    return refuse();
  const bound = Object.freeze({
    browser: current.browser,
    intentToken: flow.intentToken,
    browserIntentToken: flow.browserIntentToken,
    flowHash: flow.flowHash,
    nonceHash: providerOwnedSigninNonceHash(flow.nonce),
  });
  let prepared: Prepared | undefined;
  let candidate: ProviderSecurityCandidate | undefined;
  let signInCalled = false;
  let started = false;
  let failed = false;
  let finalizationStarted = false;
  let quarantined: Response | undefined;
  let acknowledged = false;
  const fail = (): never => {
    failed = true;
    return refuse();
  };
  const check = () => {
    if (
      failed ||
      signal.aborted ||
      Date.now() >=
        Math.min(
          Date.parse(flow.expiresAt),
          Date.parse(flow.browserBindingExpiresAt),
          prepared ? Date.parse(prepared.preparation.expiresAt) : Infinity,
          prepared ? Date.parse(prepared.preparation.credentialExpiresAt) : Infinity,
        )
    )
      return fail();
  };
  async function requireOriginalAnonymous() {
    check();
    const selection = await readSelection(cookieHeader);
    check();
    requireAnonymousProviderBrowser(flow, captureAnonymousProviderBrowserContext(cookieHeader, selection));
  }
  const user = (): AdapterUser => {
    if (!prepared) return fail();
    const stored = prepared.preparation.identityPlan.user;
    return { ...stored, emailVerified: stored.emailVerified === null ? null : new Date(stored.emailVerified) };
  };
  const readonlyAdapter: Adapter = {
    async getUserByAccount(account) {
      check();
      if (account.provider !== flow.provider || !account.providerAccountId) return fail();
      if (!prepared) return null;
      if (account.providerAccountId !== prepared.preparation.identityPlan.subject) return fail();
      return user();
    },
    getUser: async (id) => (prepared && id === prepared.preparation.identityPlan.user.id ? user() : fail()),
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
    adapter: readonlyAdapter,
    debug: false,
    cookies: {
      ...base.cookies,
      sessionToken: { name: pendingName, options: { secure: true, httpOnly: true, sameSite: 'lax', path: '/' } },
    },
    providers: [
      {
        ...configured,
        allowDangerousEmailAccountLinking: false,
        ...(flow.provider === 'google' ? { checks: ['state', 'pkce', 'nonce'], idToken: true } : {}),
        options: {
          ...configured.options,
          clientId,
          clientSecret,
          allowDangerousEmailAccountLinking: false,
          ...(flow.provider === 'google' ? { checks: ['state', 'pkce', 'nonce'], idToken: true } : {}),
        },
      },
    ],
    callbacks: {
      ...base.callbacks,
      async signIn({ account, profile, user: providerUser }) {
        check();
        if (
          signInCalled ||
          account?.type !== 'oauth' ||
          account.provider !== flow.provider ||
          !account.providerAccountId ||
          typeof profile?.sub !== 'string' ||
          profile.sub !== account.providerAccountId ||
          (flow.provider === 'google' && (!flow.nonce || typeof account.id_token !== 'string'))
        )
          return fail();
        signInCalled = true;
        const verified = profile && 'email_verified' in profile ? profile.email_verified : undefined;
        const reply = await client.command('prepare', {
          ...bound,
          credentialKind: flow.credentialKind,
          providerProof: {
            provider: flow.provider,
            identity: {
              sub: account.providerAccountId,
              email: typeof providerUser.email === 'string' ? providerUser.email : null,
              emailVerified: verified === true || verified === 'true',
              name: typeof providerUser.name === 'string' ? providerUser.name : null,
              image: typeof providerUser.image === 'string' ? providerUser.image : null,
            },
            idToken: flow.provider === 'google' ? account.id_token! : null,
            nonce: flow.provider === 'google' ? flow.nonce : null,
          },
        });
        check();
        if (reply.outcome !== 'prepared') return fail();
        const target = anonymousProviderPreparationSchema.parse(reply.preparation);
        if (
          target.credentialKind !== flow.credentialKind ||
          target.identityPlan.provider !== flow.provider ||
          target.identityPlan.subject !== account.providerAccountId ||
          target.credentialProof.userId !== target.identityPlan.user.id ||
          target.credentialProof.generation !== target.identityPlan.generation ||
          target.credentialProof.requiresAccountCutoff ||
          !sameProviderSecurityCursor(current.cursor, reply.browserCursor) ||
          Date.parse(target.credentialExpiresAt) > Date.parse(flow.browserBindingExpiresAt) ||
          Date.parse(target.expiresAt) > Date.parse(flow.expiresAt) ||
          Date.parse(target.expiresAt) > Date.parse(target.credentialExpiresAt) ||
          (flow.provider === 'apple' &&
            (target.credentialProof.authenticatedAt !== null || target.credentialProof.linkGuarded)) ||
          (reply.proposedCanonicalToken !== null) !== (flow.credentialKind === 'canonical-token') ||
          (reply.proposedCanonicalToken === null
            ? target.proposedCanonicalTokenHash !== null
            : target.proposedCanonicalTokenHash !==
              providerCandidateCredentialHash({ kind: 'canonical-token', credential: reply.proposedCanonicalToken }))
        )
          return fail();
        prepared = Object.freeze({
          ...reply,
          preparation: target,
          browserCursor: Object.freeze({ ...reply.browserCursor }),
        });
        return true;
      },
      redirect: async () => flow.returnUrl,
      async jwt(parameters) {
        check();
        if (!prepared || parameters.user?.id !== prepared.preparation.identityPlan.user.id) return fail();
        const claims = jwtCallback
          ? await jwtCallback({
              ...parameters,
              isNewUser: undefined,
              user: { ...parameters.user, webCredentialProof: prepared.preparation.credentialProof },
            })
          : parameters.token;
        delete claims.nativeOAuthCreationProof;
        if (!providerSecurityClaimsMatch(claims, prepared.preparation.credentialProof)) return fail();
        return claims;
      },
      session: async () => fail(),
    },
    jwt: {
      ...base.jwt,
      async encode(parameters) {
        check();
        if (
          !prepared ||
          !parameters.token ||
          !providerSecurityClaimsMatch(parameters.token, prepared.preparation.credentialProof)
        )
          return fail();
        const target = prepared.preparation;
        let credential: string;
        if (flow.credentialKind === 'canonical-token') {
          if (!prepared.proposedCanonicalToken || !/^[A-Za-z0-9_-]{43}$/.test(prepared.proposedCanonicalToken))
            return fail();
          credential = prepared.proposedCanonicalToken;
        } else {
          const seconds = Date.parse(target.credentialExpiresAt) / 1000;
          const maxAge = seconds - Math.floor(Date.now() / 1000);
          if (!Number.isSafeInteger(seconds) || maxAge <= 0) return fail();
          credential = await encoder({ ...parameters, maxAge });
          const actual = await decode({ token: credential, secret: parameters.secret, salt: parameters.salt });
          if (!actual || actual.exp !== seconds || !providerSecurityClaimsMatch(actual, target.credentialProof))
            return fail();
        }
        check();
        if (!credential || Buffer.byteLength(credential) > 16_384) return fail();
        candidate = Object.freeze({ kind: flow.credentialKind, credential });
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
          !prepared ||
          parameters.user.id !== prepared.preparation.identityPlan.user.id ||
          parameters.account?.provider !== flow.provider ||
          parameters.account.providerAccountId !== prepared.preparation.identityPlan.subject
        )
          return fail();
        try {
          await signInEvent?.({ ...parameters, isNewUser: false });
        } catch {
          return fail();
        }
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
    if (finalizationStarted) return;
    await client
      .command('abort', {
        ...bound,
        credentialKind: flow.credentialKind,
        preparationToken: prepared?.preparationToken ?? null,
        preparation: prepared?.preparation ?? null,
      })
      .catch(() => undefined);
  }
  return Object.freeze({
    options,
    quarantine(response: Response): Response {
      check();
      if (quarantined) return fail();
      const headers = new Headers(response.headers);
      headers.delete('Set-Cookie');
      const pending: string[] = [];
      for (const header of response.headers.getSetCookie()) {
        const name = providerSecurityCookieName(header);
        if (providerCookieFamily(name, pendingName)) pending.push(header);
        else if (providerFrameworkProtectedCookie(name)) return fail();
        else headers.append('Set-Cookie', header);
      }
      if (
        prepared
          ? !candidate || providerFrameworkCandidate(pending, pendingName) !== candidate.credential
          : pending.length !== 0
      )
        return fail();
      quarantined = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      return quarantined;
    },
    acknowledgeAdmission(response: Response) {
      if (
        acknowledged ||
        response !== quarantined ||
        response.headers
          .getSetCookie()
          .some((header) => providerFrameworkProtectedCookie(providerSecurityCookieName(header)))
      )
        return fail();
      acknowledged = true;
    },
    async run(invoke: () => Promise<Response>): Promise<Response> {
      if (started) return unavailableCredentialResponse();
      started = true;
      try {
        await requireOriginalAnonymous();
        const returned = await invoke();
        const headers = new Headers(returned.headers);
        const status = returned.status;
        const statusText = returned.statusText;
        check();
        if (
          !acknowledged ||
          !quarantined ||
          !prepared ||
          !candidate ||
          headers.has('Content-Encoding') ||
          headers.getSetCookie().some((header) => providerFrameworkProtectedCookie(providerSecurityCookieName(header)))
        )
          return fail();
        const body = await readProviderSecurityAuthBody(returned);
        let destination = headers.get('Location');
        if (status === 200 && /^application\/json(?:\s*;|$)/i.test(headers.get('Content-Type') ?? '')) {
          const parsed: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(body ?? new Uint8Array()),
          );
          if (
            !parsed ||
            typeof parsed !== 'object' ||
            Array.isArray(parsed) ||
            Object.keys(parsed).length !== 1 ||
            !('url' in parsed) ||
            typeof parsed.url !== 'string'
          )
            return fail();
          destination = parsed.url;
        } else if ((status !== 302 && status !== 303) || (body?.byteLength ?? 0) !== 0) return fail();
        if (destination !== flow.returnUrl) return fail();
        await requireOriginalAnonymous();
        const staged: AnonymousProviderFlow = {
          ...flow,
          preparationToken: prepared.preparationToken,
          preparation: prepared.preparation,
          expiresAt: new Date(
            Math.min(Date.parse(flow.expiresAt), Date.parse(prepared.preparation.expiresAt)),
          ).toISOString(),
        };
        const sealed = await sealAnonymousProviderFlow(staged, environment.NEXTAUTH_SECRET ?? '');
        check();
        headers.append(
          'Set-Cookie',
          stringifySetCookie({
            name: anonymousProviderFlowCookieName(flow.flowHash),
            value: sealed,
            path: '/',
            secure: true,
            httpOnly: true,
            sameSite: 'lax',
            expires: new Date(staged.expiresAt),
          }),
        );
        const publication = prepareProviderSecurityPublicationResponse({
          candidate,
          cursor: Object.freeze({ ...current.cursor, version: current.cursor.version + 1 }),
          credentialExpiresAt: prepared.preparation.credentialExpiresAt,
          preparationExpiresAt: staged.expiresAt,
          frameworkHeaders: [],
          prepareCookiePublication: settings.prepareCookiePublication,
          response: { status, statusText, headers, body },
        });
        requireProviderCookieCapacity(cookieHeader, publication.response.headers);
        check();
        finalizationStarted = true;
        const result = await client.command('finalize', {
          ...bound,
          preparationToken: prepared.preparationToken,
          preparation: prepared.preparation,
          candidate,
        });
        if (
          result.outcome !== 'committed' ||
          result.candidateCredentialHash !== publication.plan.candidateCredentialHash ||
          !sameProviderSecurityCursor(result.browserCursor, publication.plan.cursor)
        )
          return unavailableCredentialResponse();
        return publication.response;
      } catch {
        await abort();
        return unavailableCredentialResponse();
      }
    },
  });
}
