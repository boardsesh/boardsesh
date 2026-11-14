import 'server-only';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import {
  browserRenewalMode,
  browserRenewalReplySchema,
  type BrowserRenewalReply,
} from '@boardsesh/auth-protocol/browser-renewal-v1';
import {
  BROWSER_RENEWAL_BROWSER_PATHS,
  browserRenewalBrowserPrepareSchema,
  browserRenewalBrowserCommitSchema,
} from '@boardsesh/auth-protocol/browser-renewal-browser-v1';
import type { AuthServiceEnvironment } from '@boardsesh/auth-protocol/transport';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import {
  createBrowserBindingCommandClient,
  type BrowserBindingCommandClient,
} from './browser-binding-command-client.server';
import {
  createBrowserRenewalCommandClient,
  browserRenewalSourceHash,
  type BrowserRenewalCommandClient,
} from './browser-renewal-command-client.server';
import { publicBrowserRenewalReady } from './browser-renewal-readiness';
import { publicBrowserCoordinatorReady } from './browser-coordinator-readiness';
import {
  readPresentedBrowserSelection,
  type AdmittedBrowserSelection,
  type PresentedBrowserSelection,
} from './presented-browser-selection.server';
import { BROWSER_PROOF_COOKIE_LIMITS, readBrowserCorrelationCookie } from './browser-proof-cookies.server';
import {
  browserRenewalCarrierExpiry,
  observedBrowserRenewalOperationKeys,
  prepareBrowserRenewalCarrierCookies,
  readBrowserRenewalCarrier,
  sealBrowserRenewalCarrier,
  type BrowserRenewalCarrier,
} from './browser-renewal-carrier.server';
import { issuePreparedBrowserRenewalCredential } from './browser-renewal-credential.server';
import {
  bufferBrowserRenewalCandidate,
  bufferBrowserRenewalCleanup,
  bufferBrowserRenewalResponse,
  renewalCorrelationRefresh,
  renewalSourceProof,
  sameRenewalCursor,
  sameRenewalSelection,
} from './browser-renewal-publication.server';
import {
  acknowledgeExactBrowserRenewal,
  assertRenewalNotInterrupted,
  boundRenewalCarrier,
} from './browser-renewal-recovery.server';
import {
  PublicAuthRequestError,
  boundedAuthCookiePairs,
  readBoundedAuthJson,
  requirePublicAuthRequest,
} from './public-auth-request.server';
import { checkRateLimit } from './rate-limiter';
import { trustedClientRateLimitKey } from './trusted-client-ip.server';

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly outcome: 'conflict' | 'proof-required' | 'unavailable',
  ) {
    super(outcome);
  }
}
function refuse(status = 503, outcome: Refusal['outcome'] = 'unavailable'): never {
  throw new Refusal(status, outcome);
}
function publicCursor(cursor: { readonly bindingId: string; readonly version: number }) {
  return { bindingId: cursor.bindingId, version: cursor.version };
}
function sourceFrame(selected: AdmittedBrowserSelection): string {
  return JSON.stringify([
    selected.bindingToken,
    selected.cursor,
    browserRenewalSourceHash(selected.actor.credential),
    renewalSourceProof(selected),
    selected.session.expiresAt,
    selected.user.id,
  ]);
}
function privateRefusal(reply: BrowserRenewalReply): never {
  return reply.outcome === 'unavailable' ? refuse() : refuse(409, 'conflict');
}
function requireCarrierSecret(secret: string | undefined): string {
  if (!secret || secret.trim() !== secret || Buffer.byteLength(secret) < 32) throw new AuthBackendUnavailableError();
  return secret;
}
/** Two physical requests: custody must arrive BEFORE a state-changing commit.
 * The canonical transport owns their common lock and never retries a finalizer. */
