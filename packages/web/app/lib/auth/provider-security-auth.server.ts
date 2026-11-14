import 'server-only';
import type { NextAuthOptions } from 'next-auth';
import type { Adapter, AdapterUser } from 'next-auth/adapters';
import { encode } from 'next-auth/jwt';
import type { NextRequest } from 'next/server';
import { parseSetCookie, stringifySetCookie } from 'cookie';
import {
  providerSecurityCommandSchema,
  webCredentialProofSchema,
  type ProviderSecurityActor,
  type ProviderSecurityProvider,
  type ProviderSecurityReply,
  type WebCredentialProof,
} from '@boardsesh/auth-protocol';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import {
  createProviderSecurityCommandClient,
  type ProviderSecurityCommandClient,
} from './provider-security-command-client.server';
import { unavailableCredentialResponse } from './credential-admission-response.server';
import {
  issuePreparedProviderSecurityCredential,
  prepareProviderSecurityPublicationResponse,
  providerSecurityClaimsMatch as proofClaimsMatch,
  providerSecuritySessionFamily as sessionFamily,
  providerSecurityCookieName as cookieName,
  samePreparedProviderSecurityProof as sameProof,
  sameProviderSecurityCursor as sameCursor,
  type ProviderSecurityCandidate as Candidate,
  type ProviderSecurityCookiePlan,
  type PrepareProviderSecurityCookies,
} from './provider-security-publication.server';
export type {
  ProviderSecurityCookiePlan,
  PrepareProviderSecurityCookies,
} from './provider-security-publication.server';

type Prepared = Extract<ProviderSecurityReply, { operation: 'prepare'; outcome: 'prepared' }>;
type Refusal = Extract<ProviderSecurityReply, { code: string }>;

/** Only a qualified server reader may construct this frame from current actual
 * possession. A sealed flow or a claimed UID/SID alone supplies no admission. */
export interface ProviderSecurityExplicitBoundFlow {
  readonly provider: ProviderSecurityProvider;
  readonly actor: ProviderSecurityActor;
  readonly sourceCredentialProof: WebCredentialProof;
  readonly credentialExpiresAt: string;
  readonly intentToken: string;
  readonly browserIntentToken: string;
  readonly reauthenticationToken: string;
  readonly flowHash: string;
  readonly returnUrl?: string;
}
export type ProviderSecurityQualifiedFlowReader = (
  request: NextRequest,
) => Promise<ProviderSecurityExplicitBoundFlow | null>;
export type ProviderSecurityStartBinder = (input: {
  readonly request: NextRequest;
  readonly provider: ProviderSecurityProvider;
  readonly flowHash: string;
  readonly state: string;
  readonly response: Response;
}) => Promise<Response>;

const BODY_BYTES = 65_536;
const fail = (): never => {
  throw new AuthBackendUnavailableError();
};
function emittedCandidate(headers: readonly string[], base: string): string {
  const fresh = headers
    .map((header) => parseSetCookie(header))
    .filter(
      (cookie) =>
        cookie.value &&
        !(cookie.maxAge !== undefined && cookie.maxAge <= 0) &&
        !(cookie.expires !== undefined && cookie.expires.getTime() <= Date.now()),
    );
  if (
    fresh.length === 0 ||
    fresh.some((cookie) => cookie.name !== base && !cookie.name.startsWith(`${base}.`)) ||
    new Set(fresh.map((cookie) => cookie.name)).size !== fresh.length
  )
    return fail();
  if (fresh.some((cookie) => cookie.name === base)) {
    if (fresh.length !== 1) return fail();
  } else {
    fresh.sort((left, right) => Number(left.name.slice(base.length + 1)) - Number(right.name.slice(base.length + 1)));
    if (fresh.some((cookie, index) => cookie.name !== `${base}.${index}`)) return fail();
  }
  return fresh.map((cookie) => cookie.value).join('');
}
async function boundedBody(response: Response): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!response.body) return null;
  const declared = response.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > BODY_BYTES)) return fail();
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AuthBackendUnavailableError()), 2000);
  });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > BODY_BYTES) return fail();
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function captureFlow(flow: ProviderSecurityExplicitBoundFlow, requestUrl: string) {
  try {
    return {
      sourceProof: Object.freeze(webCredentialProofSchema.parse(flow.sourceCredentialProof)),
      requestUrl: new URL(requestUrl),
      captured: providerSecurityCommandSchema.parse({
        providerSecurityVersion: 1,
        operation: 'prepare',
        requestId: '00000000-0000-4000-8000-000000000000',
        issuedAt: new Date().toISOString(),
        payload: {
          actor: flow.actor,
          intentToken: flow.intentToken,
          browserIntentToken: flow.browserIntentToken,
          reauthenticationToken: flow.reauthenticationToken,
          flowHash: flow.flowHash,
          providerProof: null,
        },
      }),
    };
  } catch {
    return fail();
  }
}

