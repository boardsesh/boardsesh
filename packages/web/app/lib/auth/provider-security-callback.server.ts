import 'server-only';
import type { NextRequest } from 'next/server';
import type { ProviderSecurityActor, ProviderSecurityProvider } from '@boardsesh/auth-protocol';
import { authOptions } from './auth-options';
import {
  clearProviderFlowCookie,
  readProviderFlowCookie,
  sealProviderFlowCookie,
  type ProviderFlowRecord,
  type ProviderFlowRoundTrip,
} from './provider-flow-cookie.server';
import { providerClient, redeemAuthorizationCode, type VerifiedProviderIdentity } from './provider-oidc.server';
import {
  abortQuietly,
  continueAfterReauthentication,
  finishLink,
  providerSecurityCallbackUrl,
  reauthenticationFlowHash,
  refusedStep,
  sameSecret,
  type StepResult,
} from './provider-security-flow.server';
import { DEFAULT_RETURN_PATH, liveSession, type RouteContext } from './provider-security-context.server';
import { SealedCookieTooLarge } from './sealed-cookie.server';

/**
 * The provider callbacks of link and Google reauthentication (#7596 B5e1):
 * `/api/auth/provider-security/callback/google` (GET) and `.../apple`
 * (Apple's cross-site POST, held, then the same-site GET that resumes it).
 *
 * They answer with a 303 back to the page the flow started from, with
 * `providerSecurity=<result>` in its query: `linked`, `unlinked`, `cancelled`,
 * `unavailable`, or the refusal's code. They never write a session cookie;
 * the next page load fetches a new access token for the moved generation.
 */

const RESUME_PARAM = 'resume';
const MAX_FORM_BYTES = 16_384;