export function createBrowserRenewalBrowserBroker(
  options: {
    readonly environment?: AuthServiceEnvironment;
    readonly ready?: () => boolean;
    readonly readSelection?: (header: string | null) => Promise<PresentedBrowserSelection>;
    readonly renewalFactory?: () => BrowserRenewalCommandClient;
    readonly bindingFactory?: () => BrowserBindingCommandClient;
    readonly rateLimit?: (request: Request, operation: keyof typeof BROWSER_RENEWAL_BROWSER_PATHS) => boolean;
  } = {},
) {
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  const ready = options.ready ?? (() => publicBrowserRenewalReady() && publicBrowserCoordinatorReady());
  const readSelection = options.readSelection ?? ((header) => readPresentedBrowserSelection(header, { environment }));
  const renewalFactory = options.renewalFactory ?? (() => createBrowserRenewalCommandClient({ environment }));
  const bindingFactory = options.bindingFactory ?? (() => createBrowserBindingCommandClient({ environment }));
  const rateLimit =
    options.rateLimit ??
    ((request, operation) =>
      checkRateLimit(`browser-renewal:${operation}:${trustedClientRateLimitKey(request)}`, 120, 60_000).limited);
  async function sameSource(header: string | null, fingerprint: string, signal: AbortSignal): Promise<void> {
    const current = await readSelection(header);
    assertRenewalNotInterrupted(signal);
    if (current.status === 'unavailable') return refuse();
    if (current.status !== 'admitted' || sourceFrame(current) !== fingerprint) return refuse(409, 'conflict');
  }
  async function run(original: Request, operation: keyof typeof BROWSER_RENEWAL_BROWSER_PATHS): Promise<Response> {
    try {
      if (
        !ready() ||
        browserBindingMode(environment) !== 'backend-staging' ||
        browserRenewalMode(environment) !== 'backend-staging'
      )
        return refuse();
      const request = new Request(original.clone(), { headers: new Headers(original.headers) });
      const origin = requirePublicAuthRequest(request, BROWSER_RENEWAL_BROWSER_PATHS[operation], 'POST', environment);
      if (rateLimit(request, operation)) return refuse(429);
      assertRenewalNotInterrupted(request.signal);
      const header = request.headers.get('cookie');
      const correlation = readBrowserCorrelationCookie(header);
      if (correlation.status !== 'present') return refuse(409, 'proof-required');
      const input = await readBoundedAuthJson(request);
      assertRenewalNotInterrupted(request.signal);
      if (operation === 'prepare') {
        const expected = browserRenewalBrowserPrepareSchema.parse(input).expectedCursor;
        const selected = await readSelection(header);
        assertRenewalNotInterrupted(request.signal);
        if (selected.status === 'unavailable') return refuse();
        if (selected.status !== 'admitted' && selected.status !== 'anonymous')
          return refuse(409, selected.status === 'proof-required' ? 'proof-required' : 'conflict');
        if (
          selected.cursor.bindingId !== correlation.bindingId ||
          selected.cursor.bindingId !== expected.bindingId ||
          selected.cursor.version !== expected.version
        )
          return refuse(409, 'conflict');
        if (selected.status === 'anonymous')
          return bufferBrowserRenewalResponse(
            { status: 'anonymous', cursor: publicCursor(selected.cursor) },
            200,
            [],
            header,
          );
        const fingerprint = sourceFrame(selected);
        // Frequency only: actual primary admission above remains authoritative.
        // Daily rolling avoids retiring every immutable operation view on polls.
        if (
          Math.min(Date.parse(selected.session.expiresAt), Date.parse(selected.cursor.bindingExpiresAt)) >
          Date.now() + 29 * 86_400_000
        ) {
          const response = bufferBrowserRenewalResponse(
            { status: 'current', cursor: publicCursor(selected.cursor) },
            200,
            [renewalCorrelationRefresh(header, origin, selected.cursor.bindingId)],
            header,
          );
          await sameSource(header, fingerprint, request.signal);
          return response;
        }
        const secret = requireCarrierSecret(environment.NEXTAUTH_SECRET);
        if (
          observedBrowserRenewalOperationKeys(header).length >= 4 ||
          boundedAuthCookiePairs(header).length >= BROWSER_PROOF_COOKIE_LIMITS.incomingPairs
        )
          return refuse();
        const nonceHash = randomBytes(32).toString('hex');
        const reply = browserRenewalReplySchema.parse(
          await renewalFactory().prepare({ bindingToken: correlation.token, actor: selected.actor, nonceHash }),
        );
        assertRenewalNotInterrupted(request.signal);
        if (reply.outcome !== 'prepared') return privateRefusal(reply);
        if (!sameRenewalCursor(reply.preparation.browserCursor, selected.cursor)) return refuse(409, 'conflict');
        const candidate = await issuePreparedBrowserRenewalCredential(
          {
            source: selected.actor.credential,
            sourceCredentialProof: renewalSourceProof(selected),
            sourceExpiresAt: selected.session.expiresAt,
            preparation: reply.preparation,
          },
          { secret },
        );
        assertRenewalNotInterrupted(request.signal);
        const carrier: BrowserRenewalCarrier = {
          version: 1,
          operationToken: reply.operationToken,
          preparationToken: reply.preparationToken,
          nonceHash,
          actor: selected.actor,
          candidate,
          preparation: reply.preparation,
          expiresAt: browserRenewalCarrierExpiry(reply.preparation),
        };
        const sealed = sealBrowserRenewalCarrier(carrier, secret, origin);
        const refresh = renewalCorrelationRefresh(header, origin, selected.cursor.bindingId);
        const plan = prepareBrowserRenewalCarrierCookies({
          ...sealed,
          observedCookieHeader: header,
          responseHeaderBudgetBytes:
            BROWSER_PROOF_COOKIE_LIMITS.responseHeaderBytes - Buffer.byteLength(`Set-Cookie: ${refresh}\r\n`),
          responseHeaderCountBudget: BROWSER_PROOF_COOKIE_LIMITS.responseHeaders - 1,
        });
        const response = bufferBrowserRenewalResponse(
          { status: 'prepared', cursor: publicCursor(selected.cursor), operationKey: sealed.operationKey },
          200,
          [refresh, ...plan.headers],
          header,
        );
        await sameSource(header, fingerprint, request.signal);
        return response;
      }
      const control = browserRenewalBrowserCommitSchema.parse(input);
      const carrier = readBrowserRenewalCarrier(
        header,
        control.operationKey,
        requireCarrierSecret(environment.NEXTAUTH_SECRET),
        origin,
      );
      if (
        carrier.preparation.browserCursor.bindingId !== correlation.bindingId ||
        control.expectedCursor.bindingId !== correlation.bindingId ||
        control.expectedCursor.version !== carrier.preparation.browserCursor.version
      )
        return refuse(409, 'conflict');
      const renewal = renewalFactory(),
        binding = bindingFactory();
      const recovered = await acknowledgeExactBrowserRenewal({
        bindingToken: correlation.token,
        carrier,
        renewal,
        binding,
        signal: request.signal,
      });
      if (recovered) {
        const visible = await readSelection(header);
        assertRenewalNotInterrupted(request.signal);
        if (visible.status === 'unavailable') return refuse();
        // Visibility can await another primary observation. Recheck the exact
        // candidate after it before publishing or cleaning any physical cookie.
        const again = await binding.read({ bindingToken: correlation.token, actor: recovered.actor });
        assertRenewalNotInterrupted(request.signal);
        if (again.outcome === 'unavailable') return refuse();
        if (again.operation !== 'read' || again.outcome !== 'admitted') return refuse(409, 'conflict');
        const current: AdmittedBrowserSelection = {
          ...recovered,
          cursor: again.cursor,
          session: again.session,
          user: again.user,
        };
        if (!sameRenewalSelection(carrier, current, 'candidate')) return refuse(409, 'conflict');
        if (visible.status === 'admitted') {
          if (!sameRenewalSelection(carrier, visible, 'candidate')) return refuse(409, 'conflict');
          return bufferBrowserRenewalCleanup(carrier, control.operationKey, header, origin, current);
        }
        return bufferBrowserRenewalCandidate(carrier, header, origin);
      }
      const selected = await readSelection(header);
      assertRenewalNotInterrupted(request.signal);
      if (selected.status === 'unavailable') return refuse();
      if (selected.status !== 'admitted' || !sameRenewalSelection(carrier, selected, 'source'))
        return refuse(409, 'conflict');
      if (Date.parse(carrier.preparation.expiresAt) <= Date.now()) return refuse(409, 'conflict');
      const buffered = bufferBrowserRenewalCandidate(carrier, header, origin);
      await sameSource(header, sourceFrame(selected), request.signal);
      const reply = browserRenewalReplySchema.parse(
        await renewal.finalize(boundRenewalCarrier(correlation.token, carrier)),
      );
      assertRenewalNotInterrupted(request.signal);
      if (reply.outcome !== 'completed' || reply.operation !== 'finalize') return privateRefusal(reply);
      if (
        !sameRenewalCursor(reply.cursor, carrier.preparation.futureBrowserCursor) ||
        JSON.stringify(reply.credentialProof) !== JSON.stringify(carrier.preparation.sourceCredentialProof) ||
        reply.credentialExpiresAt !== carrier.preparation.targetExpiresAt
      )
        return refuse();
      return buffered;
    } catch (error) {
      return bufferBrowserRenewalResponse(
        { status: error instanceof Refusal ? error.outcome : 'unavailable' },
        error instanceof Refusal
          ? error.status
          : error instanceof PublicAuthRequestError
            ? error.status
            : error instanceof z.ZodError
              ? 400
              : 503,
        [],
        null,
      );
    }
  }
  return {
    prepare: (request: Request) => run(request, 'prepare'),
    commit: (request: Request) => run(request, 'commit'),
  };
}
