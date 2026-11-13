import 'server-only';
import type { Session } from 'next-auth';
import type { NextRequest } from 'next/server';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import {
  browserBackendLeaseOwnerSchema,
  browserBackendLeaseReplySchema,
  type BrowserBackendLeaseOwner,
  type BrowserBackendLeaseReply,
} from '@boardsesh/auth-protocol/browser-backend-lease';
import type { AuthServiceEnvironment } from './auth-command-transport.server';
import { BROWSER_CORRELATION_COOKIE } from './browser-proof-cookies.server';
import { publicBrowserConsumersReady } from './browser-consumer-readiness';
import {
  readPresentedBrowserSelection,
  type AdmittedBrowserSelection,
  type PresentedBrowserSelection,
} from './presented-browser-selection.server';
import { issueBrowserBackendToken } from './browser-backend-token.server';

type Observation = PresentedBrowserSelection | { readonly status: 'legacy' };
export type SelectedBrowserPublicSession = Session & { readonly browserSelection: BrowserBackendLeaseOwner };

/** Reserved malformed/suffixed correlation names also forbid legacy fallback. */
function correlationPresent(header: string | null): boolean {
  return (header ?? '').split(';').some((part) => part.trim().split('=', 1)[0].startsWith(BROWSER_CORRELATION_COOKIE));
}
export function publicBrowserLeaseOwner(selection: AdmittedBrowserSelection): Readonly<BrowserBackendLeaseOwner> {
  const owner = browserBackendLeaseOwnerSchema.parse({
    userId: selection.session.userId,
    authSessionId: selection.session.authSessionId,
    generation: selection.session.generation,
    cursor: { bindingId: selection.cursor.bindingId, version: selection.cursor.version },
  });
  return Object.freeze({ ...owner, cursor: Object.freeze(owner.cursor) });
}
function publicSession(selection: AdmittedBrowserSelection): SelectedBrowserPublicSession {
  if (
    selection.user.id !== selection.session.userId ||
    !(Date.parse(selection.session.expiresAt) > Date.now()) ||
    !(Date.parse(selection.cursor.bindingExpiresAt) > Date.now())
  )
    throw new Error('BROWSER_CONSUMER_UNAVAILABLE');
  return Object.freeze({
    user: Object.freeze({
      id: selection.user.id,
      email: selection.user.email,
      name: selection.user.name,
      image: selection.user.image,
    }),
    expires: new Date(
      Math.min(Date.parse(selection.session.expiresAt), Date.parse(selection.cursor.bindingExpiresAt)),
    ).toISOString(),
    authSessionId: selection.session.authSessionId,
    authGeneration: selection.session.generation,
    browserSelection: publicBrowserLeaseOwner(selection),
  });
}
function refusalStatus(status: Observation['status']): number {
  return status === 'unavailable' ? 503 : status === 'conflict' ? 409 : 401;
}
const headers = { 'Cache-Control': 'private, no-store' };

/** Thin server composition only. Tests/owned browser proofs can inject qualified
 * adapters; production always uses the code-owned readiness gate below. */
export function createBrowserConsumerFacade(dependencies: {
  readonly ready: () => boolean;
  readonly environment: () => AuthServiceEnvironment;
  readonly readSelection: typeof readPresentedBrowserSelection;
  readonly issueToken: typeof issueBrowserBackendToken;
}) {
  async function observe(cookieHeader: string | null): Promise<Observation> {
    try {
      const environment = { ...dependencies.environment() };
      const mode = browserBindingMode(environment);
      if (mode === 'legacy' && !correlationPresent(cookieHeader)) return { status: 'legacy' };
      if (!dependencies.ready()) return { status: 'unavailable' };
      return await dependencies.readSelection(cookieHeader, { environment });
    } catch {
      return { status: 'unavailable' };
    }
  }
  async function lease(selection: AdmittedBrowserSelection): Promise<BrowserBackendLeaseReply> {
    try {
      const owner = publicBrowserLeaseOwner(selection);
      const result = await dependencies.issueToken(selection);
      if (result.status !== 'admitted') return { status: result.status };
      const usableForMs = Math.min(result.usableForMs, Math.floor(Date.parse(result.expiresAt) - Date.now()));
      if (
        result.userId !== owner.userId ||
        result.authSessionId !== owner.authSessionId ||
        result.cursor.bindingId !== owner.cursor.bindingId ||
        result.cursor.version !== owner.cursor.version ||
        !Number.isSafeInteger(result.usableForMs) ||
        result.usableForMs <= 0 ||
        result.usableForMs > 120_000
      )
        return { status: 'unavailable' };
      const parsed = browserBackendLeaseReplySchema.parse({
        status: 'admitted',
        token: result.token,
        usableForMs,
        owner,
      });
      return Object.freeze({ ...parsed, owner });
    } catch {
      return { status: 'unavailable' };
    }
  }
  return {
    observe,
    /** A source-free public identity projection; it performs no cookie writes. */
    session(this: void, selection: AdmittedBrowserSelection): SelectedBrowserPublicSession {
      return publicSession(selection);
    },
    lease,
    /** null is the ONLY legacy delegation signal. Every selected refusal is a
     * final response, including when the public readiness gate is still false. */
    async sessionResponse(this: void, request: NextRequest): Promise<Response | null> {
      const observed = await observe(request.headers.get('cookie'));
      if (observed.status === 'legacy') return null;
      if (observed.status === 'admitted') {
        try {
          return Response.json(publicSession(observed), { headers });
        } catch {
          return Response.json({ error: 'unavailable' }, { status: 503, headers });
        }
      }
      if (observed.status === 'anonymous') return Response.json({}, { headers });
      return Response.json({ error: observed.status }, { status: refusalStatus(observed.status), headers });
    },
    async tokenResponse(this: void, request: NextRequest): Promise<Response | null> {
      const observed = await observe(request.headers.get('cookie'));
      if (observed.status === 'legacy') return null;
      if (observed.status !== 'admitted') {
        const status =
          observed.status === 'unavailable' ? 'unavailable' : observed.status === 'conflict' ? 'conflict' : 'denied';
        return Response.json({ status }, { status: refusalStatus(status), headers });
      }
      const result = await lease(observed);
      return Response.json(result, {
        status: result.status === 'admitted' ? 200 : refusalStatus(result.status),
        headers,
      });
    },
  };
}

export const browserConsumerFacade = createBrowserConsumerFacade({
  ready: publicBrowserConsumersReady,
  environment: () => process.env,
  readSelection: readPresentedBrowserSelection,
  issueToken: issueBrowserBackendToken,
});
/** Native's outer catch-all owns insertion before its legacy session delegate. */
export const selectedBrowserSessionResponse = (request: NextRequest) => browserConsumerFacade.sessionResponse(request);
export const selectedBrowserBackendTokenResponse = (request: NextRequest) =>
  browserConsumerFacade.tokenResponse(request);
