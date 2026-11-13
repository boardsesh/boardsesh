import 'server-only';
import { z } from 'zod';
import {
  providerSecurityMode,
  providerSecurityReplyStatus,
  type ProviderSecurityReply,
} from '@boardsesh/auth-protocol';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import type { AuthServiceEnvironment } from '@boardsesh/auth-protocol/transport';
import { readPresentedBrowserSelection, type PresentedBrowserSelection } from './presented-browser-selection.server';
import { buildBrowserProofCookieCandidate, readBrowserCorrelationCookie } from './browser-proof-cookies.server';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import {
  createProviderSecurityCommandClient,
  providerCandidateCredentialHash,
  type ProviderSecurityCommandClient,
} from './provider-security-command-client.server';
import { openProviderSecurityFlow, providerSecurityFlowCookieName } from './provider-security-flow.server';
import { publicProviderSecurityReady } from './provider-security-readiness';
import { readProviderSecurityRecoveryInput } from './provider-security-recovery.server';
import {
  captureProviderBrowserContext,
  requireProviderSecurityFlowActor,
  ProviderSecurityIdentityChangedError,
} from './provider-security-selection.server';
import {
  issuePreparedProviderSecurityCredential,
  prepareProviderSecurityPublicationResponse,
  sameProviderSecurityCursor,
} from './provider-security-publication.server';

const selector = z.string().regex(/^[a-f0-9]{64}$/);
type Prepared = Extract<ProviderSecurityReply, { operation: 'prepare'; outcome: 'prepared' }>;
type DirectInput = {
  readonly cookieHeader: string | null;
  readonly operationKey: string;
  readonly signal?: AbortSignal;
};

function reply(outcome: string, status = 200): Response {
  return Response.json(
    { outcome },
    {
      status,
      headers: {
        'Cache-Control': 'private, no-store',
        Pragma: 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        ...(status === 503 ? { 'Retry-After': '1' } : {}),
      },
    },
  );
}
function refused(result: ProviderSecurityReply): Response {
  const status = providerSecurityReplyStatus(result);
  const outcome =
    result.outcome === 'denied' && (result.code === 'last_usable_method' || result.code === 'ownership_conflict')
      ? result.code
      : result.outcome;
  return status === 200 ? reply('unavailable', 503) : reply(outcome, status);
}
function interrupted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AuthBackendUnavailableError();
}

/** Server-only publication seam. The eventual JSON route must perform its
 * canonical Host/Origin and bounded-body checks before invoking these methods.
 * No HTTP field selects readiness, source possession or a cookie budget. */
