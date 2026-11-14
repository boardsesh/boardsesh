import 'server-only';
import { z } from 'zod';
import { sendFirstPasswordConfirmationEmail } from '@boardsesh/email';
import { firstPasswordMode, firstPasswordReplyStatus, type FirstPasswordReply } from '@boardsesh/auth-protocol';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import type { AuthServiceEnvironment } from '@boardsesh/auth-protocol/transport';
import { readPresentedBrowserSelection, type PresentedBrowserSelection } from './presented-browser-selection.server';
import {
  BROWSER_PROOF_COOKIE_LIMITS,
  buildBrowserProofCookieCandidate,
  readBrowserCorrelationCookie,
  readBrowserProofCookie,
} from './browser-proof-cookies.server';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import {
  captureProviderBrowserContext,
  requireProviderSecurityFlowActor,
  ProviderSecurityIdentityChangedError,
  type ProviderBrowserContext,
} from './provider-security-selection.server';
import {
  issuePreparedProviderSecurityCredential,
  prepareProviderSecurityPublicationResponse,
  sameProviderSecurityCursor,
} from './provider-security-publication.server';
import { providerCandidateCredentialHash } from './provider-security-command-client.server';
import {
  createFirstPasswordCommandClient,
  type FirstPasswordCommandClient,
} from './first-password-command-client.server';
import {
  assertFirstPasswordFlowSecret,
  firstPasswordOperationKey,
  firstPasswordFlowCookieName,
  sealFirstPasswordFlow,
  openFirstPasswordFlow,
  type FirstPasswordFlow,
} from './first-password-flow.server';
import { publicFirstPasswordReady } from './first-password-readiness';
import {
  PublicAuthRequestError,
  requirePublicAuthRequest,
  boundedAuthCookiePairs,
  readBoundedAuthJson,
} from './public-auth-request.server';
import { checkRateLimit } from './rate-limiter';

export const FIRST_PASSWORD_BROWSER_PATHS = Object.freeze({
  context: '/api/internal/auth/first-password/context',
  request: '/api/internal/auth/first-password/request',
  read: '/api/internal/auth/first-password/read',
  submit: '/api/internal/auth/first-password/submit',
  acknowledge: '/api/internal/auth/first-password/acknowledge',
});
const selector = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z
  .object({
    actorContextKey: selector,
    expectedUserId: z.string().min(1).max(1024),
    expectedAuthSessionId: z.string().min(1).max(1024),
  })
  .strict();
const operationSchema = z.object({ operationKey: selector }).strict();
const submitSchema = operationSchema
  .extend({
    confirmationToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    password: z.string().min(8).max(128),
    confirmPassword: z.string().min(8).max(128),
  })
  .strict();
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly outcome: string,
  ) {
    super(outcome);
  }
}
function refuse(status: number, outcome: string): never {
  throw new Refusal(status, outcome);
}
function response(
  outcome: string,
  status = 200,
  fields: Readonly<Record<string, unknown>> = {},
  cookie?: string,
): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (status === 503 || status === 429) headers.set('Retry-After', '1');
  if (cookie) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify({ outcome, ...fields }), { status, headers });
}
function failure(reply: FirstPasswordReply): never {
  const status = firstPasswordReplyStatus(reply);
  return refuse(status === 200 ? 503 : status, status === 200 ? 'unavailable' : reply.outcome);
}
function interrupted(signal: AbortSignal): void {
  if (signal.aborted) throw new AuthBackendUnavailableError();
}
function flowHeader(operationKey: string, sealed: string, expiresAt: string): string {
  const header = `${firstPasswordFlowCookieName(operationKey)}=${sealed}; Path=/; Secure; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`;
  if (Buffer.byteLength(header) > 4096 || Date.parse(expiresAt) <= Date.now()) throw new AuthBackendUnavailableError();
  return header;
}

/** Public presentation broker. Only actual selected possession nominates an
 * account. Email delivery receives the private backend plan; responses expose
 * no recipient, confirmation/recovery/preparation capability or credential. */
