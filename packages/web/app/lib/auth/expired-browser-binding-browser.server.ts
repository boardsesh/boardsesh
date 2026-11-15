import 'server-only';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import {
  expiredBrowserBindingMode,
  expiredBrowserBindingReplySchema,
} from '@boardsesh/auth-protocol/expired-browser-binding-v1';
import {
  EXPIRED_BROWSER_BINDING_BROWSER_PATHS,
  expiredBrowserBindingBrowserPrepareSchema,
  expiredBrowserBindingBrowserControlSchema,
} from '@boardsesh/auth-protocol/expired-browser-binding-browser-v1';
import type { AuthServiceEnvironment } from '@boardsesh/auth-protocol/transport';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import {
  createBrowserBindingCommandClient,
  type BrowserBindingCommandClient,
} from './browser-binding-command-client.server';
import {
  createExpiredBrowserBindingCommandClient,
  type ExpiredBrowserBindingCommandClient,
} from './expired-browser-binding-command-client.server';
import {
  expiredBrowserBindingCarrierExpiry,
  observedExpiredBrowserBindingOperationKeys,
  prepareExpiredBrowserBindingCarrierCookies,
  readExpiredBrowserBindingCarrier,
  sealExpiredBrowserBindingCarrier,
  type ExpiredBrowserBindingCarrier,
} from './expired-browser-binding-carrier.server';
import {
  bufferExpiredBrowserBindingResponse,
  expiredBrowserBindingTargetResponse,
  expiredBrowserBindingConfirmedResponse,
} from './expired-browser-binding-publication.server';
import { publicExpiredBrowserBindingReady } from './expired-browser-binding-readiness';
import { publicBrowserCoordinatorReady } from './browser-coordinator-readiness';
import { readPresentedBrowserSelection, type PresentedBrowserSelection } from './presented-browser-selection.server';
import {
  BROWSER_PROOF_COOKIE_LIMITS,
  buildCanonicalCoordinatorCorrelationCookie,
  readBrowserCorrelationCookie,
} from './browser-proof-cookies.server';
import {
  PublicAuthRequestError,
  boundedAuthCookiePairs,
  readBoundedAuthJson,
  requirePublicAuthRequest,
} from './public-auth-request.server';
import { checkRateLimit } from './rate-limiter';
import { trustedClientRateLimitKey } from './trusted-client-ip.server';

type Operation = keyof typeof EXPIRED_BROWSER_BINDING_BROWSER_PATHS;
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
function uninterrupted(signal: AbortSignal): void {
  if (signal.aborted) throw new AuthBackendUnavailableError();
}
function privateReply(input: unknown) {
  try {
    return expiredBrowserBindingReplySchema.parse(input);
  } catch {
    throw new AuthBackendUnavailableError();
  }
}
function bound(carrier: Readonly<ExpiredBrowserBindingCarrier>) {
  return {
    bindingToken: carrier.bindingToken,
    targetBindingToken: carrier.targetBindingToken,
    operationToken: carrier.operationToken,
    preparation: carrier.preparation,
  };
}
function cursorMatches(
  actual: { readonly bindingId: string; readonly version: number; readonly bindingExpiresAt: string },
  carrier: Readonly<ExpiredBrowserBindingCarrier>,
): boolean {
  const expected = carrier.preparation.targetCursor;
  return (
    actual.bindingId === expected.bindingId &&
    actual.version === 0 &&
    actual.bindingExpiresAt === expected.bindingExpiresAt
  );
}

/** Explicit sign-in only. No observe/renew route calls this broker. A prepared
 * capability can create only a new anonymous binding, never admit its old user. */
