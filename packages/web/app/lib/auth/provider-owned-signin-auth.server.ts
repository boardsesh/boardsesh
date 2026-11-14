import 'server-only';
import { decode, encode } from 'next-auth/jwt';
import type { NextAuthOptions } from 'next-auth';
import type { Adapter, AdapterUser } from 'next-auth/adapters';
import type { NextRequest } from 'next/server';
import { stringifySetCookie } from 'cookie';
import {
  providerOwnedSigninPreparationSchema,
  webCredentialProofSchema,
  type ProviderSecurityReply,
} from '@boardsesh/auth-protocol';
import type { AuthServiceEnvironment } from '@boardsesh/auth-protocol/transport';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { requireProviderCookieCapacity } from './provider-cookie-capacity.server';
import { unavailableCredentialResponse } from './credential-admission-response.server';
import { readPresentedBrowserSelection, type PresentedBrowserSelection } from './presented-browser-selection.server';
import { readProviderSecurityAuthBody } from './provider-security-auth-body.server';
import {
  createProviderSecurityCommandClient,
  providerCandidateCredentialHash,
  type ProviderSecurityCommandClient,
} from './provider-security-command-client.server';
import {
  providerOwnedSigninFlowSchema,
  providerOwnedSigninCookieName,
  providerOwnedSigninNonceHash,
  providerOwnedSigninPendingCookieName,
  requireProviderOwnedSigninActor,
  sealProviderOwnedSigninFlow,
  type ProviderOwnedSigninFlow,
} from './provider-owned-signin-flow.server';
import {
  prepareProviderSecurityPublicationResponse,
  providerSecurityClaimsMatch,
  providerSecurityCookieName,
  sameProviderSecurityCursor,
  type PrepareProviderSecurityCookies,
  type ProviderSecurityCandidate,
} from './provider-security-publication.server';
import { captureProviderBrowserContext, type ProviderBrowserContext } from './provider-security-selection.server';
import {
  providerCookieFamily as family,
  providerFrameworkProtectedCookie as protectedCookie,
  providerFrameworkCandidate as emittedCandidate,
} from './provider-framework-cookies.server';

type Prepared = Extract<ProviderSecurityReply, { operation: 'signin-prepare'; outcome: 'prepared' }>;
const refuse = (): never => {
  throw new AuthBackendUnavailableError();
};
function sameProof(
  left: ProviderBrowserContext['sourceCredentialProof'],
  right: ProviderBrowserContext['sourceCredentialProof'],
) {
  return (
    left.userId === right.userId &&
    left.authSessionId === right.authSessionId &&
    left.generation === right.generation &&
    left.authenticatedAt === right.authenticatedAt &&
    left.linkGuarded === right.linkGuarded &&
    Boolean(left.requiresAccountCutoff) === Boolean(right.requiresAccountCutoff)
  );
}

/** A request-local owned-account login, distinct from linking and freshness.
 * NextAuth writes only an unpublished pending family. The original A request
 * remains the sole source for admission until the final primary transaction. */
