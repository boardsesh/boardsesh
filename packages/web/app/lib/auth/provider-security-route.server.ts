import 'server-only';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { providerSecurityProviderSchema } from '@boardsesh/auth-protocol';
import { safeCallbackUrl } from '@/app/auth/signout/safe-callback-url';
import { authOptions } from './auth-options';
import { browserSessionRouteMode, type BrowserSessionCookieConfiguration } from './browser-session-mode.server';
import { resolvePublicAuthOrigin } from './canonical-auth-url';
import { requireExpectedViewer } from './expected-viewer.server';
import {
  clearProviderFlowCookie,
  newRoundTrip,
  readProviderFlowCookie,
  sealProviderFlowCookie,
  type ProviderFlowRecord,
} from './provider-flow-cookie.server';
import { authorizationUrl, providerClient } from './provider-oidc.server';
import {
  createProviderSecurityCommandClient,
  wwwProviderSecurityStaged,
  type ProviderSecurityCommandClient,
} from './provider-security-command-client.server';
import {
  DEFAULT_RETURN_PATH,
  answer,
  jsonBody,
  sameOriginPost,
  liveSession,
  localRefusal,
  refusalAnswer,
  unavailableAnswer,
  type LiveSession,
  type RouteContext,
} from './provider-security-context.server';
import {
  abortQuietly,
  continueAfterReauthentication,
  nonceHash,
  providerSecurityCallbackUrl,
  reauthenticationFlowHash,
  recoverLostReply,
  refusedStep,
  type StepResult,
} from './provider-security-flow.server';
import { handleProviderSecurityCallback } from './provider-security-callback.server';
import { SealedCookieTooLarge } from './sealed-cookie.server';

/**
 * www's provider link, unlink and reauthentication routes under
 * `AUTH_BROWSER_SESSION_MODE=better-auth` (#7596 B5e1), on the backend's
 * `provider-security-v1` commands. See docs/auth/better-auth-browser-session.md.
 *
 * - Mode unset, empty or `legacy`: every route answers 404.
 * - `better-auth` unavailable, or www's `CURRENT_STORE_PROVIDER_SECURITY_MODE`
 *   not `backend-staging`: 503.
 * - Every start and every state change is a POST whose `Origin` is this site:
 *   the `.boardsesh.com` session cookie rides on any top-level request, so it
 *   proves no intent by itself. The provider callbacks are the exception; the
 *   sealed flow cookie and its state stand in there.
 * - No reply sets or clears a session cookie of any name (HARD RULE 2): a
 *   link or unlink keeps the session token and moves only its generation, so
 *   the JSON tells the page to fetch a new 15-minute access token.
 */

/** The open flow record of this request, when it belongs to the live session; otherwise the answer. */
export function flowOfSession(
  request: NextRequest,
  cookies: BrowserSessionCookieConfiguration,
  session: LiveSession,
): ProviderFlowRecord | Response {
  const read = readProviderFlowCookie(request.headers.get('cookie'), cookies);
  if (read.kind === 'none') return localRefusal('denied', 'invalid_intent');
  if (read.kind === 'invalid')
    return localRefusal('denied', 'invalid_intent', [clearProviderFlowCookie(cookies, 'lax')]);
  const { record } = read;
  // Another account or another session than the one that started the flow.
  if (record.userId !== session.userId || record.authSessionId !== session.authSessionId)
    return localRefusal('identity_changed', 'invalid_proof', [clearProviderFlowCookie(cookies, record.sameSite)]);
  return record;
}

/** A step's result as the JSON routes answer it. */
async function stepAnswer(
  context: RouteContext,
  record: ProviderFlowRecord,
  result: StepResult,
  session: LiveSession,
): Promise<Response> {
  const clear = [clearProviderFlowCookie(context.cookies, record.sameSite)];
  switch (result.kind) {
    case 'committed':
      // The session kept its token; only its generation moved. No session cookie is written.
      return answer(
        200,
        {
          status: 'committed',
          action: record.action,
          provider: record.provider,
          generation: result.generation,
          refreshAccessToken: true,
        },
        clear,
      );
    case 'redirect':
      return answer(200, { status: 'redirect', url: result.url }, [
        sealProviderFlowCookie(context.cookies, result.record),
      ]);
    case 'refused':
      // A flow that ends here gives its intent's slot back, so closed flows never pile up to `too_many_pending`.
      if (!result.keep) await abortQuietly(context.client, session.actor, record.intentToken);
      return refusalAnswer(result.reply, result.keep ? [] : clear);
    case 'unavailable':
      // A lost reply may have committed: the record stays so `recover` can ask.
      return unavailableAnswer();
  }
}

const startSchema = z
  .object({
    action: z.enum(['link', 'unlink']),
    provider: providerSecurityProviderSchema,
    methodId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    returnTo: z.string().max(512).optional(),
  })
  .strict();