export function createExpiredBrowserBindingBrowserBroker(
  options: {
    readonly environment?: AuthServiceEnvironment;
    readonly ready?: () => boolean;
    readonly readSelection?: (header: string | null) => Promise<PresentedBrowserSelection>;
    readonly clientFactory?: () => ExpiredBrowserBindingCommandClient;
    readonly bindingFactory?: () => BrowserBindingCommandClient;
    readonly rateLimit?: (request: Request, operation: Operation) => boolean;
  } = {},
) {
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  const ready = options.ready ?? (() => publicExpiredBrowserBindingReady() && publicBrowserCoordinatorReady());
  const readSelection = options.readSelection ?? ((header) => readPresentedBrowserSelection(header, { environment }));
  const clientFactory = options.clientFactory ?? (() => createExpiredBrowserBindingCommandClient({ environment }));
  const bindingFactory = options.bindingFactory ?? (() => createBrowserBindingCommandClient({ environment }));
  const rateLimit =
    options.rateLimit ??
    ((request, operation) =>
      checkRateLimit(`expired-browser-binding:${operation}:${trustedClientRateLimitKey(request)}`, 20, 60_000).limited);

  async function acknowledged(
    carrier: Readonly<ExpiredBrowserBindingCarrier>,
    client: ExpiredBrowserBindingCommandClient,
    binding: BrowserBindingCommandClient,
    signal: AbortSignal,
  ): Promise<boolean> {
    uninterrupted(signal);
    const first = privateReply(await client.acknowledge(bound(carrier)));
    uninterrupted(signal);
    if (first.outcome === 'unavailable') return refuse();
    if (first.operation !== 'acknowledge' || first.outcome !== 'completed') return false;
    if (!cursorMatches(first.cursor, carrier)) return refuse();
    const actual = await binding.read({ bindingToken: carrier.targetBindingToken });
    uninterrupted(signal);
    if (actual.outcome === 'unavailable') return refuse();
    if (actual.operation !== 'read' || actual.outcome !== 'anonymous' || !cursorMatches(actual.cursor, carrier))
      return false;
    // The primary read can await an authority or old-row change. Recheck the
    // complete durable receipt after it, rather than publishing an earlier ACK.
    const final = privateReply(await client.acknowledge(bound(carrier)));
    uninterrupted(signal);
    if (final.outcome === 'unavailable') return refuse();
    return final.operation === 'acknowledge' && final.outcome === 'completed' && cursorMatches(final.cursor, carrier);
  }

  async function run(original: Request, operation: Operation): Promise<Response> {
    try {
      if (
        !ready() ||
        browserBindingMode(environment) !== 'backend-staging' ||
        expiredBrowserBindingMode(environment) !== 'backend-staging'
      )
        return refuse();
      const request = new Request(original.clone(), { headers: new Headers(original.headers) });
      const origin = requirePublicAuthRequest(
        request,
        EXPIRED_BROWSER_BINDING_BROWSER_PATHS[operation],
        'POST',
        environment,
      );
      if (rateLimit(request, operation)) return refuse(429);
      uninterrupted(request.signal);
      const header = request.headers.get('cookie');
      boundedAuthCookiePairs(header);
      const correlation = readBrowserCorrelationCookie(header);
      if (correlation.status !== 'present') return refuse(409, 'proof-required');
      const input = await readBoundedAuthJson(request);
      uninterrupted(request.signal);
      const secret = environment.NEXTAUTH_SECRET;
      if (!secret || secret.trim() !== secret || Buffer.byteLength(secret) < 32) return refuse();
      if (operation === 'prepare') {
        expiredBrowserBindingBrowserPrepareSchema.parse(input);
        const visible = await readSelection(header);
        uninterrupted(request.signal);
        if (visible.status === 'unavailable') return refuse();
        if (visible.status === 'admitted' || visible.status === 'anonymous') {
          if (visible.cursor.bindingId !== correlation.bindingId) return refuse(409, 'conflict');
          const response = bufferExpiredBrowserBindingResponse(
            { status: 'ready', cursor: { bindingId: visible.cursor.bindingId, version: visible.cursor.version } },
            200,
            [],
            header,
          );
          const again = await readSelection(header);
          uninterrupted(request.signal);
          if (again.status === 'unavailable') return refuse();
          if (JSON.stringify(again) !== JSON.stringify(visible)) return refuse(409, 'conflict');
          return response;
        }
        const client = clientFactory();
        const keys = observedExpiredBrowserBindingOperationKeys(header);
        const recovered: Readonly<ExpiredBrowserBindingCarrier>[] = [];
        for (const operationKey of keys) {
          let carrier: Readonly<ExpiredBrowserBindingCarrier>;
          try {
            carrier = readExpiredBrowserBindingCarrier(header, operationKey, secret, origin);
          } catch {
            continue;
          }
          if (carrier.bindingToken !== correlation.token) continue;
          if (await acknowledged(carrier, client, bindingFactory(), request.signal)) recovered.push(carrier);
        }
        if (recovered.length > 1) return refuse(409, 'conflict');
        if (recovered.length === 1) {
          const carrier = recovered[0];
          const response = expiredBrowserBindingTargetResponse(carrier, header, origin);
          if (!(await acknowledged(carrier, client, bindingFactory(), request.signal))) return refuse(409, 'conflict');
          return response;
        }
        if (keys.length >= 4 || boundedAuthCookiePairs(header).length >= BROWSER_PROOF_COOKIE_LIMITS.incomingPairs)
          return refuse();
        const nonceHash = randomBytes(32).toString('hex');
        // Existing carriers are ACK-only. A later explicit attempt gets a NEW
        // preparation; no uncertain physical finalizer is ever retried here.
        const reply = privateReply(await client.prepare({ bindingToken: correlation.token, nonceHash }));
        uninterrupted(request.signal);
        if (reply.outcome === 'unavailable') return refuse();
        if (reply.operation !== 'prepare' || reply.outcome !== 'prepared') return refuse(409, 'proof-required');
        if (reply.preparation.oldBindingId !== correlation.bindingId || reply.preparation.nonceHash !== nonceHash)
          return refuse();
        const carrier: ExpiredBrowserBindingCarrier = {
          version: 1,
          bindingToken: correlation.token,
          targetBindingToken: reply.targetBindingToken,
          operationToken: reply.operationToken,
          preparation: reply.preparation,
          expiresAt: expiredBrowserBindingCarrierExpiry(reply.preparation),
        };
        const sealed = sealExpiredBrowserBindingCarrier(carrier, secret, origin);
        const refresh = buildCanonicalCoordinatorCorrelationCookie({
          servingOrigin: origin,
          canonicalOrigin: origin,
          token: correlation.token,
          bindingId: correlation.bindingId,
        });
        const plan = prepareExpiredBrowserBindingCarrierCookies({
          ...sealed,
          observedCookieHeader: header,
          responseHeaderBudgetBytes:
            BROWSER_PROOF_COOKIE_LIMITS.responseHeaderBytes - Buffer.byteLength(`Set-Cookie: ${refresh}\r\n`),
          responseHeaderCountBudget: BROWSER_PROOF_COOKIE_LIMITS.responseHeaders - 1,
        });
        return bufferExpiredBrowserBindingResponse(
          {
            status: 'prepared',
            operationKey: sealed.operationKey,
            sourceCursor: { bindingId: reply.preparation.oldBindingId, version: reply.preparation.oldVersion },
            targetCursor: { bindingId: reply.preparation.targetCursor.bindingId, version: 0 },
          },
          200,
          [refresh, ...plan.headers],
          header,
        );
      }
      const control = expiredBrowserBindingBrowserControlSchema.parse(input);
      const carrier = readExpiredBrowserBindingCarrier(header, control.operationKey, secret, origin);
      if (
        control.sourceCursor.bindingId !== carrier.preparation.oldBindingId ||
        control.sourceCursor.version !== carrier.preparation.oldVersion ||
        control.targetCursor.bindingId !== carrier.preparation.targetCursor.bindingId ||
        control.targetCursor.version !== 0
      )
        return refuse(409, 'conflict');
      const client = clientFactory();
      const binding = bindingFactory();
      if (operation === 'confirm') {
        if (correlation.token !== carrier.targetBindingToken) return refuse(409, 'conflict');
        const response = expiredBrowserBindingConfirmedResponse(carrier, control.operationKey, header);
        if (!(await acknowledged(carrier, client, binding, request.signal))) return refuse(409, 'conflict');
        return response;
      }
      // Actual OLD-cookie possession is mandatory. A stale A request cannot
      // retire a different current B by supplying A's encrypted plan.
      if (correlation.token !== carrier.bindingToken) return refuse(409, 'conflict');
      const response = expiredBrowserBindingTargetResponse(carrier, header, origin);
      if (Date.parse(carrier.preparation.expiresAt) <= Date.now()) return refuse(409, 'conflict');
      uninterrupted(request.signal);
      const completed = privateReply(await client.finalize(bound(carrier)));
      uninterrupted(request.signal);
      if (completed.outcome === 'unavailable') return refuse();
      if (
        completed.operation !== 'finalize' ||
        completed.outcome !== 'completed' ||
        !cursorMatches(completed.cursor, carrier)
      )
        return refuse(409, 'conflict');
      if (!(await acknowledged(carrier, client, binding, request.signal))) return refuse(409, 'conflict');
      return response;
    } catch (error) {
      return bufferExpiredBrowserBindingResponse(
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
    confirm: (request: Request) => run(request, 'confirm'),
  };
}
