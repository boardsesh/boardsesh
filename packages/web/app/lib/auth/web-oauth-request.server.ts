import 'server-only';
import type { NextAuthOptions } from 'next-auth';
import type { NextRequest } from 'next/server';
import { stringifySetCookie } from 'cookie';
import { AUTH_BACKEND_UNAVAILABLE } from '@boardsesh/auth-protocol/client-errors';
import { AUTH_COMMAND_REQUEST_BYTES, type WebOAuthProvider } from '@boardsesh/auth-protocol';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { createWebOAuthCommandClient, webOAuthMode } from './web-oauth-command-client.server';
import { createWebOAuthIdentityAuthRequest, createWebOAuthLogger } from './web-oauth-auth.server';
import { withSessionLinkGuard } from './oauth-link-guard.server';
import { resolvePublicAuthOrigin } from './canonical-auth-url';
import {
  createWebOAuthCookieScope,
  findWebOAuthCallbackScope,
  findWebOAuthFlowsToRetire,
  holdAppleOAuthCallback,
  readAppleOAuthCallbackState,
  resumeAppleOAuthCallback,
  scopedWebOAuthCookies,
  webOAuthFlowHash,
} from './web-oauth-continuation.server';
import { readExpoReturnForState, redirectExpoOAuthResponse } from './expo-web-oauth-return';
import { PLAIN_SESSION_COOKIE_NAME, SECURE_SESSION_COOKIE_NAME } from './secure-cookies';
import { checkRateLimit } from './rate-limiter';
import { trustedClientRateLimitKey } from './trusted-client-ip.server';

type RouteContext = { params: Promise<{ nextauth: string[] }> };
type InvokeAuth = (request: NextRequest, options: NextAuthOptions) => Promise<Response>;
const CONTINUATION_PARAM = 'boardseshOAuthContinue';
const providers = new Set<string>(['google', 'apple', 'facebook']);
const flowCookieKeys = ['state', 'pkceCodeVerifier', 'nonce', 'callbackUrl'] as const;
/** Each anonymous start spends one slot of the backend's process-wide `intent` budget. */
const OAUTH_STARTS_PER_CLIENT = 20;

function boundedFlowCookies(base: NextAuthOptions, scope: string): NextAuthOptions['cookies'] {
  const cookies = scopedWebOAuthCookies(base, scope);
  if (!cookies?.callbackUrl) return reject();
  cookies.callbackUrl = {
    ...cookies.callbackUrl,
    options: { ...cookies.callbackUrl.options, maxAge: 15 * 60 },
  };
  return cookies;
}

/** Retire only this authenticated flow, even when a buffered handler response is withheld. */
function clearObservedFlowCookies(
  response: Response,
  request: NextRequest,
  base: NextAuthOptions,
  scope: string,
): Response {
  const observed = new Set((request.headers.get('cookie') ?? '').split(';').map((part) => part.trim().split('=')[0]));
  for (const key of flowCookieKeys) {
    const configured = base.cookies?.[key];
    if (!configured) continue;
    const name = `${configured.name}.${scope}`;
    if (observed.has(name))
      response.headers.append(
        'Set-Cookie',
        stringifySetCookie({ ...configured.options, name, value: '', maxAge: 0, expires: new Date(0) }),
      );
  }
  return response;
}

function reject(): never {
  throw new AuthBackendUnavailableError();
}
function privacy(response: Response): Response {
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('CDN-Cache-Control', 'no-store');
  response.headers.set('Vercel-CDN-Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Robots-Tag', 'noindex, follow');
  return response;
}

