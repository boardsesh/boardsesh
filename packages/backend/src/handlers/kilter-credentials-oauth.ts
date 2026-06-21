import type { IncomingMessage, ServerResponse } from 'http';
import { createHash, randomBytes } from 'crypto';
import {
  exchangeAuthorizationCode,
  KILTER_BOARD_TYPE,
  KILTER_OAUTH_AUTH_URL,
  verifyKeycloakToken,
} from '@boardsesh/kilter-sync/api';
import { decrypt, encrypt } from '@boardsesh/crypto';
import { applyCorsHeaders, isOriginAllowed, isSameOriginUpgrade } from './cors';
import { validateToken } from '../middleware/auth';
import { redisClientManager } from '../redis/client';
import {
  signBoardCredentialCompletion,
  signBoardCredentialHandoff,
  signBoardCredentialState,
  verifyBoardCredentialCompletion,
  verifyBoardCredentialHandoff,
  verifyBoardCredentialState,
} from '../services/board-credential-state';
import { isKilterSyncAllowed, saveKilterCredential } from '../services/aurora-credentials';
import { logger } from '../utils/logger';

const KILTER_OAUTH_CLIENT_ID = process.env.KILTER_OAUTH_CLIENT_ID;
const KILTER_OAUTH_CLIENT_SECRET = process.env.KILTER_OAUTH_CLIENT_SECRET;
const KILTER_OAUTH_REDIRECT_URI = process.env.KILTER_OAUTH_REDIRECT_URI;

const STATE_COOKIE_NAME = 'kilter_oauth_state';
const VERIFIER_COOKIE_NAME = 'kilter_oauth_verifier';
const NONCE_COOKIE_NAME = 'kilter_oauth_nonce';
const HANDSHAKE_COOKIE_PATH = '/board-credentials/kilter';
const COOKIE_MAX_AGE_SECONDS = 600;
const HANDOFF_NONCE_MAX_AGE_SECONDS = 120;
const COMPLETION_NONCE_MAX_AGE_SECONDS = 300;
const MAX_JSON_BODY_BYTES = 16 * 1024;

const REFLECTABLE_OAUTH_ERRORS = new Set<string>([
  'access_denied',
  'invalid_request',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
  'unauthorized_client',
  'unsupported_response_type',
]);

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateVerifier(): string {
  return base64url(randomBytes(32));
}

function challengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

function safeOauthErrorReason(raw: string): string {
  return REFLECTABLE_OAUTH_ERRORS.has(raw) ? raw : 'oauth_error';
}

function deepLinkBase(): string {
  return 'com.boardsesh.app://board-credentials/kilter';
}

const localConsumedNonces = new Map<string, number>();

function completionUrl(
  returnUrl: string | undefined,
  status: 'connected' | 'error',
  reason?: string,
  completion?: string,
): string {
  if (!returnUrl) {
    const nativeUrl = new URL(deepLinkBase());
    nativeUrl.searchParams.set('status', status);
    if (reason) nativeUrl.searchParams.set('reason', reason);
    if (completion) nativeUrl.searchParams.set('completion', completion);
    return nativeUrl.toString();
  }

  const webUrl = new URL(returnUrl);
  webUrl.searchParams.set('kilter', status);
  if (reason) {
    webUrl.searchParams.set('reason', reason);
  } else {
    webUrl.searchParams.delete('reason');
  }
  if (completion) {
    webUrl.searchParams.set('completion', completion);
  } else {
    webUrl.searchParams.delete('completion');
  }
  return webUrl.toString();
}

function redirectTo(res: ServerResponse, location: string, cookies: string[] = []): void {
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
    ...(cookies.length > 0 ? { 'Set-Cookie': cookies } : {}),
  });
  res.end();
}

function redirectSuccess(
  res: ServerResponse,
  returnUrl: string | undefined,
  completion: string,
  cookies: string[] = [],
): void {
  redirectTo(res, completionUrl(returnUrl, 'connected', undefined, completion), cookies);
}

function redirectError(
  res: ServerResponse,
  returnUrl: string | undefined,
  reason: string,
  cookies: string[] = [],
): void {
  redirectTo(res, completionUrl(returnUrl, 'error', reason), cookies);
}