/** Unmounted request-local composition. A real broker supplies its qualified
 * reader and reviewed cookie codec; this module has no default publisher. */
export function createProviderSecurityAuthPublication(
  base: NextAuthOptions,
  flowInput: ProviderSecurityExplicitBoundFlow,
  settings: {
    readonly requestUrl: string;
    readonly prepareCookiePublication: PrepareProviderSecurityCookies;
    readonly clientFactory?: () => ProviderSecurityCommandClient;
  },
) {
  const { sourceProof, captured, requestUrl } = captureFlow(flowInput, settings.requestUrl);
  if (captured.operation !== 'prepare') return fail();
  const bound = Object.freeze({ ...captured.payload, actor: Object.freeze(captured.payload.actor) });
  const provider = flowInput.provider;
  const credentialExpiresAt = flowInput.credentialExpiresAt;
  const originalDeadline = Date.parse(credentialExpiresAt);
  const returnUrl = flowInput.returnUrl;
  const prepareCookies = settings.prepareCookiePublication;
  if (
    !base.adapter ||
    base.session?.strategy !== 'jwt' ||
    !base.cookies?.sessionToken?.name ||
    typeof prepareCookies !== 'function' ||
    !Number.isFinite(originalDeadline) ||
    originalDeadline <= Date.now() ||
    sourceProof.generation >= 2_147_483_647 ||
    sourceProof.userId !== bound.actor.expectedUserId ||
    sourceProof.authSessionId !== bound.actor.expectedAuthSessionId ||
    (provider !== 'google' && provider !== 'apple') ||
    !base.providers.some(
      (configured) => configured.type === 'oauth' && (configured.options?.id ?? configured.id) === provider,
    )
  )
    return fail();
  const client = (settings.clientFactory ?? createProviderSecurityCommandClient)();
  const sessionCookieName = base.cookies.sessionToken.name;
  const jwtCallback = base.callbacks?.jwt;
  const encodeCallback = base.jwt?.encode ?? encode;
  const signInEvent = base.events?.signIn;
  let prepared: Prepared | undefined;
  let preparationForAbort: string | undefined;
  let verifiedSubject: string | undefined;
  let refused: Refusal | undefined;
  let candidate: Candidate | undefined;
  let failed = false;
  let quarantined: Response | undefined;
  let frameworkHeaders: readonly string[] = [];
  let acknowledged = false;
  let started = false;
  let finalizationStarted = false;
  let unknownResult = false;
  let buffered: Response | undefined;
  let expectedPlan: ProviderSecurityCookiePlan | undefined;
  let recoveryStarted = false;
  const reject = (): never => {
    failed = true;
    return fail();
  };
  const user = (): AdapterUser => {
    if (!prepared) return reject();
    return {
      ...prepared.user,
      emailVerified: prepared.user.emailVerified === null ? null : new Date(prepared.user.emailVerified),
    };
  };
  const adapter: Adapter = {
    getUserByAccount: async (account) => {
      if (account.provider !== provider) return reject();
      if (!prepared) return null;
      if (account.providerAccountId !== verifiedSubject) return reject();
      return user();
    },
    getUser: async (userId) => (!prepared || userId !== prepared.user.id ? reject() : user()),
    getUserByEmail: async () => reject(),
    getSessionAndUser: async () => reject(),
    createUser: async () => reject(),
    updateUser: async () => reject(),
    deleteUser: async () => reject(),
    linkAccount: async () => reject(),
    unlinkAccount: async () => reject(),
    createSession: async () => reject(),
    updateSession: async () => reject(),
    deleteSession: async () => reject(),
    createVerificationToken: async () => reject(),
    useVerificationToken: async () => reject(),
  };
  const options: NextAuthOptions = {
    ...base,
    adapter,
    debug: false,
    logger: {
      error() {
        failed = true;
      },
      warn() {},
      debug() {},
    },
    providers: base.providers.map((configured) =>
      configured.type === 'oauth' && (configured.options?.id ?? configured.id) === provider
        ? {
            ...configured,
            allowDangerousEmailAccountLinking: false,
            options: configured.options
              ? { ...configured.options, allowDangerousEmailAccountLinking: false }
              : undefined,
          }
        : configured,
    ),
    callbacks: {
      ...base.callbacks,
      async signIn(parameters) {
        const account = parameters.account;
        if (
          prepared ||
          !account ||
          account.type !== 'oauth' ||
          account.provider !== provider ||
          !account.providerAccountId
        )
          return reject();
        const subject = account.providerAccountId;
        const verified =
          parameters.profile && 'email_verified' in parameters.profile ? parameters.profile.email_verified : undefined;
        const reply = await client
          .command('prepare', {
            ...bound,
            providerProof: {
              provider,
              subject,
              email: parameters.user.email ?? null,
              emailVerified: verified === true || verified === 'true',
            },
          })
          .catch(() => reject());
        if (reply.outcome !== 'prepared') {
          refused = reply;
          return false;
        }
        preparationForAbort = reply.preparationToken;
        if (
          !sameProof(sourceProof, reply.credentialProof) ||
          Date.parse(reply.credentialExpiresAt) !== originalDeadline ||
          reply.browserCursor.version !== bound.actor.browserVersion ||
          (reply.proposedCanonicalToken !== null) !== (bound.actor.kind === 'canonical-token') ||
          (bound.actor.kind === 'canonical-token' && reply.proposedCanonicalToken === bound.actor.credential)
        )
          return reject();
        verifiedSubject = subject;
        prepared = Object.freeze({
          ...reply,
          credentialProof: Object.freeze({ ...reply.credentialProof }),
          browserCursor: Object.freeze({ ...reply.browserCursor }),
          user: Object.freeze({ ...reply.user }),
        });
        return true;
      },
      async jwt(parameters) {
        if (!prepared || parameters.user?.id !== prepared.user.id) return reject();
        const claims = jwtCallback
          ? await jwtCallback({
              ...parameters,
              isNewUser: undefined,
              user: { ...parameters.user, webCredentialProof: prepared.credentialProof },
            })
          : parameters.token;
        delete claims.nativeOAuthCreationProof;
        if (!proofClaimsMatch(claims, prepared.credentialProof)) return reject();
        return claims;
      },
      async session() {
        return reject();
      },
    },
    events: {
      createUser: async () => reject(),
      updateUser: async () => reject(),
      linkAccount: async () => reject(),
      session: async () => reject(),
      async signIn(parameters) {
        if (
          !prepared ||
          parameters.user.id !== prepared.user.id ||
          parameters.account?.provider !== provider ||
          parameters.account.providerAccountId !== verifiedSubject
        )
          return reject();
        try {
          await signInEvent?.({ ...parameters, isNewUser: false });
        } catch {
          return reject();
        }
      },
    },
    jwt: {
      ...base.jwt,
      async encode(parameters) {
        if (!prepared || !parameters.token || !proofClaimsMatch(parameters.token, prepared.credentialProof))
          return reject();
        candidate = await issuePreparedProviderSecurityCredential(
          {
            source: bound.actor,
            sourceCredentialProof: sourceProof,
            credentialExpiresAt,
            prepared,
            claims: parameters.token,
          },
          { secret: parameters.secret, salt: parameters.salt, encode: encodeCallback },
        ).catch(() => reject());
        return candidate.credential;
      },
    },
  };
  async function abort() {
    if (finalizationStarted) return;
    await client
      .command('abort', {
        actor: bound.actor,
        intentToken: bound.intentToken,
        browserIntentToken: bound.browserIntentToken,
        preparationToken: preparationForAbort ?? null,
        flowHash: bound.flowHash,
      })
      .catch(() => undefined);
  }
  function confirmed(reply: Extract<ProviderSecurityReply, { outcome: 'committed' | 'recovered' }>): boolean {
    return (
      !!expectedPlan &&
      reply.candidateCredentialHash === expectedPlan.candidateCredentialHash &&
      sameCursor(reply.browserCursor, expectedPlan.cursor)
    );
  }
  return {
    options,
    refusal: () => refused,
    /** Call after the whole NextAuth/Expo/cookie-migration delegate, before admission. */
    quarantine(response: Response): Response {
      const retained = new Headers(response.headers);
      retained.delete('Set-Cookie');
      const sessions: string[] = [];
      for (const header of response.headers.getSetCookie()) {
        if (sessionFamily(cookieName(header))) sessions.push(header);
        else retained.append('Set-Cookie', header);
      }
      if (sessions.length) {
        if (!prepared || !candidate || emittedCandidate(sessions, sessionCookieName) !== candidate.credential)
          return reject();
        frameworkHeaders = Object.freeze(
          bound.actor.kind === 'canonical-token'
            ? []
            : sessions.map((header) => {
                const cookie = parseSetCookie(header);
                if (!cookie.value || (cookie.maxAge !== undefined && cookie.maxAge <= 0)) return header;
                return stringifySetCookie({ ...cookie, maxAge: undefined, expires: new Date(originalDeadline) });
              }),
        );
      } else if (prepared) return reject();
      quarantined = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: retained,
      });
      return quarantined;
    },
    /** Only the real response-admission wrapper may invoke this closure. */
    acknowledgeAdmission(response: Response) {
      if (
        acknowledged ||
        response !== quarantined ||
        response.headers.getSetCookie().some((header) => sessionFamily(cookieName(header)))
      )
        return reject();
      acknowledged = true;
    },
    /** Invoke around admission AND final partner/redirect/body work. */
    async run(invoke: () => Promise<Response>): Promise<Response> {
      if (started) return unavailableCredentialResponse();
      started = true;
      try {
        const response = await invoke();
        if (failed) return fail();
        if (!prepared) {
          await abort();
          return response;
        }
        if (
          !candidate ||
          !acknowledged ||
          !quarantined ||
          Date.now() >= originalDeadline ||
          Date.now() >= Date.parse(prepared.expiresAt) ||
          response.status >= 400
        )
          return fail();
        const body = await boundedBody(response);
        let destination = response.headers.get('Location');
        if (
          response.status === 200 &&
          /^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')
        ) {
          const parsed: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(body ?? new Uint8Array()),
          );
          if (
            !parsed ||
            typeof parsed !== 'object' ||
            Array.isArray(parsed) ||
            Object.keys(parsed).length !== 1 ||
            typeof (parsed as Record<string, unknown>).url !== 'string'
          )
            return fail();
          destination = (parsed as { url: string }).url;
        } else if ((response.status !== 302 && response.status !== 303) || (body?.byteLength ?? 0) !== 0) return fail();
        if (!destination) return fail();
        const location = new URL(destination, requestUrl);
        if (location.searchParams.has('error') || (returnUrl && location.href !== new URL(returnUrl, requestUrl).href))
          return fail();
        const cursor = Object.freeze({ ...prepared.browserCursor, version: prepared.browserCursor.version + 1 });
        if (cursor.version > 2_147_483_647) return fail();
        const publication = prepareProviderSecurityPublicationResponse({
          candidate,
          cursor,
          credentialExpiresAt,
          preparationExpiresAt: prepared.expiresAt,
          frameworkHeaders,
          prepareCookiePublication: prepareCookies,
          response: { status: response.status, statusText: response.statusText, headers: response.headers, body },
        });
        expectedPlan = publication.plan;
        buffered = publication.response;
        finalizationStarted = true;
        const reply = await client.command('finalize', {
          actor: bound.actor,
          intentToken: bound.intentToken,
          browserIntentToken: bound.browserIntentToken,
          reauthenticationToken: bound.reauthenticationToken,
          preparationToken: prepared.preparationToken,
          candidate,
        });
        if (reply.outcome !== 'committed' || !confirmed(reply)) {
          unknownResult = reply.outcome === 'unavailable' || reply.outcome === 'committed';
          return unavailableCredentialResponse();
        }
        return buffered;
      } catch {
        if (finalizationStarted) unknownResult = true;
        else await abort();
        return unavailableCredentialResponse();
      }
    },
    /** Explicit bounded ACK recovery reuses the already-held exact candidate and
     * already-built response. It never retries the finalizer or retrieves a bearer. */
    async recover(recoveryToken: string): Promise<Response> {
      if (
        !unknownResult ||
        recoveryStarted ||
        !candidate ||
        !buffered ||
        !expectedPlan ||
        Date.now() >= originalDeadline
      )
        return unavailableCredentialResponse();
      recoveryStarted = true;
      try {
        const reply = await client.command('recover', {
          actor: bound.actor,
          intentToken: bound.intentToken,
          browserIntentToken: bound.browserIntentToken,
          reauthenticationToken: bound.reauthenticationToken,
          recoveryToken,
          candidate,
        });
        return reply.outcome === 'recovered' && confirmed(reply) ? buffered : unavailableCredentialResponse();
      } catch {
        return unavailableCredentialResponse();
      }
    },
  };
}