/** A missing cookie is distinct from malformed, ambiguous or incomplete actor material. */
export function readWebOAuthActorCookie(request: NextRequest): string | null {
  const names = [SECURE_SESSION_COOKIE_NAME, PLAIN_SESSION_COOKIE_NAME];
  const entries: { name: string; content: string }[] = [];
  for (const rawPart of (request.headers.get('cookie') ?? '').split(';')) {
    const part = rawPart.trim();
    const separator = part.indexOf('=');
    const name = separator < 0 ? part : part.slice(0, separator).trim();
    if (!names.some((reserved) => name.startsWith(reserved))) continue;
    if (separator < 0) return reject();
    entries.push({ name, content: part.slice(separator + 1).trim() });
  }
  if (entries.length === 0) return null;
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) return reject();
  const families = names.filter((name) => entries.some((entry) => entry.name.startsWith(name)));
  if (families.length !== 1 || entries.some((entry) => !entry.content)) return reject();
  const base = families[0];
  if (entries.some((entry) => entry.name === base)) {
    if (entries.length !== 1) return reject();
  } else {
    entries.sort(
      (first, second) => Number(first.name.slice(base.length + 1)) - Number(second.name.slice(base.length + 1)),
    );
    if (entries.some((entry, index) => entry.name !== `${base}.${index}`)) return reject();
  }
  try {
    const result = decodeURIComponent(entries.map((entry) => entry.content).join(''));
    if (!result || new TextEncoder().encode(result).byteLength > AUTH_COMMAND_REQUEST_BYTES) return reject();
    return result;
  } catch {
    return reject();
  }
}

async function boundedText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, fail) => {
    timer = setTimeout(() => fail(new AuthBackendUnavailableError()), 2000);
  });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > AUTH_COMMAND_REQUEST_BYTES) return reject();
      chunks.push(chunk.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function requestFields(request: NextRequest): Promise<URLSearchParams> {
  if (request.method === 'GET') return new URLSearchParams(request.nextUrl.search);
  const body = await boundedText(request.clone().body);
  const type = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (type === 'application/x-www-form-urlencoded') return new URLSearchParams(body);
  if (type === 'application/json') {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject();
    const fields = new URLSearchParams();
    for (const [name, content] of Object.entries(parsed)) {
      if (typeof content === 'string' || typeof content === 'boolean') fields.append(name, String(content));
    }
    return fields;
  }
  return reject();
}
function singleState(fields: URLSearchParams): string {
  const states = fields.getAll('state');
  if (states.length !== 1 || !states[0] || states[0].length > 1024) return reject();
  return states[0];
}
async function initiationState(response: Response): Promise<string | null> {
  let destination = response.headers.get('Location');
  if (!destination && /^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) {
    const parsed: unknown = JSON.parse(await boundedText(response.clone().body));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const candidate = (parsed as Record<string, unknown>).url;
      if (typeof candidate === 'string') destination = candidate;
    }
  }
  if (!destination) return null;
  const states = new URL(destination).searchParams.getAll('state');
  return states.length === 1 && states[0] ? states[0] : null;
}

function unavailableResponse(
  request: NextRequest,
  json: boolean,
  provider: WebOAuthProvider,
  state?: string,
): Response {
  // Falls back only where nothing names the site, which the production boot guard refuses.
  const destination = new URL('/auth/error', resolvePublicAuthOrigin() ?? request.url);
  destination.searchParams.set('error', AUTH_BACKEND_UNAVAILABLE);
  if (json) return privacy(Response.json({ url: destination.href }, { status: 503 }));
  let response = privacy(new Response(null, { status: 303, headers: { Location: destination.href } }));
  if (state && (provider === 'apple' || provider === 'google')) {
    const descriptor = readExpoReturnForState(request, state, provider);
    if (descriptor) response = redirectExpoOAuthResponse(response, request, state, descriptor.returnUrl);
  }
  return response;
}