export function createProviderOwnedSigninAuthPublication(
  base: NextAuthOptions,
  request: NextRequest,
  input: ProviderOwnedSigninFlow,
  actorInput: ProviderBrowserContext,
  settings: {
    readonly prepareCookiePublication: PrepareProviderSecurityCookies;
    readonly environment?: AuthServiceEnvironment;
    readonly clientFactory?: () => ProviderSecurityCommandClient;
    readonly readSelection?: (cookies: string | null) => Promise<PresentedBrowserSelection>;
  },
) {
  const flow = providerOwnedSigninFlowSchema.parse(input);
  const current = Object.freeze({
    ...actorInput,
    actor: Object.freeze({ ...actorInput.actor }),
    sourceCredentialProof: Object.freeze(webCredentialProofSchema.parse(actorInput.sourceCredentialProof)),
    browserCursor: Object.freeze({ ...actorInput.browserCursor }),
  });
  requireProviderOwnedSigninActor(flow, current);
  const environment = Object.freeze({ ...(settings.environment ?? process.env) });
  const cookieHeader = request.headers.get('cookie');
  const signal = request.signal;
  const pendingName = providerOwnedSigninPendingCookieName(flow.flowHash);
  const googleChecks: Array<'state' | 'pkce' | 'nonce'> = ['state', 'pkce', 'nonce'];
  const carrierName = providerOwnedSigninCookieName(flow.flowHash);
  const configured = base.providers.find((provider) => (provider.options?.id ?? provider.id) === flow.provider);
  const clientId = configured?.type === 'oauth' ? (configured.options?.clientId ?? configured.clientId) : undefined;
  const clientSecret =
    configured?.type === 'oauth' ? (configured.options?.clientSecret ?? configured.clientSecret) : undefined;
  const encoder = base.jwt?.encode ?? encode;
  const jwtCallback = base.callbacks?.jwt;
  const signInEvent = base.events?.signIn;
  const prepareCookies = settings.prepareCookiePublication;
  const readSelection =
    settings.readSelection ?? ((cookies) => readPresentedBrowserSelection(cookies, { environment }));
  const client = (settings.clientFactory ?? (() => createProviderSecurityCommandClient({ environment })))();
  if (
    !base.adapter ||
    base.session?.strategy !== 'jwt' ||
    configured?.type !== 'oauth' ||
    !clientId ||
    !clientSecret ||
    flow.preparation !== null ||
    flow.preparationToken !== null ||
    typeof prepareCookies !== 'function' ||
    (cookieHeader ?? '').split(';').some((piece) => family(piece.trim().split('=', 1)[0], pendingName))
  )
    return refuse();
  const bound = Object.freeze({
    actor: current.actor,
    intentToken: flow.intentToken,
    browserIntentToken: flow.browserIntentToken,
    flowHash: flow.flowHash,
    nonceHash: providerOwnedSigninNonceHash(flow.nonce),
  });
  let prepared: Prepared | undefined;
  let candidate: ProviderSecurityCandidate | undefined;
  let sameOwner = false;
  let signInCalled = false;
  let failed = false;
  let started = false;
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
          Date.parse(flow.credentialExpiresAt),
          Date.parse(flow.browserBindingExpiresAt),
          prepared ? Date.parse(prepared.preparation.expiresAt) : Infinity,
        )
    )
      return fail();
  };
  async function requireOriginalActor() {
    check();
    const selected = await readSelection(cookieHeader);
    check();
    if (selected.status !== 'admitted') return fail();
    requireProviderOwnedSigninActor(flow, captureProviderBrowserContext(selected));
  }
  const user = (): AdapterUser => {
    if (!prepared) return fail();
    return {
      ...prepared.user,
      emailVerified: prepared.user.emailVerified === null ? null : new Date(prepared.user.emailVerified),
    };
  };
  const readonlyAdapter: Adapter = {
    async getUserByAccount(account) {
      check();
      if (account.provider !== flow.provider || !account.providerAccountId) return fail();
      if (!prepared) return null;
      if (account.providerAccountId !== prepared.preparation.subject) return fail();
      return user();
    },
    getUser: async (id) => (prepared && id === prepared.user.id ? user() : fail()),
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
        ...(flow.provider === 'google' ? { checks: [...googleChecks], idToken: true } : {}),
        options: {
          ...configured.options,
          clientId,
          clientSecret,
          allowDangerousEmailAccountLinking: false,
          ...(flow.provider === 'google' ? { checks: [...googleChecks], idToken: true } : {}),
        },
      },
    ],
    callbacks: {
      ...base.callbacks,
      async signIn({ account, profile }) {
        check();
        if (
          signInCalled ||
          !account ||
          account.type !== 'oauth' ||
          account.provider !== flow.provider ||
          !account.providerAccountId ||
          typeof profile?.sub !== 'string' ||
          profile.sub !== account.providerAccountId ||
          (flow.provider === 'google' && (!flow.nonce || typeof account.id_token !== 'string'))
        )
          return fail();
        signInCalled = true;
        const reply = await client.command('signin-prepare', {
          ...bound,
          providerProof: {
            provider: flow.provider,
            subject: account.providerAccountId,
            idToken: flow.provider === 'google' ? account.id_token! : null,
            nonce: flow.provider === 'google' ? flow.nonce : null,
          },
        });
        check();
        if (reply.outcome === 'same-owner') {
          if (
            !sameProof(current.sourceCredentialProof, reply.credentialProof) ||
            current.credentialExpiresAt !== reply.credentialExpiresAt ||
            !sameProviderSecurityCursor(current.browserCursor, reply.browserCursor)
          )
            return fail();
          sameOwner = true;
          return flow.returnUrl;
        }
        if (reply.outcome !== 'prepared') return fail();
        const preparation = providerOwnedSigninPreparationSchema.parse(reply.preparation);
        if (
          preparation.provider !== flow.provider ||
          preparation.subject !== account.providerAccountId ||
          preparation.credentialProof.userId === current.sourceCredentialProof.userId ||
          preparation.credentialProof.authSessionId === current.sourceCredentialProof.authSessionId ||
          reply.user.id !== preparation.credentialProof.userId ||
          !sameProviderSecurityCursor(current.browserCursor, reply.browserCursor) ||
          Date.parse(preparation.credentialExpiresAt) > Date.parse(flow.browserBindingExpiresAt) ||
          Date.parse(preparation.expiresAt) > Date.parse(flow.expiresAt) ||
          (flow.provider === 'apple' &&
            (preparation.credentialProof.authenticatedAt !== null || preparation.credentialProof.linkGuarded)) ||
          (reply.proposedCanonicalToken !== null) !== (current.actor.kind === 'canonical-token') ||
          (reply.proposedCanonicalToken === null
            ? preparation.proposedCanonicalTokenHash !== null
            : preparation.proposedCanonicalTokenHash !==
              providerCandidateCredentialHash({ kind: 'canonical-token', credential: reply.proposedCanonicalToken }))
        )
          return fail();
        prepared = Object.freeze({
          ...reply,
          preparation: Object.freeze({ ...preparation, credentialProof: Object.freeze(preparation.credentialProof) }),
          user: Object.freeze({ ...reply.user }),
          browserCursor: Object.freeze({ ...reply.browserCursor }),
        });
        check();
        return true;
      },
      redirect: async () => flow.returnUrl,
      async jwt(parameters) {
        check();
        if (!prepared || parameters.user?.id !== prepared.user.id) return fail();
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
        const expiry = Date.parse(target.credentialExpiresAt);
        let credential: string;
        if (current.actor.kind === 'canonical-token') {
          const proposal = prepared.proposedCanonicalToken;
          if (!proposal || !/^[A-Za-z0-9_-]{43}$/.test(proposal) || proposal === current.actor.credential)
            return fail();
          credential = proposal;
        } else {
          const seconds = expiry / 1000;
          if (!Number.isSafeInteger(seconds)) return fail();
          const maxAge = seconds - Math.floor(Date.now() / 1000);
          if (maxAge <= 0) return fail();
          credential = await encoder({ ...parameters, maxAge });
          const actual = await decode({ token: credential, secret: parameters.secret, salt: parameters.salt });
          if (!actual || actual.exp !== seconds || !providerSecurityClaimsMatch(actual, target.credentialProof))
            return fail();
        }
        check();
        if (!credential || Buffer.byteLength(credential) > 16_384 || Date.now() >= expiry) return fail();
        candidate = Object.freeze({ kind: current.actor.kind, credential });
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
          parameters.user.id !== prepared.user.id ||
          parameters.account?.provider !== flow.provider ||
          parameters.account.providerAccountId !== prepared.preparation.subject
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
    if (finalizationStarted || sameOwner) return;
    await client
      .command('signin-abort', {
        ...bound,
        preparationToken: prepared?.preparationToken ?? null,
        preparation: prepared?.preparation ?? null,
      })
      .catch(() => undefined);
  }
  return Object.freeze({
    options,
    quarantine(response: Response): Response {
      check();
      const headers = new Headers(response.headers);
      headers.delete('Set-Cookie');
      const pending: string[] = [];
      for (const header of response.headers.getSetCookie()) {
        const name = providerSecurityCookieName(header);
        if (family(name, pendingName)) pending.push(header);
        else if (protectedCookie(name)) return fail();
        else headers.append('Set-Cookie', header);
      }
      if (
        prepared ? !candidate || emittedCandidate(pending, pendingName) !== candidate.credential : pending.length !== 0
      )
        return fail();
      quarantined = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      return quarantined;
    },
    acknowledgeAdmission(response: Response) {
      if (
        acknowledged ||
        response !== quarantined ||
        response.headers.getSetCookie().some((header) => protectedCookie(providerSecurityCookieName(header)))
      )
        return fail();
      acknowledged = true;
    },
    async run(invoke: () => Promise<Response>): Promise<Response> {
      if (started) return unavailableCredentialResponse();
      started = true;
      try {
        await requireOriginalActor();
        const response = await invoke();
        const headers = new Headers(response.headers);
        const status = response.status;
        const statusText = response.statusText;
        check();
        if (
          !acknowledged ||
          !quarantined ||
          headers.getSetCookie().some((header) => protectedCookie(providerSecurityCookieName(header))) ||
          headers.has('Content-Encoding') ||
          (!sameOwner && !prepared)
        )
          return fail();
        const body = await readProviderSecurityAuthBody(response);
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
        await requireOriginalActor();
        if (sameOwner) {
          requireProviderCookieCapacity(cookieHeader, headers);
          return new Response(body, { status, statusText, headers });
        }
        if (!prepared || !candidate) return fail();
        const staged: ProviderOwnedSigninFlow = {
          ...flow,
          preparationToken: prepared.preparationToken,
          preparation: prepared.preparation,
          expiresAt: new Date(
            Math.min(Date.parse(flow.expiresAt), Date.parse(prepared.preparation.expiresAt)),
          ).toISOString(),
        };
        const sealed = await sealProviderOwnedSigninFlow(staged, environment.NEXTAUTH_SECRET ?? '');
        check();
        headers.append(
          'Set-Cookie',
          stringifySetCookie({
            name: carrierName,
            value: sealed,
            path: '/',
            secure: true,
            httpOnly: true,
            sameSite: 'lax',
            expires: new Date(staged.expiresAt),
          }),
        );
        const cursor = Object.freeze({ ...current.browserCursor, version: current.browserCursor.version + 1 });
        const publication = prepareProviderSecurityPublicationResponse({
          candidate,
          cursor,
          credentialExpiresAt: prepared.preparation.credentialExpiresAt,
          preparationExpiresAt: staged.expiresAt,
          frameworkHeaders: [],
          prepareCookiePublication: prepareCookies,
          response: { status, statusText, headers, body },
        });
        requireProviderCookieCapacity(cookieHeader, publication.response.headers);
        check();
        finalizationStarted = true;
        const result = await client.command('signin-finalize', {
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
