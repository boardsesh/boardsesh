import 'server-only';
import { browserRenewalReplySchema } from '@boardsesh/auth-protocol/browser-renewal-v1';
import { browserBindingReplySchema, browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import { browserRenewalMode } from '@boardsesh/auth-protocol/browser-renewal-v1';
import { BROWSER_COORDINATOR_PUBLIC_PATHS } from '@boardsesh/auth-protocol/browser-coordinator';
import type { AuthServiceEnvironment } from '@boardsesh/auth-protocol/transport';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import {
  createBrowserBindingCommandClient,
  type BrowserBindingCommandClient,
} from './browser-binding-command-client.server';
import {
  createBrowserRenewalCommandClient,
  type BrowserRenewalCommandClient,
} from './browser-renewal-command-client.server';
import {
  BROWSER_RENEWAL_CARRIER_PREFIX,
  observedBrowserRenewalOperationKeys,
  readBrowserRenewalCarrier,
  type BrowserRenewalCarrier,
} from './browser-renewal-carrier.server';
import { readBrowserCorrelationCookie } from './browser-proof-cookies.server';
import {
  readPresentedBrowserSelection,
  type AdmittedBrowserSelection,
  type PresentedBrowserSelection,
} from './presented-browser-selection.server';
import { publicBrowserRenewalReady } from './browser-renewal-readiness';
import { publicBrowserCoordinatorReady } from './browser-coordinator-readiness';
import { requirePublicAuthRequest, PublicAuthRequestError } from './public-auth-request.server';
import { checkRateLimit } from './rate-limiter';
import { trustedClientRateLimitKey } from './trusted-client-ip.server';
import {
  bufferBrowserRenewalCandidate,
  bufferBrowserRenewalCleanup,
  bufferBrowserRenewalResponse,
  sameRenewalSelection,
} from './browser-renewal-publication.server';

export function assertRenewalNotInterrupted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AuthBackendUnavailableError();
}
export function boundRenewalCarrier(bindingToken: string, carrier: Readonly<BrowserRenewalCarrier>) {
  return {
    bindingToken,
    actor: carrier.actor,
    operationToken: carrier.operationToken,
    preparationToken: carrier.preparationToken,
    nonceHash: carrier.nonceHash,
    preparation: carrier.preparation,
    candidate: carrier.candidate,
  };
}
/** Actual carrier custody is NOT a generic admission source. Re-admit its
 * candidate only after the backend confirms this exact durable completion. */
export async function acknowledgeExactBrowserRenewal(input: {
  readonly bindingToken: string;
  readonly carrier: Readonly<BrowserRenewalCarrier>;
  readonly renewal: BrowserRenewalCommandClient;
  readonly binding: BrowserBindingCommandClient;
  readonly signal?: AbortSignal;
}): Promise<AdmittedBrowserSelection | null> {
  assertRenewalNotInterrupted(input.signal);
  const reply = browserRenewalReplySchema.parse(
    await input.renewal.acknowledge(boundRenewalCarrier(input.bindingToken, input.carrier)),
  );
  assertRenewalNotInterrupted(input.signal);
  if (reply.outcome === 'unavailable') throw new AuthBackendUnavailableError();
  if (reply.outcome !== 'completed' || reply.operation !== 'acknowledge') return null;
  const expected = input.carrier.preparation;
  if (
    JSON.stringify(reply.cursor) !== JSON.stringify(expected.futureBrowserCursor) ||
    JSON.stringify(reply.credentialProof) !== JSON.stringify(expected.sourceCredentialProof) ||
    reply.credentialExpiresAt !== expected.targetExpiresAt
  )
    throw new AuthBackendUnavailableError();
  const actor = { version: expected.futureBrowserCursor.version, credential: input.carrier.candidate };
  const actual = browserBindingReplySchema.parse(await input.binding.read({ bindingToken: input.bindingToken, actor }));
  assertRenewalNotInterrupted(input.signal);
  if (actual.outcome === 'unavailable') throw new AuthBackendUnavailableError();
  if (actual.operation !== 'read' || actual.outcome !== 'admitted') return null;
  const selected: AdmittedBrowserSelection = {
    status: 'admitted',
    bindingToken: input.bindingToken,
    actor,
    cursor: actual.cursor,
    session: actual.session,
    user: actual.user,
  };
  if (!sameRenewalSelection(input.carrier, selected, 'candidate')) return null;
  return selected;
}
/** Optional canonical observe join. No mutation retry, source reconstruction,
 * new binding or candidate admission from an uncompleted preparation. */