async function methods(context: RouteContext, session: LiveSession): Promise<Response> {
  let reply;
  try {
    reply = await context.client.send('methods', { actor: session.actor });
  } catch {
    return unavailableAnswer();
  }
  if (reply.outcome !== 'available') return 'code' in reply ? refusalAnswer(reply) : unavailableAnswer();
  return answer(200, {
    status: 'methods',
    userId: session.userId,
    passwordUsable: reply.passwordUsable,
    providers: reply.providers,
    configuredProviders: reply.configuredProviders,
    // Apple ID tokens are not verified by the backend, so Apple cannot reauthenticate (#7655).
    reauthentication: { password: reply.passwordUsable, google: reply.googleReauthenticationAvailable, apple: false },
    // Which providers this account can connect now, and why not when it cannot.
    linking: {
      google: reply.configuredProviders.includes('google')
        ? { available: true }
        : { available: false, reason: 'not_configured' },
      // Apple's form_post round trip is proven against a stand-in (provider-security-apple-link proof).
      apple: reply.configuredProviders.includes('apple')
        ? { available: true }
        : { available: false, reason: 'not_configured' },
    },
  });
}

async function start(request: NextRequest, context: RouteContext, session: LiveSession): Promise<Response> {
  const parsed = startSchema.safeParse(await jsonBody(request));
  if (!parsed.success) return localRefusal('denied', 'invalid_intent');
  const { action, provider } = parsed.data;
  if ((action === 'unlink') !== Boolean(parsed.data.methodId)) return localRefusal('denied', 'invalid_intent');
  // A flow still open in this browser gives its slot back before a new one starts.
  const earlier = readProviderFlowCookie(request.headers.get('cookie'), context.cookies);
  if (earlier.kind === 'open' && earlier.record.authSessionId === session.authSessionId)
    await context.client
      .send('abort', {
        actor: session.actor,
        intentToken: earlier.record.intentToken,
        preparationToken: null,
        flowHash: null,
      })
      .catch(() => undefined);
  let reply;
  try {
    reply = await context.client.send('intent', {
      actor: session.actor,
      action,
      provider,
      methodId: action === 'unlink' ? (parsed.data.methodId ?? null) : null,
    });
  } catch {
    return unavailableAnswer();
  }
  if (reply.outcome !== 'recorded') return 'code' in reply ? refusalAnswer(reply) : unavailableAnswer();
  const record: ProviderFlowRecord = {
    version: 1,
    action,
    provider,
    userId: session.userId,
    authSessionId: session.authSessionId,
    intentToken: reply.intentToken,
    recoveryToken: reply.recoveryToken,
    expiresAt: Date.parse(reply.expiresAt),
    returnTo: safeCallbackUrl(parsed.data.returnTo ?? DEFAULT_RETURN_PATH),
    // Apple answers its round trip with a cross-site form POST.
    sameSite: action === 'link' && provider === 'apple' ? 'none' : 'lax',
  };
  let sealed: string;
  try {
    sealed = sealProviderFlowCookie(context.cookies, record);
  } catch (error) {
    if (!(error instanceof SealedCookieTooLarge)) throw error;
    // The flow could not be carried: give the intent back rather than leave it pending.
    await abortQuietly(context.client, session.actor, reply.intentToken);
    return unavailableAnswer();
  }
  return answer(200, { status: 'reauthentication_required', action, provider, expiresAt: reply.expiresAt }, [sealed]);
}

async function reauthenticateWithPassword(
  request: NextRequest,
  context: RouteContext,
  session: LiveSession,
  record: ProviderFlowRecord,
): Promise<Response> {
  const body = await jsonBody(request);
  const password = body?.password;
  if (typeof password !== 'string' || !password || password.length > 1024)
    return localRefusal('denied', 'invalid_proof');
  let reply;
  try {
    reply = await context.client.send('reauthenticate-password', {
      actor: session.actor,
      intentToken: record.intentToken,
      password,
    });
  } catch {
    return unavailableAnswer();
  }
  if (reply.outcome !== 'proved') return stepAnswer(context, record, refusedStep(reply), session);
  const proved = { ...record, reauthenticationToken: reply.reauthenticationToken };
  const result = await continueAfterReauthentication(
    context.client,
    authOptions,
    session.actor,
    proved,
    context.publicOrigin,
  );
  // Keep the proof in the flow even when the next step failed, so `recover` and a retry can use it.
  if (result.kind === 'unavailable') return unavailableAnswer([sealProviderFlowCookie(context.cookies, proved)]);
  return stepAnswer(context, proved, result, session);
}

