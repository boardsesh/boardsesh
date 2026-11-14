import 'server-only';
import { z } from 'zod';
import { providerSecurityMode } from '@boardsesh/auth-protocol';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import type { AuthServiceEnvironment } from '@boardsesh/auth-protocol/transport';
import {
  boundedAuthCookiePairs,
  PublicAuthRequestError,
  readBoundedAuthJson,
  requirePublicAuthRequest,
} from './public-auth-request.server';
import { publicProviderSecurityReady } from './provider-security-readiness';
import { readPresentedBrowserSelection, type PresentedBrowserSelection } from './presented-browser-selection.server';
import { createProviderOwnedSigninAcknowledgment } from './provider-owned-signin-recovery.server';
import { assertProviderOwnedSigninFlowSecret, openProviderOwnedSigninFlow } from './provider-owned-signin-flow.server';
import { assertAnonymousProviderFlowSecret, openAnonymousProviderFlow } from './anonymous-provider-flow.server';
import { createAnonymousProviderAcknowledgment } from './anonymous-provider-recovery.server';
import {
  createAnonymousProviderCommandClient,
  type AnonymousProviderCommandClient,
} from './anonymous-provider-command-client.server';
import {
  createProviderSecurityCommandClient,
  type ProviderSecurityCommandClient,
} from './provider-security-command-client.server';
import {
  PROVIDER_SIGNIN_ACKNOWLEDGMENT_PATH,
  type ProviderSigninAcknowledgment,
} from './provider-signin-acknowledgment';

export {
  PROVIDER_SIGNIN_ACKNOWLEDGMENT_PATH,
  type ProviderSigninAcknowledgment,
} from './provider-signin-acknowledgment';
const prefixes = ['__Host-boardsesh.provider-signin.', '__Host-boardsesh.anonymous-provider.'] as const;
const empty = z.object({}).strict();

/** Canonical observers may join this server-only readonly helper. No flow
 * selector, UID, proof or credential crosses a client/coordinator message. */