export function createFirstPasswordBrowserBroker(
  options: {
    readonly environment?: AuthServiceEnvironment;
    readonly ready?: () => boolean;
    readonly readSelection?: (cookies: string | null) => Promise<PresentedBrowserSelection>;
    readonly clientFactory?: () => FirstPasswordCommandClient;
    readonly deliver?: typeof sendFirstPasswordConfirmationEmail;
    readonly rateLimit?: typeof checkRateLimit;
  } = {},
) {
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  const ready = options.ready ?? publicFirstPasswordReady;
  const readSelection = options.readSelection ?? ((cookies) => readPresentedBrowserSelection(cookies, { environment }));
  const clientFactory = options.clientFactory ?? (() => createFirstPasswordCommandClient({ environment }));
  const deliver = options.deliver ?? sendFirstPasswordConfirmationEmail;
  const rateLimit = options.rateLimit ?? checkRateLimit;
  async function admit(cookies: string | null): Promise<ProviderBrowserContext> {
    const selected = await readSelection(cookies);
    if (selected.status === 'unavailable') return refuse(503, 'unavailable');
    if (selected.status !== 'admitted')
      return refuse(
        selected.status === 'conflict' ? 409 : 401,
        selected.status === 'conflict' ? 'identity_changed' : 'unauthenticated',
      );
    return captureProviderBrowserContext(selected);
  }
  async function sameActor(cookies: string | null, flow: FirstPasswordFlow): Promise<ProviderBrowserContext> {
    const current = await admit(cookies);
    requireProviderSecurityFlowActor(flow, current);
    return current;
  }
  function readFlow(cookies: string | null, operationKey: string): Readonly<FirstPasswordFlow> {
    const name = firstPasswordFlowCookieName(operationKey);
    const carriers = boundedAuthCookiePairs(cookies).filter((pair) => pair.name === name);
    if (carriers.length !== 1) return refuse(409, 'identity_changed');
    return openFirstPasswordFlow(carriers[0].content, operationKey, environment.NEXTAUTH_SECRET ?? '');
  }
  async function run(request: Request, operation: keyof typeof FIRST_PASSWORD_BROWSER_PATHS): Promise<Response> {
    try {
      if (
        !ready() ||
        firstPasswordMode(environment) !== 'backend-staging' ||
        browserBindingMode(environment) !== 'backend-staging'
      )
        return refuse(503, 'unavailable');
      const origin = requirePublicAuthRequest(
        request,
        FIRST_PASSWORD_BROWSER_PATHS[operation],
        operation === 'context' ? 'GET' : 'POST',
        environment,
      );
      const cookies = request.headers.get('cookie');
      const pairs = boundedAuthCookiePairs(cookies);
      const correlation = readBrowserCorrelationCookie(cookies);
      if (correlation.status !== 'present') return refuse(409, 'identity_changed');
      interrupted(request.signal);
      if (operation === 'context') {
        const current = await admit(cookies);
        interrupted(request.signal);
        return response('available', 200, {
          actorContextKey: current.actorContextKey,
          userId: current.actor.expectedUserId,
          authSessionId: current.actor.expectedAuthSessionId,
        });
      }
      const input = await readBoundedAuthJson(request);
      interrupted(request.signal);
      if (operation === 'request') {
        const expected = requestSchema.parse(input);
        assertFirstPasswordFlowSecret(environment.NEXTAUTH_SECRET ?? '');
        if (pairs.filter((pair) => pair.name.startsWith('__Host-boardsesh.first-password.')).length >= 4)
          return refuse(400, 'invalid_request');
        const current = await admit(cookies);
        if (
          current.actorContextKey !== expected.actorContextKey ||
          current.actor.expectedUserId !== expected.expectedUserId ||
          current.actor.expectedAuthSessionId !== expected.expectedAuthSessionId
        )
          return refuse(409, 'identity_changed');
        const limited = rateLimit(`first-password-mail:${current.actor.expectedUserId}`, 5, 60_000);
        if (limited.limited) return refuse(429, 'unavailable');
        const reply = await clientFactory().command('request', { actor: current.actor });
        if (reply.outcome !== 'issued') return failure(reply);
        if (!sameProviderSecurityCursor(reply.browserCursor, current.browserCursor))
          throw new AuthBackendUnavailableError();
        const operationKey = firstPasswordOperationKey(reply.challengeToken);
        const issuedAt = new Date().toISOString();
        // Local carrier metadata can only shorten the backend challenge, never
        // refresh source authentication or extend a DB-owned authorization.
        const expiresAt = new Date(
          Math.min(
            Date.parse(reply.expiresAt),
            Date.parse(issuedAt) + 300_000,
            Date.parse(current.credentialExpiresAt),
            Date.parse(current.browserCursor.bindingExpiresAt),
          ),
        ).toISOString();
        const flow: FirstPasswordFlow = {
          version: 1,
          actorKind: current.actor.kind,
          actorCredentialHash: current.credentialHash,
          sourceCredentialProof: current.sourceCredentialProof,
          credentialExpiresAt: current.credentialExpiresAt,
          browserBindingHash: current.browserCursor.bindingId,
          browserVersion: current.browserCursor.version,
          browserBindingExpiresAt: current.browserCursor.bindingExpiresAt,
          challengeToken: reply.challengeToken,
          browserIntentToken: reply.browserIntentToken,
          recoveryToken: reply.recoveryToken,
          preparationToken: null,
          candidateCredentialHash: null,
          issuedAt,
          expiresAt,
        };
        const sealed = sealFirstPasswordFlow(flow, environment.NEXTAUTH_SECRET ?? '');
        const cookie = flowHeader(operationKey, sealed, flow.expiresAt);
        if (
          Buffer.byteLength(`${cookies ?? ''}; ${cookie.split(';', 1)[0]}`) >
            BROWSER_PROOF_COOKIE_LIMITS.projectedCookieHeaderBytes ||
          pairs.length + 1 > BROWSER_PROOF_COOKIE_LIMITS.incomingPairs
        )
          throw new AuthBackendUnavailableError();
        // The complete response/cookie plan exists before a mail transport is invoked.
        const publication = response('email_sent', 200, { operationKey, expiresAt: flow.expiresAt }, cookie);
        await sameActor(cookies, flow);
        interrupted(request.signal);
        await deliver(reply.mailPlan.recipient, reply.mailPlan.token, operationKey, origin);
        await sameActor(cookies, flow);
        interrupted(request.signal);
        if (Date.parse(flow.expiresAt) <= Date.now()) throw new AuthBackendUnavailableError();
        return publication;
      }
      if (operation === 'acknowledge') {
        const { operationKey } = operationSchema.parse(input);
        const flow = readFlow(cookies, operationKey);
        if (flow.preparationToken === null || flow.candidateCredentialHash === null)
          return refuse(409, 'identity_changed');
        const current = await admit(cookies);
        const previous = readBrowserProofCookie(cookies, {
          bindingId: flow.browserBindingHash,
          version: flow.browserVersion,
        });
        const future = readBrowserProofCookie(cookies, {
          bindingId: current.browserCursor.bindingId,
          version: current.browserCursor.version,
        });
        if (previous.status !== 'present' || future.status !== 'present') return refuse(409, 'identity_changed');
        const original = flow.sourceCredentialProof;
        const selected = current.sourceCredentialProof;
        if (
          current.browserCursor.bindingId !== flow.browserBindingHash ||
          current.browserCursor.version !== flow.browserVersion + 1 ||
          current.browserCursor.bindingExpiresAt !== flow.browserBindingExpiresAt ||
          current.credentialExpiresAt !== flow.credentialExpiresAt ||
          current.actor.kind !== flow.actorKind ||
          selected.userId !== original.userId ||
          selected.authSessionId !== original.authSessionId ||
          selected.generation !== original.generation + 1 ||
          selected.authenticatedAt !== original.authenticatedAt ||
          selected.linkGuarded !== original.linkGuarded ||
          Boolean(selected.requiresAccountCutoff) !== Boolean(original.requiresAccountCutoff) ||
          previous.proof.kind !== flow.actorKind ||
          future.proof.kind !== current.actor.kind ||
          future.proof.rawCredential !== current.actor.credential ||
          providerCandidateCredentialHash({ kind: previous.proof.kind, credential: previous.proof.rawCredential }) !==
            flow.actorCredentialHash ||
          current.credentialHash !== flow.candidateCredentialHash
        )
          return refuse(409, 'identity_changed');
        const result = await clientFactory().command('recover', {
          actor: {
            ...current.actor,
            kind: previous.proof.kind,
            credential: previous.proof.rawCredential,
            browserVersion: flow.browserVersion,
          },
          challengeToken: flow.challengeToken,
          browserIntentToken: flow.browserIntentToken,
          preparationToken: flow.preparationToken,
          recoveryToken: flow.recoveryToken,
          candidate: { kind: future.proof.kind, credential: future.proof.rawCredential },
        });
        if (result.outcome !== 'recovered') return failure(result);
        const after = await admit(cookies);
        interrupted(request.signal);
        if (
          after.actorContextKey !== current.actorContextKey ||
          !sameProviderSecurityCursor(after.browserCursor, result.browserCursor) ||
          result.candidateCredentialHash !== flow.candidateCredentialHash
        )
          throw new AuthBackendUnavailableError();
        return response('completed');
      }
      const command = operation === 'read' ? operationSchema.parse(input) : submitSchema.parse(input);
      const flow = readFlow(cookies, command.operationKey);
      const current = await sameActor(cookies, flow);
      const bound = {
        actor: current.actor,
        challengeToken: flow.challengeToken,
        browserIntentToken: flow.browserIntentToken,
      };
      const client = clientFactory();
      if (operation === 'read') {
        const result = await client.command('read', bound);
        if (result.outcome !== 'pending' && result.outcome !== 'prepared') return failure(result);
        await sameActor(cookies, flow);
        interrupted(request.signal);
        return response(result.outcome, 200, { expiresAt: result.expiresAt });
      }
      const submitted = submitSchema.parse(command);
      if (submitted.password !== submitted.confirmPassword) return refuse(400, 'invalid_request');
      const prepared = await client.command('prepare', {
        ...bound,
        confirmationToken: submitted.confirmationToken,
        password: submitted.password,
        confirmPassword: submitted.confirmPassword,
      });
      if (prepared.outcome !== 'prepared') return failure(prepared);
      if (!sameProviderSecurityCursor(prepared.browserCursor, current.browserCursor))
        throw new AuthBackendUnavailableError();
      const candidate = await issuePreparedProviderSecurityCredential(
        {
          source: { kind: current.actor.kind, credential: current.actor.credential },
          sourceCredentialProof: current.sourceCredentialProof,
          credentialExpiresAt: current.credentialExpiresAt,
          prepared,
        },
        { secret: environment.NEXTAUTH_SECRET ?? '' },
      );
      await sameActor(cookies, flow);
      interrupted(request.signal);
      const deadline = new Date(
        Math.min(Date.parse(flow.expiresAt), Date.parse(prepared.expiresAt), Date.now() + 120_000),
      ).toISOString();
      const recoveryFlow = {
        ...flow,
        preparationToken: prepared.preparationToken,
        candidateCredentialHash: providerCandidateCredentialHash(candidate),
        expiresAt: deadline,
      };
      const sealed = sealFirstPasswordFlow(recoveryFlow, environment.NEXTAUTH_SECRET ?? '');
      const carrier = flowHeader(command.operationKey, sealed, deadline);
      const name = firstPasswordFlowCookieName(command.operationKey);
      const observed = pairs.map((pair) => `${pair.name}=${pair.name === name ? sealed : pair.content}`).join('; ');
      const cursor = { ...current.browserCursor, version: current.browserCursor.version + 1 };
      const publication = prepareProviderSecurityPublicationResponse({
        candidate,
        cursor,
        credentialExpiresAt: current.credentialExpiresAt,
        preparationExpiresAt: deadline,
        frameworkHeaders: [],
        prepareCookiePublication: ({ candidate: actual, cursor: target, credentialExpiresAt }) => {
          const cookieDeadline = Math.min(Date.parse(credentialExpiresAt), Date.parse(target.bindingExpiresAt));
          const proof = buildBrowserProofCookieCandidate({
            cursor: { bindingId: target.bindingId, version: target.version },
            proof: { kind: actual.kind, rawCredential: actual.credential },
            proofMaxAgeSeconds: Math.floor((cookieDeadline - Date.now()) / 1000),
            observedCookieHeader: observed,
            retainObservedProofCookies: true,
          });
          return {
            cursor: target,
            candidateCredentialHash: providerCandidateCredentialHash(actual),
            headers: [
              ...proof.headers.map(
                (header) =>
                  `${header.replace(/; Max-Age=[0-9]+/i, '')}; Expires=${new Date(cookieDeadline).toUTCString()}`,
              ),
              carrier,
            ],
          };
        },
        response: {
          status: 200,
          headers: new Headers({ 'Content-Type': 'application/json; charset=utf-8' }),
          body: new TextEncoder().encode(JSON.stringify({ outcome: 'completed', operationKey: command.operationKey })),
        },
      });
      interrupted(request.signal);
      // No retry, abort, issuer or response construction is allowed after this await.
      const finalized = await client.command('finalize', {
        ...bound,
        preparationToken: prepared.preparationToken,
        candidate,
      });
      if (
        finalized.outcome !== 'committed' ||
        finalized.candidateCredentialHash !== publication.plan.candidateCredentialHash ||
        !sameProviderSecurityCursor(finalized.browserCursor, publication.plan.cursor)
      )
        return response('unavailable', 503);
      return publication.response;
    } catch (error) {
      if (error instanceof Refusal) return response(error.outcome, error.status);
      if (error instanceof ProviderSecurityIdentityChangedError) return response('identity_changed', 409);
      if (error instanceof PublicAuthRequestError)
        return response(error.status === 503 ? 'unavailable' : 'invalid_request', error.status);
      if (error instanceof z.ZodError) return response('invalid_request', 400);
      return response('unavailable', 503);
    }
  }
  return Object.freeze({ run });
}
