import 'server-only';
import type { NextRequest } from 'next/server';
import { firstPasswordReplyStatus, type FirstPasswordReply } from '@boardsesh/auth-protocol';
import { sendFirstPasswordConfirmationEmail } from '@boardsesh/email';
import { browserSessionRouteMode, type BrowserSessionCookieConfiguration } from './browser-session-mode.server';
import { resolvePublicAuthOrigin } from './canonical-auth-url';
import { requireExpectedViewer } from './expected-viewer.server';
import {
  createFirstPasswordCommandClient,
  wwwFirstPasswordStaged,
  type FirstPasswordCommandClient,
} from './first-password-command-client.server';
import {
  clearFirstPasswordFlowCookie,
  firstPasswordOperationKey,
  readFirstPasswordFlowCookie,
  sealFirstPasswordFlowCookie,
  type FirstPasswordFlowRecord,
} from './first-password-flow-cookie.server';
import { answer, jsonBody, liveSession, sameOriginPost, type LiveSession } from './provider-security-context.server';
import { sameSecret } from './provider-security-flow.server';

/**
 * www's first-password routes under `AUTH_BROWSER_SESSION_MODE=better-auth`
 * (#7596 B5e2), on the backend's `first-password-v1` commands (B5c2). An
 * account with no password and a Google or Apple identity asks for an email
 * (decision of 2026-11-18 on #7596); the emailed link opens
 * `/auth/confirm-first-password` in the same browser, where the same session
 * chooses the password. See docs/auth/better-auth-browser-session.md.
 *
 * - Mode unset, empty or `legacy`: 404. `better-auth` unavailable, or www's
 *   `CURRENT_STORE_FIRST_PASSWORD_MODE` not `backend-staging`: 503.
 * - Every step is a POST with this site's `Origin` and the expected-viewer
 *   header, read from the raw `Cookie` header, with the canonical session only
 *   (a legacy-only browser gets `canonical_session_required`).
 * - No reply sets or clears a session cookie. A commit keeps the session's
 *   token and moves its generation, so the JSON tells the page to fetch a new
 *   access token.
 * - The email goes out through the shared mailer (`@boardsesh/email`), as the
 *   reset and verification emails do. The backend plans it and sends nothing.
 */

type Context = { cookies: BrowserSessionCookieConfiguration; client: FirstPasswordCommandClient; publicOrigin: string };

function refused(reply: { outcome: string; code: string }, status: number, setCookies: readonly string[] = []) {
  return answer(status, { status: 'refused', outcome: reply.outcome, code: reply.code }, setCookies);
}
const unavailable = (setCookies: readonly string[] = []) => answer(503, { status: 'unavailable' }, setCookies);

/** A backend refusal as www answers it; the flow cookie goes when the challenge can no longer be used. */
function refusalOf(reply: FirstPasswordReply, context: Context): Response {
  if (!('code' in reply)) return unavailable();
  const terminal = reply.code !== 'invalid_proof' && reply.outcome !== 'canonical_session_required';
  return refused(
    reply,
    firstPasswordReplyStatus(reply),
    terminal ? [clearFirstPasswordFlowCookie(context.cookies)] : [],
  );
}

function committed(context: Context, generation: number): Response {
  return answer(200, { status: 'committed', generation, refreshAccessToken: true }, [
    clearFirstPasswordFlowCookie(context.cookies),
  ]);
}

async function requestEmail(context: Context, session: LiveSession): Promise<Response> {
  let reply: FirstPasswordReply;
  try {
    reply = await context.client.send('request', { actor: session.actor });
  } catch {
    return unavailable();
  }
  if (reply.outcome !== 'issued') return refusalOf(reply, context);
  const record: FirstPasswordFlowRecord = {
    version: 1,
    userId: session.userId,
    authSessionId: session.authSessionId,
    challengeToken: reply.challengeToken,
    recoveryToken: reply.recoveryToken,
    expiresAt: Date.parse(reply.expiresAt),
  };
  // Sealed before the email goes out, so a record that cannot be carried never leaves a link behind.
  let sealed: string;
  try {
    sealed = sealFirstPasswordFlowCookie(context.cookies, record);
  } catch {
    return unavailable();
  }
  try {
    await sendFirstPasswordConfirmationEmail(
      reply.mailPlan.recipient,
      reply.mailPlan.token,
      firstPasswordOperationKey(reply.challengeToken),
      context.publicOrigin,
    );
  } catch {
    // No email, no flow: asking again supersedes this challenge.
    return unavailable();
  }
  return answer(200, { status: 'sent', expiresAt: reply.expiresAt }, [sealed]);
}

/**
 * The flow this browser holds for the emailed link's operation key, when the
 * live session is the one that asked. Otherwise the answer, which changes
 * nothing: another browser has no such flow; another account (or a new
 * sign-in) is not the session that asked.
 */