function sendText(res: ServerResponse, statusCode: number, message: string): void {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  res.end(message);
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function extractAuthTokenFromHeader(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

async function authenticate(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  const token = extractAuthTokenFromHeader(req);
  if (!token) {
    sendJson(res, 401, { error: 'Authentication required' });
    return null;
  }

  const authResult = await validateToken(token);
  if (!authResult) {
    sendJson(res, 401, { error: 'Invalid or expired token' });
    return null;
  }

  return authResult.userId;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let body = '';
  let bytesRead = 0;

  for await (const chunk of req) {
    const chunkText = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    bytesRead += Buffer.byteLength(chunkText);
    if (bytesRead > MAX_JSON_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    body += chunkText;
  }

  if (!body.trim()) return {};

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function requestOrigin(req: IncomingMessage): string {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const scheme = proto || (process.env.NODE_ENV === 'production' ? 'https' : 'http');
  return `${scheme}://${req.headers.host ?? 'localhost'}`;
}

function requestAllowedOrigin(req: IncomingMessage): string | null {
  const rawOrigin = req.headers.origin;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (!origin) return null;
  if (isOriginAllowed(origin) || isSameOriginUpgrade(origin, req.headers.host)) {
    return origin;
  }
  return null;
}

function normalizeReturnUrl(req: IncomingMessage, rawReturnUrl: unknown): string | undefined | null {
  if (rawReturnUrl == null) return undefined;
  if (typeof rawReturnUrl !== 'string' || rawReturnUrl.length > 2048) return null;

  const origin = requestAllowedOrigin(req);
  if (!origin) return null;

  try {
    const returnUrl = new URL(rawReturnUrl, origin);
    if (returnUrl.origin !== origin) return null;
    return returnUrl.toString();
  } catch {
    return null;
  }
}

function cookieSecure(req: IncomingMessage): boolean {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return proto === 'https' || process.env.NODE_ENV === 'production';
}

function serializeCookie(
  req: IncomingMessage,
  name: string,
  value: string,
  options: { maxAge: number; path: string },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Lax',
    `Path=${options.path}`,
    `Max-Age=${String(options.maxAge)}`,
  ];
  if (cookieSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

function deleteCookie(req: IncomingMessage, name: string): string {
  return serializeCookie(req, name, '', { maxAge: 0, path: HANDSHAKE_COOKIE_PATH });
}

function clearHandshakeCookies(req: IncomingMessage): string[] {
  return [
    deleteCookie(req, STATE_COOKIE_NAME),
    deleteCookie(req, VERIFIER_COOKIE_NAME),
    deleteCookie(req, NONCE_COOKIE_NAME),
  ];
}

function parseCookies(req: IncomingMessage): Map<string, string> {
  const cookies = new Map<string, string>();
  const rawCookieHeader = req.headers.cookie;
  if (!rawCookieHeader) return cookies;

  for (const rawCookie of rawCookieHeader.split(';')) {
    const separatorIndex = rawCookie.indexOf('=');
    if (separatorIndex === -1) continue;
    const name = rawCookie.slice(0, separatorIndex).trim();
    const value = rawCookie.slice(separatorIndex + 1).trim();
    if (!name) continue;
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      cookies.set(name, value);
    }
  }

  return cookies;
}

function consumeLocalNonce(key: string, lifetimeSeconds: number): boolean {
  const now = Date.now();
  for (const [nonceKey, expiresAt] of localConsumedNonces.entries()) {
    if (expiresAt <= now) {
      localConsumedNonces.delete(nonceKey);
    }
  }

  if (localConsumedNonces.has(key)) return false;
  localConsumedNonces.set(key, now + lifetimeSeconds * 1000);
  return true;
}

async function consumeOneTimeNonce(
  kind: 'handoff' | 'completion',
  nonce: string,
  lifetimeSeconds: number,
): Promise<boolean> {
  const redisKey = `board-credentials:${kind}:${nonce}`;

  if (!redisClientManager.isRedisConnected()) {
    if (redisClientManager.isRedisConfigured() || process.env.NODE_ENV === 'production') {
      logger.warn(`[BoardCredentials] Redis unavailable, rejecting ${kind} nonce`);
      return false;
    }
    return consumeLocalNonce(redisKey, lifetimeSeconds);
  }

  try {
    const { publisher } = redisClientManager.getClients();
    const setResult = await publisher.set(redisKey, '1', 'EX', lifetimeSeconds, 'NX');
    return setResult === 'OK';
  } catch (error) {
    logger.warn(`[BoardCredentials] Redis ${kind}-nonce check failed, rejecting token:`, error);
    return false;
  }
}

async function consumeHandoffNonce(nonce: string): Promise<boolean> {
  return consumeOneTimeNonce('handoff', nonce, HANDOFF_NONCE_MAX_AGE_SECONDS);
}

async function consumeCompletionNonce(nonce: string): Promise<boolean> {
  return consumeOneTimeNonce('completion', nonce, COMPLETION_NONCE_MAX_AGE_SECONDS);
}

export async function handleKilterCredentialsHandoff(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const userId = await authenticate(req, res);
  if (!userId) return;

  if (!isKilterSyncAllowed(userId)) {
    sendJson(res, 403, { error: 'Kilter sync is not enabled for this account' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, error instanceof Error && error.message === 'Request body too large' ? 413 : 400, {
      error: error instanceof Error ? error.message : 'Invalid request body',
    });
    return;
  }

  const returnUrl = normalizeReturnUrl(
    req,
    body && typeof body === 'object' && !Array.isArray(body) ? (body as { returnUrl?: unknown }).returnUrl : undefined,
  );
  if (returnUrl === null) {
    sendJson(res, 400, { error: 'Invalid returnUrl' });
    return;
  }

  const handoff = signBoardCredentialHandoff({
    userId,
    provider: KILTER_BOARD_TYPE,
    ...(returnUrl ? { returnUrl } : {}),
  });
  const startUrl = new URL('/board-credentials/kilter/start', requestOrigin(req));
  startUrl.searchParams.set('handoff', handoff);

  sendJson(res, 200, { handoff, startUrl: startUrl.toString() });
}

export async function handleKilterCredentialsStart(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const handoff = url.searchParams.get('handoff');
  if (!handoff) {
    sendText(res, 401, 'Authentication required');
    return;
  }

  const verifiedHandoff = verifyBoardCredentialHandoff(handoff);
  if (!verifiedHandoff || verifiedHandoff.provider !== KILTER_BOARD_TYPE) {
    sendText(res, 401, 'Invalid or expired handoff code');
    return;
  }

  if (!(await consumeHandoffNonce(verifiedHandoff.nonce))) {
    sendText(res, 401, 'Handoff code already used');
    return;
  }

  if (!isKilterSyncAllowed(verifiedHandoff.userId)) {
    sendText(res, 403, 'Kilter sync is not enabled for this account');
    return;
  }

  if (!KILTER_OAUTH_CLIENT_ID || !KILTER_OAUTH_REDIRECT_URI) {
    logger.error('[BoardCredentials] Kilter OAuth environment is not configured');
    sendText(res, 500, 'Kilter OAuth is not configured');
    return;
  }

  const verifier = generateVerifier();
  const challenge = challengeFor(verifier);
  const nonce = base64url(randomBytes(16));
  const state = signBoardCredentialState({
    userId: verifiedHandoff.userId,
    provider: KILTER_BOARD_TYPE,
    ...(verifiedHandoff.returnUrl ? { returnUrl: verifiedHandoff.returnUrl } : {}),
  });

  const authorize = new URL(KILTER_OAUTH_AUTH_URL);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', KILTER_OAUTH_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', KILTER_OAUTH_REDIRECT_URI);
  authorize.searchParams.set('scope', 'openid profile email offline_access');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('nonce', nonce);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');

  redirectTo(res, authorize.toString(), [
    serializeCookie(req, STATE_COOKIE_NAME, state, {
      maxAge: COOKIE_MAX_AGE_SECONDS,
      path: HANDSHAKE_COOKIE_PATH,
    }),
    serializeCookie(req, VERIFIER_COOKIE_NAME, verifier, {
      maxAge: COOKIE_MAX_AGE_SECONDS,
      path: HANDSHAKE_COOKIE_PATH,
    }),
    serializeCookie(req, NONCE_COOKIE_NAME, nonce, {
      maxAge: COOKIE_MAX_AGE_SECONDS,
      path: HANDSHAKE_COOKIE_PATH,
    }),
  ]);
}

export async function handleKilterCredentialsCallback(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const clearCookies = clearHandshakeCookies(req);
  const providerError = url.searchParams.get('error');
  const state = url.searchParams.get('state');
  const verifiedStateFromUrl = state ? verifyBoardCredentialState(state) : null;
  if (providerError) {
    redirectError(res, verifiedStateFromUrl?.returnUrl, safeOauthErrorReason(providerError), clearCookies);
    return;
  }

  const code = url.searchParams.get('code');
  if (!code || !state) {
    redirectError(res, verifiedStateFromUrl?.returnUrl, 'missing_params', clearCookies);
    return;
  }

  const verifiedState = verifiedStateFromUrl;
  if (!verifiedState || verifiedState.provider !== KILTER_BOARD_TYPE) {
    redirectError(res, verifiedState?.returnUrl, 'state_invalid', clearCookies);
    return;
  }

  if (!isKilterSyncAllowed(verifiedState.userId)) {
    redirectError(res, verifiedState.returnUrl, 'not_allowed', clearCookies);
    return;
  }

  if (!KILTER_OAUTH_CLIENT_ID || !KILTER_OAUTH_REDIRECT_URI) {
    redirectError(res, verifiedState.returnUrl, 'server_error', clearCookies);
    return;
  }

  const cookies = parseCookies(req);
  const stateCookie = cookies.get(STATE_COOKIE_NAME);
  const verifier = cookies.get(VERIFIER_COOKIE_NAME);
  const nonceCookie = cookies.get(NONCE_COOKIE_NAME);
  if (!stateCookie || !verifier || !nonceCookie || stateCookie !== state) {
    redirectError(res, verifiedState.returnUrl, 'state_invalid', clearCookies);
    return;
  }

  let tokens;
  try {
    tokens = await exchangeAuthorizationCode({
      code,
      redirectUri: KILTER_OAUTH_REDIRECT_URI,
      codeVerifier: verifier,
      client: {
        clientId: KILTER_OAUTH_CLIENT_ID,
        clientSecret: KILTER_OAUTH_CLIENT_SECRET,
      },
    });
  } catch (error) {
    logger.warn('[BoardCredentials] Kilter OAuth code exchange failed:', error);
    redirectError(res, verifiedState.returnUrl, 'exchange_failed', clearCookies);
    return;
  }

  if (!tokens || typeof tokens !== 'object' || typeof tokens.access_token !== 'string') {
    redirectError(res, verifiedState.returnUrl, 'malformed_tokens', clearCookies);
    return;
  }

  if (!tokens.refresh_token) {
    redirectError(res, verifiedState.returnUrl, 'no_refresh_token', clearCookies);
    return;
  }

  let kilterUserId: string;
  let preferredUsername: string | undefined;
  try {
    if (!tokens.id_token) throw new Error('id_token missing from token response');
    ({ sub: kilterUserId, preferredUsername } = await verifyKeycloakToken(tokens.id_token, {
      expectedAudience: KILTER_OAUTH_CLIENT_ID,
      expectedNonce: nonceCookie,
    }));
  } catch (error) {
    logger.warn('[BoardCredentials] Kilter id_token verification failed:', error);
    redirectError(res, verifiedState.returnUrl, 'id_token', clearCookies);
    return;
  }

  let completion: string;
  try {
    completion = signBoardCredentialCompletion({
      userId: verifiedState.userId,
      provider: KILTER_BOARD_TYPE,
      encryptedRefreshToken: encrypt(tokens.refresh_token),
      kilterUserId,
      ...(preferredUsername ? { username: preferredUsername } : {}),
    });
  } catch (error) {
    logger.warn('[BoardCredentials] Failed to create Kilter completion token:', error);
    redirectError(res, verifiedState.returnUrl, 'completion_failed', clearCookies);
    return;
  }

  redirectSuccess(res, verifiedState.returnUrl, completion, clearCookies);
}

export async function handleKilterCredentialsFinalize(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const userId = await authenticate(req, res);
  if (!userId) return;

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, error instanceof Error && error.message === 'Request body too large' ? 413 : 400, {
      error: error instanceof Error ? error.message : 'Invalid request body',
    });
    return;
  }

  const completion =
    body && typeof body === 'object' && !Array.isArray(body) ? (body as { completion?: unknown }).completion : null;
  if (typeof completion !== 'string') {
    sendJson(res, 400, { error: 'Invalid completion token' });
    return;
  }

  const verifiedCompletion = verifyBoardCredentialCompletion(completion);
  if (!verifiedCompletion || verifiedCompletion.provider !== KILTER_BOARD_TYPE) {
    sendJson(res, 400, { error: 'Invalid or expired completion token' });
    return;
  }

  if (verifiedCompletion.userId !== userId) {
    sendJson(res, 403, { error: 'Completion token does not belong to this account' });
    return;
  }

  if (!isKilterSyncAllowed(userId)) {
    sendJson(res, 403, { error: 'Kilter sync is not enabled for this account' });
    return;
  }

  if (!(await consumeCompletionNonce(verifiedCompletion.nonce))) {
    sendJson(res, 401, { error: 'Completion token already used or unavailable' });
    return;
  }

  let refreshToken: string;
  try {
    refreshToken = decrypt(verifiedCompletion.encryptedRefreshToken);
  } catch (error) {
    logger.warn('[BoardCredentials] Failed to decrypt Kilter completion token:', error);
    sendJson(res, 400, { error: 'Invalid completion token' });
    return;
  }

  try {
    await saveKilterCredential({
      userId,
      refreshToken,
      kilterUserId: verifiedCompletion.kilterUserId,
      ...(verifiedCompletion.username ? { username: verifiedCompletion.username } : {}),
    });
  } catch (error) {
    logger.warn('[BoardCredentials] Failed to persist Kilter credential:', error);
    sendJson(res, 500, { error: 'Failed to save Kilter credential' });
    return;
  }

  sendJson(res, 200, { success: true });
}