/** Compose the shipping route around request-local identity-only delegation. */
export async function withWebOAuthIdentity(
  request: NextRequest,
  context: RouteContext,
  base: NextAuthOptions,
  invoke: InvokeAuth,
): Promise<Response> {
  const [action, rawProvider] = (await context.params).nextauth;
  const configured = base.providers.find((candidate) => (candidate.options?.id ?? candidate.id) === rawProvider);
  if ((action !== 'signin' && action !== 'callback') || configured?.type !== 'oauth') return invoke(request, base);
  const provider = providers.has(rawProvider) ? (rawProvider as WebOAuthProvider) : undefined;
  let mode: ReturnType<typeof webOAuthMode>;
  try {
    mode = webOAuthMode();
  } catch {
    return unavailableResponse(request, false, provider ?? 'google');
  }
  if (mode === 'legacy') {
    // Only a callback can link an account; a sign-in start never reaches the adapter.
    return invoke(request, action === 'callback' ? await withSessionLinkGuard(base, request) : base);
  }
  if (!provider) return unavailableResponse(request, false, 'google');
  if (action === 'signin' && request.method !== 'POST') return invoke(request, base);

  let json = false;
  let state: string | undefined;
  let current = request;
  let clearContinuation: ((response: Response) => Response) | undefined;
  let verifiedScope: string | undefined;
  const finish = (response: Response): Response => {
    const cleared = verifiedScope ? clearObservedFlowCookies(response, current, base, verifiedScope) : response;
    return clearContinuation ? clearContinuation(cleared) : cleared;
  };
  try {
    const actorCookie = readWebOAuthActorCookie(request);
    const originalCookieHeader = request.headers.get('cookie');
    if (action === 'signin') {
      const fields = await requestFields(request);
      json = fields.get('json') === 'true';
      const clientKey = trustedClientRateLimitKey(request);
      if (checkRateLimit(`web-oauth-signin:${clientKey}`, OAUTH_STARTS_PER_CLIENT, 60_000).limited) return reject();
      const retiredScopes = await findWebOAuthFlowsToRetire(request, base);
      const scope = createWebOAuthCookieScope();
      const options: NextAuthOptions = {
        ...base,
        cookies: boundedFlowCookies(base, scope),
        debug: false,
        logger: createWebOAuthLogger(),
      };
      const response = await invoke(request, options);
      state = (await initiationState(response)) ?? undefined;
      // CSRF rejection/provider cancellation is the public handler's response;
      // only its actual successful state generation can create durable intent.
      if (!state) return response;
      const flow = webOAuthFlowHash(provider, state);
      const reply = await createWebOAuthCommandClient().intent({ provider, flow, actorCookie });
      if (reply.outcome !== 'recorded') return reject();
      // Only a flow that really started displaces an older one, so a refused or
      // CSRF-rejected POST above has cleared nothing.
      for (const retiredScope of retiredScopes) clearObservedFlowCookies(response, request, base, retiredScope);
      return response;
    }

    let scope: string;
    if (provider === 'apple' && request.method === 'GET' && request.nextUrl.searchParams.has(CONTINUATION_PARAM)) {
      if ([...request.nextUrl.searchParams.keys()].some((name) => name !== CONTINUATION_PARAM)) return reject();
      const resumed = await resumeAppleOAuthCallback(
        request,
        base,
        request.nextUrl.searchParams.get(CONTINUATION_PARAM) ?? '',
      );
      current = resumed.request;
      state = resumed.state;
      clearContinuation = (response) => resumed.clear(response);
      scope = await findWebOAuthCallbackScope(current, base, provider, state);
    } else {
      state =
        provider === 'apple' && request.method === 'POST'
          ? await readAppleOAuthCallbackState(request)
          : singleState(await requestFields(request));
      scope = await findWebOAuthCallbackScope(request, base, provider, state);
      if (provider === 'apple' && request.method === 'POST') return holdAppleOAuthCallback(request, base, scope, state);
    }
    verifiedScope = scope;
    if (current.headers.get('cookie') !== originalCookieHeader) return reject();
    const delegated = createWebOAuthIdentityAuthRequest(
      { ...base, cookies: boundedFlowCookies(base, scope) },
      { provider, flow: webOAuthFlowHash(provider, state), actorCookie },
    );
    const response = await invoke(current, delegated.options);
    const result =
      delegated.unavailable() || (delegated.resolved() && !delegated.publicationMatches(response))
        ? unavailableResponse(current, false, provider, state)
        : response;
    return finish(result);
  } catch {
    const response = unavailableResponse(current, json, provider, state);
    return finish(response);
  }
}