export function createProviderSigninAcknowledgment(
  options: {
    readonly environment?: AuthServiceEnvironment;
    readonly ready?: () => boolean;
    readonly readSelection?: (cookies: string | null) => Promise<PresentedBrowserSelection>;
    readonly providerClientFactory?: () => ProviderSecurityCommandClient;
    readonly anonymousClientFactory?: () => AnonymousProviderCommandClient;
  } = {},
) {
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  const ready = options.ready ?? publicProviderSecurityReady;
  const readSelection = options.readSelection ?? ((cookies) => readPresentedBrowserSelection(cookies, { environment }));
  const providerFactory = options.providerClientFactory ?? (() => createProviderSecurityCommandClient({ environment }));
  const anonymousFactory =
    options.anonymousClientFactory ?? (() => createAnonymousProviderCommandClient({ environment }));
  return async (input: {
    readonly cookieHeader: string | null;
    readonly signal?: AbortSignal;
  }): Promise<ProviderSigninAcknowledgment> => {
    const header = input.cookieHeader;
    const signal = input.signal;
    try {
      if (
        !ready() ||
        providerSecurityMode(environment) !== 'backend-staging' ||
        browserBindingMode(environment) !== 'backend-staging' ||
        signal?.aborted
      )
        return 'unavailable';
      const carriers = boundedAuthCookiePairs(header).filter((cookie) =>
        prefixes.some((prefix) => cookie.name.startsWith(prefix)),
      );
      if (
        carriers.length > 4 ||
        new Set(carriers.map((cookie) => cookie.name)).size !== carriers.length ||
        carriers.some((cookie) => !/^[a-f0-9]{64}$/.test(cookie.name.slice(cookie.name.lastIndexOf('.') + 1)))
      )
        return 'identity_changed';
      if (!carriers.length) return 'none';
      assertProviderOwnedSigninFlowSecret(environment.NEXTAUTH_SECRET ?? '');
      assertAnonymousProviderFlowSecret(environment.NEXTAUTH_SECRET ?? '');
      const candidates: Array<{
        readonly kind: 'owned' | 'anonymous';
        readonly hash: string;
        readonly bindingId: string;
        readonly version: number;
        readonly userId: string;
        readonly authSessionId: string;
      }> = [];
      for (const cookie of carriers) {
        const hash = cookie.name.slice(cookie.name.lastIndexOf('.') + 1);
        try {
          const owned = cookie.name.startsWith(prefixes[0]);
          const flow = owned
            ? await openProviderOwnedSigninFlow(cookie.content, hash, environment.NEXTAUTH_SECRET ?? '')
            : await openAnonymousProviderFlow(cookie.content, hash, environment.NEXTAUTH_SECRET ?? '');
          const preparation = flow.preparation;
          if (preparation && flow.preparationToken)
            candidates.push({
              kind: owned ? 'owned' : 'anonymous',
              hash,
              bindingId: flow.browserBindingHash,
              version: flow.browserVersion + 1,
              userId: preparation.credentialProof.userId,
              authSessionId: preparation.credentialProof.authSessionId,
            });
        } catch {
          /* Unrelated expired/invalid carriers supply no ACK authority. */
        }
      }
      if (signal?.aborted) return 'unavailable';
      if (!candidates.length) return 'none';
      const selected = await readSelection(header);
      if (signal?.aborted || selected.status === 'unavailable') return 'unavailable';
      if (selected.status !== 'admitted') return 'identity_changed';
      const eligible = candidates.filter(
        (candidate) =>
          candidate.bindingId === selected.cursor.bindingId &&
          candidate.version === selected.cursor.version &&
          candidate.userId === selected.session.userId &&
          candidate.authSessionId === selected.session.authSessionId,
      );
      if (!eligible.length) return 'none';
      if (eligible.length !== 1) return 'identity_changed';
      const receipt = eligible[0];
      if (receipt.kind === 'anonymous')
        return createAnonymousProviderAcknowledgment({
          secret: environment.NEXTAUTH_SECRET ?? '',
          readSelection,
          clientFactory: anonymousFactory,
        })({ cookieHeader: header, flowHash: receipt.hash, signal });
      const response = await createProviderOwnedSigninAcknowledgment({
        environment,
        ready,
        readSelection,
        clientFactory: providerFactory,
      })({ cookieHeader: header, flowHash: receipt.hash, signal });
      if (response.headers.getSetCookie().length) return 'unavailable';
      const body: unknown = await response.json();
      if (
        !body ||
        typeof body !== 'object' ||
        !('outcome' in body) ||
        (body.outcome !== 'recovered' && body.outcome !== 'identity_changed' && body.outcome !== 'unavailable')
      )
        return 'unavailable';
      return body.outcome;
    } catch {
      return 'unavailable';
    }
  };
}
function reply(outcome: ProviderSigninAcknowledgment, status?: number): Response {
  return Response.json(
    { outcome },
    {
      status: status ?? (outcome === 'unavailable' ? 503 : outcome === 'identity_changed' ? 409 : 200),
      headers: {
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, follow',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
export function createProviderSigninAcknowledgmentHandler(
  options: Parameters<typeof createProviderSigninAcknowledgment>[0] = {},
) {
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  const acknowledge = createProviderSigninAcknowledgment({ ...options, environment });
  return async (request: Request): Promise<Response> => {
    try {
      const captured = new Request(request.clone(), { headers: new Headers(request.headers) });
      requirePublicAuthRequest(captured, PROVIDER_SIGNIN_ACKNOWLEDGMENT_PATH, 'POST', environment);
      empty.parse(await readBoundedAuthJson(captured));
      return reply(await acknowledge({ cookieHeader: captured.headers.get('cookie'), signal: captured.signal }));
    } catch (error) {
      return reply(
        'unavailable',
        error instanceof PublicAuthRequestError ? error.status : error instanceof z.ZodError ? 400 : 503,
      );
    }
  };
}