async function startGoogleReauthentication(
  context: RouteContext,
  session: LiveSession,
  record: ProviderFlowRecord,
): Promise<Response> {
  const google = providerClient(authOptions, 'google');
  if (!google) return localRefusal('reauthentication_unavailable', 'provider_unavailable');
  const reauthentication = newRoundTrip();
  let reply;
  try {
    reply = await context.client.send('bind-google-reauthentication', {
      actor: session.actor,
      intentToken: record.intentToken,
      flowHash: reauthenticationFlowHash(reauthentication.state),
      nonceHash: nonceHash(reauthentication.nonce),
    });
  } catch {
    return unavailableAnswer();
  }
  if (reply.outcome !== 'bound') return stepAnswer(context, record, refusedStep(reply), session);
  let url: string;
  try {
    url = await authorizationUrl(
      google,
      reauthentication,
      providerSecurityCallbackUrl(context.publicOrigin, 'google'),
      'reauthenticate',
    );
  } catch {
    return unavailableAnswer();
  }
  return answer(200, { status: 'redirect', url }, [
    sealProviderFlowCookie(context.cookies, { ...record, reauthentication }),
  ]);
}

async function abort(context: RouteContext, session: LiveSession, record: ProviderFlowRecord): Promise<Response> {
  const clear = [clearProviderFlowCookie(context.cookies, record.sameSite)];
  let reply;
  try {
    reply = await context.client.send('abort', {
      actor: session.actor,
      intentToken: record.intentToken,
      preparationToken: null,
      flowHash: null,
    });
  } catch {
    return unavailableAnswer();
  }
  if (reply.outcome !== 'aborted') return 'code' in reply ? refusalAnswer(reply, clear) : unavailableAnswer();
  return answer(200, { status: 'aborted' }, clear);
}

async function recover(context: RouteContext, session: LiveSession, record: ProviderFlowRecord): Promise<Response> {
  if (!record.reauthenticationToken) return localRefusal('denied', 'invalid_intent');
  return stepAnswer(
    context,
    record,
    await recoverLostReply(context.client, session.actor, record, record.reauthenticationToken),
    session,
  );
}

/** `/api/auth/provider-security/<step...>`. */
export async function routeProviderSecurity(request: NextRequest, step: readonly string[]): Promise<Response> {
  const mode = browserSessionRouteMode();
  if (mode.kind === 'legacy') return answer(404, { error: 'not_found' });
  if (mode.kind === 'unavailable' || !wwwProviderSecurityStaged()) return unavailableAnswer();
  let client: ProviderSecurityCommandClient;
  try {
    client = createProviderSecurityCommandClient();
  } catch {
    return unavailableAnswer();
  }
  const publicOrigin = resolvePublicAuthOrigin() ?? request.nextUrl.origin;
  const context: RouteContext = { cookies: mode.cookies, client, publicOrigin };
  const path = step.join('/');

  if (path === 'callback/google' || path === 'callback/apple')
    return handleProviderSecurityCallback(request, context, path === 'callback/google' ? 'google' : 'apple');
  if (path === 'methods') {
    if (request.method !== 'GET') return answer(405, { error: 'method_not_allowed' });
    const session = await liveSession(request, context.cookies);
    return session instanceof Response ? session : methods(context, session);
  }
  const steps = new Set([
    'start',
    'reauthenticate/password',
    'reauthenticate/google',
    'reauthenticate/apple',
    'abort',
    'recover',
  ]);
  if (!steps.has(path)) return answer(404, { error: 'not_found' });
  if (!sameOriginPost(request, publicOrigin)) return answer(403, { error: 'origin_refused' });
  const session = await liveSession(request, context.cookies);
  if (session instanceof Response) return session;
  // A tab that shows another account than the cookie names now writes nothing.
  const viewerChanged = requireExpectedViewer(
    request,
    { user: { id: session.userId }, authSessionId: session.authSessionId },
    { route: '/api/auth/provider-security', missing: 'reject' },
  );
  if (viewerChanged) return viewerChanged;
  if (path === 'start') return start(request, context, session);
  const record = flowOfSession(request, context.cookies, session);
  if (record instanceof Response) return record;
  try {
    switch (path) {
      case 'reauthenticate/password':
        return await reauthenticateWithPassword(request, context, session, record);
      case 'reauthenticate/google':
        return await startGoogleReauthentication(context, session, record);
      case 'reauthenticate/apple':
        // The backend verifies no Apple ID token, so Apple cannot prove a fresh sign-in (#7655).
        return localRefusal('reauthentication_unavailable', 'provider_unavailable');
      case 'abort':
        return await abort(context, session, record);
      default:
        return await recover(context, session, record);
    }
  } catch (error) {
    if (!(error instanceof SealedCookieTooLarge)) throw error;
    await abortQuietly(context.client, session.actor, record.intentToken);
    return unavailableAnswer([clearProviderFlowCookie(context.cookies, record.sameSite)]);
  }
}