export function createProviderSecurityDirectPublication(
  options: {
    readonly environment?: AuthServiceEnvironment;
    readonly ready?: () => boolean;
    readonly readSelection?: (cookies: string | null) => Promise<PresentedBrowserSelection>;
    readonly clientFactory?: () => ProviderSecurityCommandClient;
  } = {},
) {
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  const ready = options.ready ?? publicProviderSecurityReady;
  const readSelection = options.readSelection ?? ((cookies) => readPresentedBrowserSelection(cookies, { environment }));
  const clientFactory = options.clientFactory ?? (() => createProviderSecurityCommandClient({ environment }));
  const enabled = () =>
    ready() &&
    providerSecurityMode(environment) === 'backend-staging' &&
    browserBindingMode(environment) === 'backend-staging';

  return Object.freeze({
    async unlink(input: DirectInput & { readonly actorContextKey: string }): Promise<Response> {
      // Capture all caller-owned primitives and references before any await.
      const cookies = input.cookieHeader;
      const operationKey = input.operationKey;
      const expectedActorKey = input.actorContextKey;
      const signal = input.signal;
      let prepared: Prepared | undefined;
      let abortPrepared: (() => Promise<void>) | undefined;
      let finalizationStarted = false;
      try {
        if (!enabled()) return reply('unavailable', 503);
        selector.parse(operationKey);
        selector.parse(expectedActorKey);
        interrupted(signal);
        const correlation = readBrowserCorrelationCookie(cookies);
        if (correlation.status !== 'present') throw new ProviderSecurityIdentityChangedError();
        const selected = await readSelection(cookies);
        if (selected.status === 'unavailable') return reply('unavailable', 503);
        if (selected.status !== 'admitted') return reply('identity_changed', 409);
        const current = captureProviderBrowserContext(selected);
        if (current.actorContextKey !== expectedActorKey) throw new ProviderSecurityIdentityChangedError();
        const cookieName = providerSecurityFlowCookieName(operationKey, true);
        const carriers = (cookies ?? '')
          .split(';')
          .map((piece) => piece.trim())
          .filter((piece) => piece.startsWith(`${cookieName}=`));
        if (carriers.length !== 1) throw new ProviderSecurityIdentityChangedError();
        const flow = await openProviderSecurityFlow(
          carriers[0].slice(cookieName.length + 1),
          operationKey,
          environment.NEXTAUTH_SECRET ?? '',
        );
        requireProviderSecurityFlowActor(flow, current);
        if (flow.action !== 'unlink' || flow.providerFlowHash !== null) return reply('invalid_request', 400);
        if (
          flow.reauthenticationToken === null ||
          flow.reauthenticationExpiresAt === null ||
          Date.parse(flow.reauthenticationExpiresAt) <= Date.now()
        )
          return reply('reauthentication_required', 403);
        interrupted(signal);
        const client = clientFactory();
        const bound = {
          actor: current.actor,
          intentToken: flow.intentToken,
          browserIntentToken: flow.browserIntentToken,
        };
        const result = await client.command('prepare', {
          ...bound,
          reauthenticationToken: flow.reauthenticationToken,
          flowHash: null,
          providerProof: null,
        });
        if (result.operation !== 'prepare' || result.outcome !== 'prepared') return refused(result);
        prepared = result;
        abortPrepared = async () => {
          await client
            .command('abort', { ...bound, preparationToken: result.preparationToken, flowHash: null })
            .catch(() => undefined);
        };
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
        const after = await readSelection(cookies);
        if (after.status === 'unavailable') throw new AuthBackendUnavailableError();
        if (after.status !== 'admitted') throw new ProviderSecurityIdentityChangedError();
        requireProviderSecurityFlowActor(flow, captureProviderBrowserContext(after));
        interrupted(signal);
        const cursor = Object.freeze({ ...current.browserCursor, version: current.browserCursor.version + 1 });
        const deadline = Math.min(
          Date.parse(prepared.expiresAt),
          Date.parse(flow.expiresAt),
          Date.parse(flow.reauthenticationExpiresAt),
        );
        const publication = prepareProviderSecurityPublicationResponse({
          candidate,
          cursor,
          credentialExpiresAt: current.credentialExpiresAt,
          preparationExpiresAt: new Date(deadline).toISOString(),
          frameworkHeaders: [],
          prepareCookiePublication: ({ candidate: actualCandidate, cursor: actualCursor, credentialExpiresAt }) => {
            const cookieDeadline = Math.min(Date.parse(credentialExpiresAt), Date.parse(actualCursor.bindingExpiresAt));
            const planned = buildBrowserProofCookieCandidate({
              cursor: { bindingId: actualCursor.bindingId, version: actualCursor.version },
              proof: { kind: actualCandidate.kind, rawCredential: actualCandidate.credential },
              proofMaxAgeSeconds: Math.floor((cookieDeadline - Date.now()) / 1000),
              observedCookieHeader: cookies,
              retainObservedProofCookies: true,
            });
            return Object.freeze({
              cursor: actualCursor,
              candidateCredentialHash: providerCandidateCredentialHash(actualCandidate),
              headers: Object.freeze(
                planned.headers.map(
                  (header) =>
                    `${header.replace(/; Max-Age=[0-9]+/i, '')}; Expires=${new Date(cookieDeadline).toUTCString()}`,
                ),
              ),
            });
          },
          response: {
            status: 200,
            headers: new Headers({ 'Content-Type': 'application/json; charset=utf-8' }),
            body: new TextEncoder().encode(JSON.stringify({ outcome: 'completed' })),
          },
        });
        interrupted(signal);
        // After this point the commit may have happened even if transport fails.
        // Never abort, retry or construct another credential response afterward.
        finalizationStarted = true;
        const finalized = await client.command('finalize', {
          ...bound,
          reauthenticationToken: flow.reauthenticationToken,
          preparationToken: prepared.preparationToken,
          candidate,
        });
        if (
          finalized.outcome !== 'committed' ||
          finalized.candidateCredentialHash !== publication.plan.candidateCredentialHash ||
          !sameProviderSecurityCursor(finalized.browserCursor, publication.plan.cursor)
        )
          return reply('unavailable', 503);
        return publication.response;
      } catch (error) {
        if (!finalizationStarted) await abortPrepared?.();
        if (error instanceof ProviderSecurityIdentityChangedError) return reply('identity_changed', 409);
        if (error instanceof z.ZodError) return reply('invalid_request', 400);
        return reply('unavailable', 503);
      }
    },
    async acknowledge(input: DirectInput): Promise<Response> {
      const cookies = input.cookieHeader;
      const operationKey = input.operationKey;
      const signal = input.signal;
      try {
        if (!enabled()) return reply('unavailable', 503);
        selector.parse(operationKey);
        interrupted(signal);
        const command = await readProviderSecurityRecoveryInput(cookies, operationKey, {
          secret: environment.NEXTAUTH_SECRET ?? '',
          readSelection,
        });
        interrupted(signal);
        const result = await clientFactory().command('recover', command);
        if (result.outcome !== 'recovered') return refused(result);
        const selected = await readSelection(cookies);
        if (selected.status === 'unavailable') return reply('unavailable', 503);
        if (selected.status !== 'admitted') return reply('identity_changed', 409);
        const current = captureProviderBrowserContext(selected);
        interrupted(signal);
        if (
          result.candidateCredentialHash !== providerCandidateCredentialHash(command.candidate) ||
          result.browserCursor.version !== command.actor.browserVersion + 1 ||
          !sameProviderSecurityCursor(result.browserCursor, current.browserCursor) ||
          current.actor.kind !== command.candidate.kind ||
          current.actor.credential !== command.candidate.credential
        )
          return reply('unavailable', 503);
        // An ACK returns no bearer, cursor, hashes or cleanup Set-Cookie. The old
        // proof/carrier remain bounded by their original expiry for retry safety.
        return reply('completed');
      } catch (error) {
        if (error instanceof ProviderSecurityIdentityChangedError) return reply('identity_changed', 409);
        if (error instanceof z.ZodError) return reply('invalid_request', 400);
        return reply('unavailable', 503);
      }
    },
  });
}