export function createBrowserRenewalRecovery(
  options: {
    readonly environment?: AuthServiceEnvironment;
    readonly ready?: () => boolean;
    readonly readSelection?: (header: string | null) => Promise<PresentedBrowserSelection>;
    readonly renewalFactory?: () => BrowserRenewalCommandClient;
    readonly bindingFactory?: () => BrowserBindingCommandClient;
    readonly rateLimit?: (request: Request) => boolean;
  } = {},
) {
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  const ready = options.ready ?? (() => publicBrowserRenewalReady() && publicBrowserCoordinatorReady());
  const readSelection = options.readSelection ?? ((header) => readPresentedBrowserSelection(header, { environment }));
  const renewalFactory = options.renewalFactory ?? (() => createBrowserRenewalCommandClient({ environment }));
  const bindingFactory = options.bindingFactory ?? (() => createBrowserBindingCommandClient({ environment }));
  const rateLimit =
    options.rateLimit ??
    ((request) => checkRateLimit(`browser-renewal:observe:${trustedClientRateLimitKey(request)}`, 120, 60_000).limited);
  return async (request: Request): Promise<Response | null> => {
    try {
      if (
        !ready() ||
        browserRenewalMode(environment) !== 'backend-staging' ||
        browserBindingMode(environment) !== 'backend-staging'
      )
        return null;
      const captured = new Request(request.clone(), { headers: new Headers(request.headers) });
      const origin = requirePublicAuthRequest(captured, BROWSER_COORDINATOR_PUBLIC_PATHS.observe, 'GET', environment);
      const header = captured.headers.get('cookie');
      if (!(header ?? '').split(';').some((pair) => pair.trim().startsWith(BROWSER_RENEWAL_CARRIER_PREFIX)))
        return null;
      if (rateLimit(captured)) return bufferBrowserRenewalResponse({ status: 'unavailable' }, 429, [], null);
      assertRenewalNotInterrupted(captured.signal);
      const visible = await readSelection(header);
      assertRenewalNotInterrupted(captured.signal);
      if (visible.status === 'unavailable') throw new AuthBackendUnavailableError();
      if (visible.status === 'anonymous') return null;
      const correlation = readBrowserCorrelationCookie(header);
      if (correlation.status !== 'present')
        return bufferBrowserRenewalResponse({ status: 'proof-required' }, 409, [], null);
      let keys: readonly string[];
      try {
        keys = observedBrowserRenewalOperationKeys(header);
      } catch {
        // Malformed unrelated custody cannot retire a separately admitted
        // complete proof, and supplies no repair or cleanup authority.
        return visible.status === 'admitted'
          ? null
          : bufferBrowserRenewalResponse({ status: 'proof-required' }, 409, [], null);
      }
      const binding = bindingFactory();
      const descriptor = await binding.describe({ bindingToken: correlation.token });
      assertRenewalNotInterrupted(captured.signal);
      if (descriptor.outcome === 'unavailable') throw new AuthBackendUnavailableError();
      if (descriptor.outcome !== 'known' || descriptor.state !== 'selected') return null;
      if (descriptor.cursor.bindingId !== correlation.bindingId) throw new AuthBackendUnavailableError();
      const completed: Array<{
        readonly carrier: Readonly<BrowserRenewalCarrier>;
        readonly operationKey: string;
        readonly current: AdmittedBrowserSelection;
      }> = [];
      const renewal = renewalFactory();
      for (const operationKey of keys) {
        let carrier: Readonly<BrowserRenewalCarrier>;
        try {
          carrier = readBrowserRenewalCarrier(header, operationKey, environment.NEXTAUTH_SECRET ?? '', origin);
        } catch {
          continue;
        }
        const future = carrier.preparation.futureBrowserCursor;
        if (
          future.bindingId !== descriptor.cursor.bindingId ||
          future.version !== descriptor.cursor.version ||
          future.bindingExpiresAt !== descriptor.cursor.bindingExpiresAt ||
          carrier.candidate.kind !== descriptor.credentialKind
        )
          continue;
        const current = await acknowledgeExactBrowserRenewal({
          bindingToken: correlation.token,
          carrier,
          renewal,
          binding,
          signal: captured.signal,
        });
        if (current) completed.push({ carrier, operationKey, current });
      }
      if (!completed.length) return null;
      if (completed.length !== 1) throw new AuthBackendUnavailableError();
      const found = completed[0];
      // A final primary read after every candidate ACK prevents a late current
      // selection change from being hidden by an earlier successful response.
      const again = await binding.read({ bindingToken: correlation.token, actor: found.current.actor });
      assertRenewalNotInterrupted(captured.signal);
      if (again.outcome === 'unavailable') throw new AuthBackendUnavailableError();
      if (again.operation !== 'read' || again.outcome !== 'admitted')
        return bufferBrowserRenewalResponse({ status: 'conflict' }, 409, [], null);
      const current: AdmittedBrowserSelection = {
        ...found.current,
        cursor: again.cursor,
        session: again.session,
        user: again.user,
      };
      if (!sameRenewalSelection(found.carrier, current, 'candidate'))
        return bufferBrowserRenewalResponse({ status: 'conflict' }, 409, [], null);
      if (visible.status === 'admitted') {
        if (!sameRenewalSelection(found.carrier, visible, 'candidate'))
          return bufferBrowserRenewalResponse({ status: 'conflict' }, 409, [], null);
        return bufferBrowserRenewalCleanup(found.carrier, found.operationKey, header, origin, current);
      }
      return bufferBrowserRenewalCandidate(found.carrier, header, origin);
    } catch (error) {
      return bufferBrowserRenewalResponse(
        { status: 'unavailable' },
        error instanceof PublicAuthRequestError ? error.status : 503,
        [],
        null,
      );
    }
  };
}