function redirectTo(
  context: RouteContext,
  path: string,
  result: string,
  setCookies: readonly string[] = [],
  provider?: ProviderSecurityProvider,
): Response {
  const destination = new URL(path, context.publicOrigin);
  destination.searchParams.set('providerSecurity', result);
  // Which provider the result is about, for the page's copy.
  if (provider) destination.searchParams.set('provider', provider);
  const response = new Response(null, {
    status: 303,
    headers: { Location: destination.href, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' },
  });
  for (const setCookie of setCookies) response.headers.append('Set-Cookie', setCookie);
  return response;
}

/** The path a step's result sends the browser to, and what happens to the flow cookie. */
async function resultRedirect(
  context: RouteContext,
  record: ProviderFlowRecord,
  result: StepResult,
  actor: ProviderSecurityActor,
): Promise<Response> {
  const clear = [clearProviderFlowCookie(context.cookies, record.sameSite)];
  switch (result.kind) {
    case 'committed':
      return redirectTo(
        context,
        record.returnTo,
        record.action === 'link' ? 'linked' : 'unlinked',
        clear,
        record.provider,
      );
    case 'redirect': {
      const response = new Response(null, {
        status: 303,
        headers: { Location: result.url, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' },
      });
      response.headers.append('Set-Cookie', sealProviderFlowCookie(context.cookies, result.record));
      return response;
    }
    case 'refused': {
      const { outcome, code } = result.reply;
      // A flow that ends here gives its intent's slot back (#7805 review, L2).
      if (!result.keep) await abortQuietly(context.client, actor, record.intentToken);
      return redirectTo(
        context,
        record.returnTo,
        outcome === 'denied' ? code : outcome,
        result.keep ? [] : clear,
        record.provider,
      );
    }
    case 'unavailable':
      // A lost reply may have committed: keep the record so the page can ask `recover`.
      return redirectTo(context, record.returnTo, 'unavailable', [sealProviderFlowCookie(context.cookies, record)]);
  }
}

async function formFields(request: NextRequest): Promise<URLSearchParams | undefined> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded')
    return undefined;
  const text = await request.text();
  return Buffer.byteLength(text, 'utf8') > MAX_FORM_BYTES ? undefined : new URLSearchParams(text);
}

function single(fields: URLSearchParams, name: string): string | null {
  const values = fields.getAll(name);
  return values.length === 1 && values[0] ? values[0] : null;
}

/**
 * Apple's `form_post` arrives cross-site, so it carries the SameSite=None flow
 * cookie but not the Lax session cookie. Hold it in the flow cookie (after
 * checking its state against the sealed one) and continue on a same-site GET,
 * which carries both.
 */
async function holdApplePost(request: NextRequest, context: RouteContext, record: ProviderFlowRecord) {
  const fields = await formFields(request);
  const state = fields ? single(fields, 'state') : null;
  if (!fields || !record.providerLeg || record.provider !== 'apple' || !sameSecret(record.providerLeg.state, state))
    return redirectTo(context, record.returnTo, 'state_mismatch');
  const code = single(fields, 'code');
  const held: ProviderFlowRecord = {
    ...record,
    heldCallback: { state: state!, code: fields.has('error') ? null : code },
  };
  const resume = new URL(`/api/auth/provider-security/callback/apple`, context.publicOrigin);
  resume.searchParams.set(RESUME_PARAM, '1');
  const response = new Response(null, {
    status: 303,
    headers: { Location: resume.href, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' },
  });
  try {
    response.headers.append('Set-Cookie', sealProviderFlowCookie(context.cookies, held));
  } catch (error) {
    if (!(error instanceof SealedCookieTooLarge)) throw error;
    // No session rides on this cross-site POST, so the intent cannot be ended here; it expires.
    return redirectTo(context, record.returnTo, 'unavailable', [
      clearProviderFlowCookie(context.cookies, record.sameSite),
    ]);
  }
  return response;
}

type Arrival = { leg: 'reauthenticate' | 'link'; roundTrip: ProviderFlowRoundTrip; state: string; code: string | null };

/** Which round trip this callback finishes, by the state it carries; undefined when it matches none. */
function arrivalOf(request: NextRequest, record: ProviderFlowRecord, provider: ProviderSecurityProvider) {
  if (provider === 'apple') {
    const held = record.heldCallback;
    const params = [...request.nextUrl.searchParams.keys()];
    if (!held || !record.providerLeg || params.length !== 1 || params[0] !== RESUME_PARAM) return undefined;
    if (!sameSecret(record.providerLeg.state, held.state)) return undefined;
    return { leg: 'link', roundTrip: record.providerLeg, state: held.state, code: held.code } satisfies Arrival;
  }
  const state = single(request.nextUrl.searchParams, 'state');
  const code = request.nextUrl.searchParams.has('error') ? null : single(request.nextUrl.searchParams, 'code');
  if (!state) return undefined;
  if (record.reauthentication && sameSecret(record.reauthentication.state, state))
    return { leg: 'reauthenticate', roundTrip: record.reauthentication, state, code } satisfies Arrival;
  if (record.provider === 'google' && record.providerLeg && sameSecret(record.providerLeg.state, state))
    return { leg: 'link', roundTrip: record.providerLeg, state, code } satisfies Arrival;
  return undefined;
}

export async function handleProviderSecurityCallback(
  request: NextRequest,
  context: RouteContext,
  provider: ProviderSecurityProvider,
): Promise<Response> {
  const read = readProviderFlowCookie(request.headers.get('cookie'), context.cookies);
  if (read.kind !== 'open')
    return redirectTo(
      context,
      DEFAULT_RETURN_PATH,
      'expired',
      read.kind === 'invalid' ? [clearProviderFlowCookie(context.cookies, 'lax')] : [],
    );
  const { record } = read;
  if (provider === 'apple' && request.method === 'POST') return holdApplePost(request, context, record);
  if (request.method !== 'GET') return redirectTo(context, record.returnTo, 'state_mismatch');
  const arrival = arrivalOf(request, record, provider);
  // A callback that names no round trip of this flow ends nothing: it may be someone else's.
  if (!arrival) return redirectTo(context, record.returnTo, 'state_mismatch');
  const pending: ProviderFlowRecord = { ...record, heldCallback: undefined };
  const clear = [clearProviderFlowCookie(context.cookies, record.sameSite)];

  // The session the flow started with must be the one this browser presents now.
  const session = await liveSession(request, context.cookies);
  if (session instanceof Response) return redirectTo(context, record.returnTo, 'session_required');
  if (session.userId !== record.userId || session.authSessionId !== record.authSessionId)
    return redirectTo(context, record.returnTo, 'identity_changed', clear);

  try {
    return await finishArrival(context, pending, arrival, session.actor);
  } catch (error) {
    if (!(error instanceof SealedCookieTooLarge)) throw error;
    await abortQuietly(context.client, session.actor, record.intentToken);
    return redirectTo(context, record.returnTo, 'unavailable', clear);
  }
}

async function finishArrival(
  context: RouteContext,
  pending: ProviderFlowRecord,
  arrival: Arrival,
  actor: ProviderSecurityActor,
): Promise<Response> {
  const record = pending;
  const clear = [clearProviderFlowCookie(context.cookies, record.sameSite)];
  if (arrival.code === null) {
    // A cancelled Google reauthentication keeps the intent: the climber can still use the password (L6).
    if (arrival.leg === 'reauthenticate')
      return redirectTo(context, record.returnTo, 'cancelled', [
        sealProviderFlowCookie(context.cookies, { ...record, reauthentication: undefined }),
      ]);
    await abortQuietly(context.client, actor, record.intentToken);
    return redirectTo(context, record.returnTo, 'cancelled', clear);
  }
  const client = providerClient(authOptions, arrival.leg === 'reauthenticate' ? 'google' : record.provider);
  if (!client) {
    await abortQuietly(context.client, actor, record.intentToken);
    return redirectTo(context, record.returnTo, 'unavailable', clear);
  }
  const redirectUri = providerSecurityCallbackUrl(context.publicOrigin, client.provider);
  let identity: VerifiedProviderIdentity;
  try {
    identity = await redeemAuthorizationCode(client, arrival.roundTrip, redirectUri, arrival.code);
  } catch {
    await abortQuietly(context.client, actor, record.intentToken);
    return redirectTo(context, record.returnTo, 'provider_not_verified', clear);
  }

  if (arrival.leg === 'link')
    return resultRedirect(
      context,
      pending,
      await finishLink(context.client, actor, pending, arrival.state, identity),
      actor,
    );

  let proved;
  try {
    proved = await context.client.send('reauthenticate-google', {
      actor,
      intentToken: record.intentToken,
      flowHash: reauthenticationFlowHash(arrival.state),
      nonce: arrival.roundTrip.nonce,
      idToken: identity.idToken,
    });
  } catch {
    return redirectTo(context, record.returnTo, 'unavailable', [sealProviderFlowCookie(context.cookies, pending)]);
  }
  if (proved.outcome !== 'proved') return resultRedirect(context, pending, refusedStep(proved), actor);
  const withProof: ProviderFlowRecord = {
    ...pending,
    reauthentication: undefined,
    reauthenticationToken: proved.reauthenticationToken,
  };
  return resultRedirect(
    context,
    withProof,
    await continueAfterReauthentication(context.client, authOptions, actor, withProof, context.publicOrigin),
    actor,
  );
}