function flowForLink(
  request: NextRequest,
  context: Context,
  session: LiveSession,
  operation: unknown,
): FirstPasswordFlowRecord | Response {
  const read = readFirstPasswordFlowCookie(request.headers.get('cookie'), context.cookies);
  if (
    read.kind !== 'open' ||
    typeof operation !== 'string' ||
    !sameSecret(firstPasswordOperationKey(read.record.challengeToken), operation)
  )
    return answer(409, { status: 'other_browser' });
  if (read.record.userId !== session.userId || read.record.authSessionId !== session.authSessionId)
    return answer(409, { status: 'other_account' });
  return read.record;
}

async function status(context: Context, session: LiveSession, record: FirstPasswordFlowRecord) {
  let reply: FirstPasswordReply;
  try {
    reply = await context.client.send('read', { actor: session.actor, challengeToken: record.challengeToken });
  } catch {
    return unavailable();
  }
  if (reply.outcome === 'pending' || reply.outcome === 'prepared')
    return answer(200, { status: 'pending', expiresAt: reply.expiresAt });
  return refusalOf(reply, context);
}

async function recoverLost(context: Context, session: LiveSession, record: FirstPasswordFlowRecord) {
  if (!record.preparationToken) return refused({ outcome: 'denied', code: 'invalid_proof' }, 400);
  let reply: FirstPasswordReply;
  try {
    reply = await context.client.send('recover', {
      actor: session.actor,
      challengeToken: record.challengeToken,
      preparationToken: record.preparationToken,
      recoveryToken: record.recoveryToken,
    });
  } catch {
    return unavailable([sealFirstPasswordFlowCookie(context.cookies, record)]);
  }
  if (reply.outcome === 'recovered') return committed(context, reply.generation);
  return refusalOf(reply, context);
}

async function confirm(
  context: Context,
  session: LiveSession,
  record: FirstPasswordFlowRecord,
  body: Record<string, unknown>,
): Promise<Response> {
  const { token, password, confirmPassword } = body;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
    return refused({ outcome: 'denied', code: 'invalid_proof' }, 400);
  if (typeof password !== 'string' || password.length < 8 || password.length > 128)
    return answer(400, { status: 'invalid_password' });
  if (confirmPassword !== password) return answer(400, { status: 'password_mismatch' });
  let prepared: FirstPasswordReply;
  try {
    prepared = await context.client.send('prepare', {
      actor: session.actor,
      challengeToken: record.challengeToken,
      confirmationToken: token,
      password,
      confirmPassword,
    });
  } catch {
    return unavailable();
  }
  if (prepared.outcome !== 'prepared' || prepared.operation !== 'prepare') return refusalOf(prepared, context);
  const withPreparation = { ...record, preparationToken: prepared.preparationToken };
  let finalized: FirstPasswordReply;
  try {
    finalized = await context.client.send('finalize', {
      actor: session.actor,
      challengeToken: record.challengeToken,
      preparationToken: prepared.preparationToken,
    });
  } catch {
    // The reply may have followed a commit: ask once, with the same session.
    return recoverLost(context, session, withPreparation);
  }
  if (finalized.outcome === 'committed') return committed(context, finalized.generation);
  return refusalOf(finalized, context);
}

/** `/api/auth/first-password/<step>`: `request`, `status`, `confirm`, `recover`. */
export async function routeFirstPassword(request: NextRequest, step: readonly string[]): Promise<Response> {
  const mode = browserSessionRouteMode();
  if (mode.kind === 'legacy') return answer(404, { error: 'not_found' });
  if (mode.kind === 'unavailable' || !wwwFirstPasswordStaged()) return unavailable();
  const path = step.join('/');
  if (!['request', 'status', 'confirm', 'recover'].includes(path)) return answer(404, { error: 'not_found' });
  // The emailed link is built from this origin: only the configured one, never the request's (fail closed).
  const publicOrigin = resolvePublicAuthOrigin();
  if (!publicOrigin) return unavailable();
  if (!sameOriginPost(request, publicOrigin)) return answer(403, { error: 'origin_refused' });
  let client: FirstPasswordCommandClient;
  try {
    client = createFirstPasswordCommandClient();
  } catch {
    return unavailable();
  }
  const context: Context = { cookies: mode.cookies, client, publicOrigin };
  const body = await jsonBody(request);
  if (!body) return refused({ outcome: 'denied', code: 'invalid_proof' }, 400);
  const session = await liveSession(request, context.cookies);
  if (session instanceof Response) return session;
  const viewerChanged = requireExpectedViewer(
    request,
    { user: { id: session.userId }, authSessionId: session.authSessionId },
    { route: '/api/auth/first-password', missing: 'reject' },
  );
  if (viewerChanged) return viewerChanged;
  if (path === 'request') return requestEmail(context, session);
  const record = flowForLink(request, context, session, body.operation);
  if (record instanceof Response) return record;
  if (path === 'status') return status(context, session, record);
  if (path === 'recover') return recoverLost(context, session, record);
  return confirm(context, session, record, body);
}
