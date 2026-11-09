import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import type { NextAuthOptions } from 'next-auth';
import { decode, encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { AUTH_COMMAND_FUTURE_SKEW_MS, type WebOAuthProvider } from '@boardsesh/auth-protocol';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { resolvePublicAuthOrigin } from './canonical-auth-url';

const APPLE_CALLBACK_PATH = '/api/auth/callback/apple';
const CONTINUATION_PURPOSE = 'boardsesh:web-oauth:apple-continuation:v1';
const CONTINUATION_LIFETIME_SECONDS = 60;
const MAX_BODY_BYTES = 4096;
const MAX_COOKIE_CHUNK_BYTES = 3500;
const BODY_TIMEOUT_MS = 2000;
const MAX_PENDING_FLOWS = 2;
const MAX_STATE_COOKIES = 8;
const scopePattern = /^[a-f0-9]{32}$/;
const flowCookieKeys = ['state', 'pkceCodeVerifier', 'nonce', 'callbackUrl'] as const;
const continuationPayloadSchema = z
  .object({
    purpose: z.literal(CONTINUATION_PURPOSE),
    origin: z.string(),
    callbackPath: z.literal(APPLE_CALLBACK_PATH),
    provider: z.literal('apple'),
    scope: z.string().regex(scopePattern),
    state: z.string().min(1).max(1024),
    issuedAtMs: z.number().int().nonnegative(),
    body: z.string().max(MAX_BODY_BYTES),
    iat: z.number().int(),
    exp: z.number().int(),
    jti: z.uuid(),
  })
  .strict();

function requireCondition(condition: unknown): asserts condition {
  if (!condition) throw new AuthBackendUnavailableError();
}
function secret(base: NextAuthOptions): string {
  const configured = base.secret ?? process.env.NEXTAUTH_SECRET;
  requireCondition(typeof configured === 'string' && configured.length > 0);
  return configured;
}
function requireScope(scope: string): void {
  requireCondition(scopePattern.test(scope));
}
function requireApplePath(request: NextRequest): void {
  requireCondition(request.nextUrl.pathname === APPLE_CALLBACK_PATH);
}
/**
 * The configured site, never the request's own URL: the standalone server builds
 * that from its bind address, so Apple's POST to the site reads as 0.0.0.0:3000.
 */
function publicAuthUrl(): URL {
  const origin = resolvePublicAuthOrigin();
  requireCondition(origin);
  return new URL(origin);
}
function flowCookie(base: NextAuthOptions, key: (typeof flowCookieKeys)[number]) {
  const configured = base.cookies?.[key];
  requireCondition(configured && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(configured.name));
  return configured;
}
function rawCookies(request: NextRequest): { name: string; content: string | null }[] {
  return (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf('=');
      return separator < 0
        ? { name: part, content: null }
        : { name: part.slice(0, separator), content: part.slice(separator + 1) };
    });
}
function decodedCookie(content: string | null): string {
  requireCondition(content && Buffer.byteLength(content) <= MAX_COOKIE_CHUNK_BYTES);
  const decoded = decodeURIComponent(content);
  requireCondition(/^[A-Za-z0-9_.-]+$/.test(decoded));
  return decoded;
}
function privacy(response: Response): Response {
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('CDN-Cache-Control', 'no-store');
  response.headers.set('Vercel-CDN-Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Robots-Tag', 'noindex, follow');
  return response;
}
function continuationName(site: URL, scope: string): string {
  return `${site.protocol === 'https:' ? '__Secure-' : ''}boardsesh.web-oauth.apple.${scope}`;
}
function cookieHeader(name: string, content: string, secure: boolean, lifetime: number): string {
  return `${name}=${content}; Path=${APPLE_CALLBACK_PATH}; Max-Age=${lifetime}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function createWebOAuthCookieScope(): string {
  return randomBytes(16).toString('hex');
}
export function scopedWebOAuthCookies(base: NextAuthOptions, scope: string): NextAuthOptions['cookies'] {
  try {
    requireScope(scope);
    const cookies = { ...base.cookies };
    for (const key of flowCookieKeys) {
      const configured = flowCookie(base, key);
      cookies[key] = { ...configured, name: `${configured.name}.${scope}`, options: { ...configured.options } };
    }
    return cookies;
  } catch {
    throw new AuthBackendUnavailableError();
  }
}
export function webOAuthFlowHash(provider: WebOAuthProvider, state: string): string {
  return createHash('sha256').update(`${provider}\0${state}`).digest('hex');
}

/** Only a public-codec authenticated state cookie can select a flow scope. */
export async function findWebOAuthCallbackScope(
  request: NextRequest,
  base: NextAuthOptions,
  provider: WebOAuthProvider,
  state: string,
): Promise<string> {
  try {
    requireCondition(state.length > 0 && state.length <= 1024);
    const prefix = `${flowCookie(base, 'state').name}.`;
    const candidates = rawCookies(request).filter((cookie) => cookie.name.startsWith(prefix));
    requireCondition(candidates.length > 0 && candidates.length <= 8);
    requireCondition(new Set(candidates.map((cookie) => cookie.name)).size === candidates.length);
    const matches: string[] = [];
    for (const candidate of candidates) {
      const scope = candidate.name.slice(prefix.length);
      requireScope(scope);
      const claims = await decode({
        token: decodedCookie(candidate.content),
        secret: secret(base),
        salt: candidate.name,
      });
      requireCondition(claims && typeof claims.exp === 'number' && Number.isFinite(claims.exp));
      if (claims.provider === provider && claims.value === state) matches.push(scope);
    }
    requireCondition(matches.length === 1);
    return matches[0];
  } catch {
    throw new AuthBackendUnavailableError();
  }
}

/**
 * The scopes to retire, oldest first, so one more flow fits under the pending-flow
 * cap. Only a state cookie this deployment sealed can nominate a flow for cleanup,
 * and when those cannot make enough room the initiation is refused.
 */
export async function findWebOAuthFlowsToRetire(request: NextRequest, base: NextAuthOptions): Promise<string[]> {
  try {
    const prefix = `${flowCookie(base, 'state').name}.`;
    const candidates = rawCookies(request).filter((cookie) => cookie.name.startsWith(prefix));
    const retireCount = candidates.length - (MAX_PENDING_FLOWS - 1);
    if (retireCount <= 0) return [];
    requireCondition(candidates.length <= MAX_STATE_COOKIES);
    requireCondition(new Set(candidates.map((cookie) => cookie.name)).size === candidates.length);
    const authenticatedFlows: { scope: string; issuedAt: number }[] = [];
    for (const candidate of candidates) {
      const scope = candidate.name.slice(prefix.length);
      if (!scopePattern.test(scope)) continue;
      const issuedAt = await authenticatedStateIssuedAt(candidate, base);
      if (issuedAt !== null) authenticatedFlows.push({ scope, issuedAt });
    }
    requireCondition(authenticatedFlows.length >= retireCount);
    return authenticatedFlows
      .sort((first, second) => first.issuedAt - second.issuedAt)
      .slice(0, retireCount)
      .map((flow) => flow.scope);
  } catch {
    throw new AuthBackendUnavailableError();
  }
}
async function authenticatedStateIssuedAt(
  cookie: { name: string; content: string | null },
  base: NextAuthOptions,
): Promise<number | null> {
  try {
    const claims = await decode({ token: decodedCookie(cookie.content), secret: secret(base), salt: cookie.name });
    return claims && typeof claims.iat === 'number' && Number.isFinite(claims.iat) ? claims.iat : null;
  } catch {
    return null;
  }
}

async function appleForm(request: NextRequest): Promise<{ body: string; state: string }> {
  requireApplePath(request);
  requireCondition(request.method === 'POST');
  requireCondition(
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded',
  );
  const reader = request.clone().body?.getReader();
  requireCondition(reader);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new AuthBackendUnavailableError()), BODY_TIMEOUT_MS);
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      total += part.value.byteLength;
      requireCondition(total <= MAX_BODY_BYTES);
      chunks.push(part.value);
    }
    const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    const states = new URLSearchParams(body).getAll('state');
    requireCondition(states.length === 1 && states[0].length > 0 && states[0].length <= 1024);
    return { body, state: states[0] };
  } finally {
    if (timeout) clearTimeout(timeout);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Use this before callback scope lookup instead of unbounded formData(). */
export async function readAppleOAuthCallbackState(request: NextRequest): Promise<string> {
  try {
    return (await appleForm(request)).state;
  } catch {
    throw new AuthBackendUnavailableError();
  }
}

export async function holdAppleOAuthCallback(
  request: NextRequest,
  base: NextAuthOptions,
  scope: string,
  state: string,
): Promise<Response> {
  try {
    requireApplePath(request);
    requireScope(scope);
    requireCondition((await findWebOAuthCallbackScope(request, base, 'apple', state)) === scope);
    const form = await appleForm(request);
    requireCondition(form.state === state);
    const site = publicAuthUrl();
    const name = continuationName(site, scope);
    const rawToken = await encode({
      secret: secret(base),
      salt: name,
      maxAge: CONTINUATION_LIFETIME_SECONDS,
      token: {
        purpose: CONTINUATION_PURPOSE,
        origin: site.origin,
        callbackPath: APPLE_CALLBACK_PATH,
        provider: 'apple',
        scope,
        state,
        issuedAtMs: Date.now(),
        body: form.body,
      },
    });
    requireCondition(rawToken.length <= MAX_COOKIE_CHUNK_BYTES * 2);
    const response = privacy(
      new Response(null, {
        status: 303,
        headers: { Location: `${site.origin}${APPLE_CALLBACK_PATH}?boardseshOAuthContinue=${scope}` },
      }),
    );
    const secure = site.protocol === 'https:';
    if (rawToken.length <= MAX_COOKIE_CHUNK_BYTES) {
      response.headers.append('Set-Cookie', cookieHeader(name, rawToken, secure, CONTINUATION_LIFETIME_SECONDS));
    } else {
      for (let index = 0; index < 2; index += 1) {
        response.headers.append(
          'Set-Cookie',
          cookieHeader(
            `${name}.${index}`,
            rawToken.slice(index * MAX_COOKIE_CHUNK_BYTES, (index + 1) * MAX_COOKIE_CHUNK_BYTES),
            secure,
            CONTINUATION_LIFETIME_SECONDS,
          ),
        );
      }
    }
    return response;
  } catch {
    throw new AuthBackendUnavailableError();
  }
}

export async function resumeAppleOAuthCallback(
  request: NextRequest,
  base: NextAuthOptions,
  scope: string,
): Promise<{ request: NextRequest; state: string; clear(response: Response): Response }> {
  try {
    requireApplePath(request);
    requireScope(scope);
    requireCondition(request.method === 'GET');
    const markers = request.nextUrl.searchParams.getAll('boardseshOAuthContinue');
    requireCondition(markers.length === 1 && markers[0] === scope);
    const site = publicAuthUrl();
    const name = continuationName(site, scope);
    const candidates = rawCookies(request).filter(
      (cookie) => cookie.name === name || cookie.name.startsWith(`${name}.`),
    );
    requireCondition(candidates.length > 0 && candidates.length <= 2);
    requireCondition(new Set(candidates.map((cookie) => cookie.name)).size === candidates.length);
    let rawToken: string;
    if (candidates.length === 1) {
      requireCondition(candidates[0].name === name);
      rawToken = decodedCookie(candidates[0].content);
    } else {
      const ordered = [...candidates].sort((first, second) => first.name.localeCompare(second.name));
      requireCondition(ordered[0].name === `${name}.0` && ordered[1].name === `${name}.1`);
      rawToken = ordered.map((cookie) => decodedCookie(cookie.content)).join('');
    }
    const payload = continuationPayloadSchema.parse(
      await decode({ token: rawToken, secret: secret(base), salt: name }),
    );
    const age = Date.now() - payload.issuedAtMs;
    // Nominal 60s lifetime, with bounded issuer-ahead clock skew only. This
    // does not extend the positive-age deadline or create a real-time clock.
    requireCondition(
      payload.origin === site.origin &&
        payload.scope === scope &&
        age >= -AUTH_COMMAND_FUTURE_SKEW_MS &&
        age < CONTINUATION_LIFETIME_SECONDS * 1000,
    );
    requireCondition(Buffer.byteLength(payload.body) <= MAX_BODY_BYTES);
    const states = new URLSearchParams(payload.body).getAll('state');
    requireCondition(states.length === 1 && states[0] === payload.state);
    requireCondition((await findWebOAuthCallbackScope(request, base, 'apple', payload.state)) === scope);
    const headers = new Headers(request.headers);
    for (const header of ['content-length', 'content-encoding', 'transfer-encoding']) headers.delete(header);
    headers.set('Content-Type', 'application/x-www-form-urlencoded');
    const resumed = new NextRequest(new URL(APPLE_CALLBACK_PATH, site.origin), {
      method: 'POST',
      headers,
      body: payload.body,
    });
    const observedNames = candidates.map((cookie) => cookie.name);
    const secure = site.protocol === 'https:';
    return {
      request: resumed,
      state: payload.state,
      clear(response) {
        const result = privacy(
          new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: new Headers(response.headers),
          }),
        );
        for (const observed of observedNames)
          result.headers.append('Set-Cookie', cookieHeader(observed, '', secure, 0));
        return result;
      },
    };
  } catch {
    throw new AuthBackendUnavailableError();
  }
}
