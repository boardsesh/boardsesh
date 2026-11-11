import type { IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';
import { SignJWT, createRemoteJWKSet, jwtVerify } from 'jose';
import { parseAccountCreationReceipt, type AccountCreationReceipt } from '@boardsesh/analytics';
import { eq, and, isNull, lt, or, isNotNull, DrizzleQueryError } from 'drizzle-orm';
import type { DbInstance } from '@boardsesh/db/client';
import { mobileRefreshTokens, users, accounts, userProfiles } from '@boardsesh/db/schema/auth';
import { notificationDevices } from '@boardsesh/db/schema/app';
import { db } from '../db/client';
import { redisClientManager } from '../redis/client';
import { applyCorsHeaders } from './cors';
import { validateHttpAuthToken } from './auth-admission';
import {
  admitsCredential,
  AuthAdmissionUnavailableError,
  AuthSubjectDeniedError,
  isAuthAdmissionUnavailable,
  isHumanSubjectActive,
  PasswordProofStaleError,
  requireHumanSubjectForIssuance,
  type PasswordProof,
} from '../auth/human-admission';
import { decideCredential, type SubjectCutoffState } from '../auth/credential-cutoffs';
import { logger } from '../utils/logger';
import { getPostgresErrorCode } from '../utils/postgres-errors';
import {
  currentStoreNativeRegistrationConfiguration,
  currentStoreNativeOAuthConfiguration,
} from '../auth/current-store/authority-configuration';
import {
  preflight,
  signInTransactionSettings,
  transactionSettings,
  type WebPasswordAuthority,
} from '../auth/current-store/command-context';
import { CurrentStoreFoundationError } from '../auth/current-store/foundation-context';
import { insertReservedPasswordIdentity } from '../auth/current-store/reserved-password-registration';
import {
  resolveReservedNativeOAuthIdentity,
  resolveNativeOAuthDisplayName as resolveDisplayName,
  type NativeOAuthProvider as OAuthProvider,
  type VerifiedNativeOAuthIdentity as VerifiedOAuthIdentity,
} from '../auth/current-store/native-oauth-identity';
import {
  authenticateCurrentStorePassword,
  parseCurrentStorePasswordRegistration,
  prepareCurrentStorePasswordRegistration,
  insertCurrentStorePasswordIdentity,
} from '../auth/current-store/password-identity';

/** Generic error returned for all credential validation failures. */
const INVALID_CREDENTIALS_ERROR = 'Invalid email or password';

// Transfer tokens are short-lived (120s) and exchanged between our own
// servers, so 5s tolerance is sufficient. Long-lived JWTs use 60s in
// jose's clockTolerance to handle mobile device clock drift.
const CLOCK_SKEW_TOLERANCE_SECONDS = 5;

/**
 * Maximum allowed lifetime for a transfer token (seconds).
 * Transfer tokens are intended to live 120s. This cap (120s + 5s tolerance)
 * prevents a compromised web issuer from embedding an arbitrarily long exp.
 */
const MAX_TRANSFER_TOKEN_LIFETIME_SECONDS = 125;

/** JWT lifetime for mobile sessions. */
const JWT_EXPIRY = '7d';
const JWT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Refresh token lifetime. */
const REFRESH_TOKEN_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;

/** Maximum request body size for these endpoints. */
const MAX_BODY_BYTES = 4096;

/** JWT issuer claim for mobile tokens. */
const JWT_ISSUER = 'boardsesh';

/** JWT audience claim for mobile tokens. */
const JWT_AUDIENCE = 'boardsesh-mobile';

// ---------------------------------------------------------------------------
// Transfer token replay prevention
// ---------------------------------------------------------------------------

/**
 * In-memory fallback for consumed transfer token signatures when Redis is
 * unavailable. When Redis is connected, tokens are stored with SET NX EX for
 * atomic, multi-instance-safe replay prevention.
 */
const consumedTransferTokens = new Map<string, number>();

/** TTL for consumed token entries (125s — slightly longer than the 120s token TTL). */
const CONSUMED_TOKEN_TTL_SECONDS = 125;
const CONSUMED_TOKEN_TTL_MS = CONSUMED_TOKEN_TTL_SECONDS * 1000;

/** Cleanup interval for expired consumed token entries. */
const CONSUMED_TOKEN_CLEANUP_INTERVAL_MS = 60_000;

/** Max entries before triggering early eviction. */
const MAX_CONSUMED_TOKENS = 10_000;

/** Redis key prefix for consumed transfer tokens. */
const CONSUMED_TOKEN_REDIS_PREFIX = 'boardsesh:native-auth:consumed:';

/** Evict stale entries from the consumed-token map. */
function evictStaleConsumedTokens(): void {
  const cutoff = Date.now() - CONSUMED_TOKEN_TTL_MS;
  for (const [signature, timestamp] of consumedTransferTokens) {
    if (timestamp < cutoff) consumedTransferTokens.delete(signature);
  }
}

// Periodically evict stale consumed-token entries so the map doesn't grow unbounded.
const consumedTokenEvictionHandle = setInterval(evictStaleConsumedTokens, CONSUMED_TOKEN_CLEANUP_INTERVAL_MS);
if (typeof consumedTokenEvictionHandle.unref === 'function') consumedTokenEvictionHandle.unref();

/**
 * Attempt to mark a transfer token signature as consumed.
 * Returns 'consumed' if freshly consumed, 'replay' if already used, 'overloaded' if map is full.
 *
 * When Redis is connected, uses SET NX EX for atomic multi-instance replay prevention.
 * Falls back to the in-memory map otherwise (single-instance only).
 */
async function markTokenConsumed(tokenSignature: string): Promise<'consumed' | 'replay' | 'overloaded'> {
  if (redisClientManager.isRedisConnected()) {
    try {
      const { publisher } = redisClientManager.getClients();
      const redisKey = `${CONSUMED_TOKEN_REDIS_PREFIX}${tokenSignature}`;
      // SET key "1" NX EX 125 — returns "OK" if set, null if key already existed
      const result = await publisher.set(redisKey, '1', 'EX', CONSUMED_TOKEN_TTL_SECONDS, 'NX');
      return result === 'OK' ? 'consumed' : 'replay';
    } catch (error) {
      // Redis failure: fall through to in-memory map so the endpoint stays available.
      logger.warn('[NativeAuth] Redis SET NX failed for consumed token, falling back to in-memory:', error);
    }
  }

  // In-memory fallback (single-instance only)
  if (consumedTransferTokens.has(tokenSignature)) {
    return 'replay';
  }

  if (consumedTransferTokens.size >= MAX_CONSUMED_TOKENS) {
    evictStaleConsumedTokens();
    if (consumedTransferTokens.size >= MAX_CONSUMED_TOKENS) {
      return 'overloaded';
    }
  }

  consumedTransferTokens.set(tokenSignature, Date.now());
  return 'consumed';
}

/**
 * Check if a transfer token signature has already been consumed (read-only check).
 * Used for the early-reject path before verifying the HMAC.
 */
async function isTokenConsumed(tokenSignature: string): Promise<boolean> {
  if (redisClientManager.isRedisConnected()) {
    try {
      const { publisher } = redisClientManager.getClients();
      const redisKey = `${CONSUMED_TOKEN_REDIS_PREFIX}${tokenSignature}`;
      const result = await publisher.exists(redisKey);
      return result === 1;
    } catch (error) {
      logger.warn('[NativeAuth] Redis EXISTS failed for consumed token, falling back to in-memory:', error);
    }
  }
  return consumedTransferTokens.has(tokenSignature);
}

// ---------------------------------------------------------------------------
// IP-based rate limiting for auth endpoints
//
// Per-instance only — with N backend instances the effective limit is
// AUTH_RATE_LIMIT_MAX × N per IP. Redis-backed rate limiting would add
// a round-trip to every auth request for marginal benefit given that
// the high-risk replay path is already Redis-backed (SET NX EX).
// ---------------------------------------------------------------------------

type AuthRateLimitEntry = {
  count: number;
  resetAt: number;
};

/** Rate limit state per IP address. */
const authRateLimitMap = new Map<string, AuthRateLimitEntry>();

/** Maximum auth requests per IP per minute. */
const AUTH_RATE_LIMIT_MAX = 10;

/** Rate limit window in milliseconds (1 minute). */
const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;

/** Max entries before triggering early eviction. */
const MAX_RATE_LIMIT_ENTRIES = 50_000;

/** Evict expired entries from the rate limit map. */
function evictExpiredRateLimitEntries(): void {
  const now = Date.now();
  for (const [ipAddress, entry] of authRateLimitMap) {
    if (now > entry.resetAt) authRateLimitMap.delete(ipAddress);
  }
}

// Periodically clean up expired rate limit entries.
const rateLimitEvictionHandle = setInterval(evictExpiredRateLimitEntries, AUTH_RATE_LIMIT_WINDOW_MS);
if (typeof rateLimitEvictionHandle.unref === 'function') rateLimitEvictionHandle.unref();

/**
 * Check if an IP address has exceeded the auth endpoint rate limit.
 * Returns the number of seconds until the limit resets, or null if allowed.
 * Returns -1 if the rate limit map is full and cannot accept new entries
 * (callers should respond with 503).
 */
function checkAuthRateLimit(ipAddress: string): number | null {
  const now = Date.now();
  const entry = authRateLimitMap.get(ipAddress);

  if (!entry || now > entry.resetAt) {
    // New entry — check map bounds before inserting
    if (!entry && authRateLimitMap.size >= MAX_RATE_LIMIT_ENTRIES) {
      evictExpiredRateLimitEntries();
      if (authRateLimitMap.size >= MAX_RATE_LIMIT_ENTRIES) {
        logger.warn(`[NativeAuth] Rate limit map full (${authRateLimitMap.size} entries)`);
        return -1;
      }
    }
    authRateLimitMap.set(ipAddress, { count: 1, resetAt: now + AUTH_RATE_LIMIT_WINDOW_MS });
    return null;
  }

  if (entry.count >= AUTH_RATE_LIMIT_MAX) {
    return Math.ceil((entry.resetAt - now) / 1000);
  }

  entry.count++;
  return null;
}

/**
 * Extract the client IP from an incoming request.
 *
 * Uses `req.socket.remoteAddress` exclusively. X-Forwarded-For is user-controlled
 * and trusting its leftmost entry lets attackers bypass the rate limiter by
 * spoofing arbitrary IPs. Behind a reverse proxy (e.g. Railway), remoteAddress
 * is the proxy IP, which means all clients share one rate-limit bucket — overly
 * permissive but not bypassable.
 */
function getClientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;

    req.on('data', (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function getSigningSecret(): Uint8Array | null {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return null;
  return new TextEncoder().encode(secret);
}

// ---------------------------------------------------------------------------
// Transfer token verification (mirrors packages/web native-oauth-transfer.ts)
// ---------------------------------------------------------------------------

type TransferPayload = {
  userId: string;
  nextPath: string;
  iat: number;
  exp: number;
  accountCreation?: unknown;
  authSessionId?: unknown;
  attemptId?: unknown;
  provider?: unknown;
};

function verifyTransferToken(token: string): { userId: string; accountCreation?: AccountCreationReceipt } | null {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new AuthAdmissionUnavailableError();

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  const [encodedPayload, signature] = parts;

  const expectedSignature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');

  const sigBuffer = Buffer.from(signature);
  const expectedSigBuffer = Buffer.from(expectedSignature);

  // Pad both buffers to the same length so the comparison is always
  // constant-time — no length oracle, no JIT short-circuit.
  const maxLen = Math.max(sigBuffer.length, expectedSigBuffer.length);
  const paddedSig = Buffer.alloc(maxLen);
  const paddedExpected = Buffer.alloc(maxLen);
  sigBuffer.copy(paddedSig);
  expectedSigBuffer.copy(paddedExpected);

  if (!crypto.timingSafeEqual(paddedSig, paddedExpected)) {
    return null;
  }

  let payload: TransferPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as TransferPayload;
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    !payload.userId ||
    !payload.exp ||
    !payload.iat ||
    payload.exp < now - CLOCK_SKEW_TOLERANCE_SECONDS ||
    payload.iat > now + CLOCK_SKEW_TOLERANCE_SECONDS
  ) {
    return null;
  }

  // Reject tokens with an unreasonably long lifetime (e.g. a compromised
  // web issuer embedding a far-future exp).
  if (payload.exp - payload.iat > MAX_TRANSFER_TOKEN_LIFETIME_SECONDS) {
    return null;
  }

  const receipt = parseAccountCreationReceipt(payload.accountCreation);
  const accountCreation =
    receipt?.userId === payload.userId &&
    receipt.provider === payload.provider &&
    typeof payload.authSessionId === 'string' &&
    payload.authSessionId.length > 0 &&
    typeof payload.attemptId === 'string' &&
    /^[0-9a-f]{32}$/.test(payload.attemptId)
      ? receipt
      : undefined;
  return { userId: payload.userId, ...(accountCreation ? { accountCreation } : {}) };
}

function accountCreationReceipt(
  userId: string,
  accountCreated: boolean,
  provider: AccountCreationReceipt['provider'],
  createdAt: Date,
): AccountCreationReceipt | undefined {
  if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) return undefined;
  return { userId, accountCreated, provider, createdAt: createdAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Token generation helpers
// ---------------------------------------------------------------------------

type RefreshStamps = Pick<
  typeof mobileRefreshTokens.$inferSelect,
  'subjectGeneration' | 'nativeGeneration' | 'authenticatedAt' | 'sessionId'
>;

/**
 * What a new token pair descends from. Every reader decides the stamps by
 * `decideCredential` (BA-04 PR 2).
 */
type NativeCredentialOrigin =
  /**
   * A proof this request checked: password, provider token, transfer token or
   * watch code. `authenticatedAt` is when a password or provider proof passed;
   * null for a transfer token or watch code, which carry a sign-in made elsewhere.
   * `passwordProof` is what bcrypt checked, compared again under the user lock.
   */
  | { readonly kind: 'sign-in'; readonly authenticatedAt: Date | null; readonly passwordProof?: PasswordProof }
  /** The refresh row this request consumed, under the same user lock. */
  | { readonly kind: 'refresh'; readonly parent: RefreshStamps };

type CredentialStamps = {
  subjectGeneration: number;
  nativeGeneration: number;
  authenticatedAt: Date | null;
  sessionId: string;
};

/** A sign-in fresh at this request, for a proof made by this request. */
function signedInNow(): NativeCredentialOrigin {
  return { kind: 'sign-in', authenticatedAt: new Date() };
}

/** A sign-in that hands over a login made elsewhere: its age is unknown. */
const SIGN_IN_OF_UNKNOWN_AGE: NativeCredentialOrigin = { kind: 'sign-in', authenticatedAt: null };

function credentialStamps(origin: NativeCredentialOrigin, generations: SubjectCutoffState): CredentialStamps {
  if (origin.kind === 'sign-in') {
    return {
      subjectGeneration: generations.generation,
      nativeGeneration: generations.nativeGeneration,
      authenticatedAt: origin.authenticatedAt,
      sessionId: crypto.randomUUID(),
    };
  }
  // Copy, never re-read: a child is never newer than its parent. A row from
  // before the stamps stands for generation 0, so its child is stamped 0, and
  // an unknown sign-in time stays unknown.
  const { parent } = origin;
  return {
    subjectGeneration: parent.subjectGeneration ?? 0,
    nativeGeneration: parent.nativeGeneration ?? 0,
    authenticatedAt: parent.authenticatedAt ?? null,
    sessionId: parent.sessionId ?? crypto.randomUUID(),
  };
}

/**
 * `lockedState` is the state a caller already read under this transaction's user
 * lock (the refresh path), so the lock and its read are not taken twice.
 */
async function generateTokenPair(
  userId: string,
  transaction: Parameters<Parameters<DbInstance['transaction']>[0]>[0],
  origin: NativeCredentialOrigin,
  lockedState?: SubjectCutoffState,
): Promise<{
  jwt: string;
  refreshToken: string;
  expiresAt: string;
  userId: string;
}> {
  let generations = lockedState;
  if (!generations) {
    const passwordProof = origin.kind === 'sign-in' ? origin.passwordProof : undefined;
    // A password sign-in gives up on a held user row after 250 ms and answers
    // 503, which the app retries; issuance that must win keeps 4 s.
    if (passwordProof) await signInTransactionSettings(transaction);
    else await transactionSettings(transaction);
    generations = await requireHumanSubjectForIssuance(transaction, userId, passwordProof);
  }
  if (origin.kind === 'refresh') {
    // A child copies its parent's stamps, so a parent from before a reset or an
    // app sign-out would mint a pair every reader refuses, and the app would
    // loop refresh -> 401. Refuse the parent instead: a 401 here signs the app out.
    // Every cutoff writer locks `users` FOR UPDATE first, and this issuer holds
    // KEY SHARE, so no cutoff commits between this read and the child's insert.
    const { parent } = origin;
    const decision = decideCredential(
      {
        kind: 'native-refresh',
        subjectGeneration: parent.subjectGeneration,
        nativeGeneration: parent.nativeGeneration,
        authenticatedAt: parent.authenticatedAt,
      },
      generations,
      Date.now(),
    );
    if (!admitsCredential(decision, 'refresh')) throw new AuthSubjectDeniedError();
  }
  const signingSecret = getSigningSecret();
  if (!signingSecret) throw new AuthAdmissionUnavailableError();
  const stamps = credentialStamps(origin, generations);

  // Generate JWT. Clients read only `sub`; the stamps are for the server.
  const jwtExpiresAt = new Date(Date.now() + JWT_EXPIRY_MS);
  const jwt = await new SignJWT({
    sub: userId,
    gen: stamps.subjectGeneration,
    ngen: stamps.nativeGeneration,
    ...(stamps.authenticatedAt ? { auth_time: Math.floor(stamps.authenticatedAt.getTime() / 1000) } : {}),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime(JWT_EXPIRY)
    .sign(signingSecret);

  // Generate refresh token and store its hash
  const refreshToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

  await transaction.insert(mobileRefreshTokens).values({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS),
    ...stamps,
  });

  return {
    userId,
    jwt,
    refreshToken,
    expiresAt: jwtExpiresAt.toISOString(),
  };
}

async function issueTokenPair(userId: string, origin: NativeCredentialOrigin) {
  return db.transaction((transaction) => generateTokenPair(userId, transaction, origin));
}

function respondNativeAdmissionFailure(response: ServerResponse, error: unknown): boolean {
  if (error instanceof AuthSubjectDeniedError) {
    sendJson(response, 401, { error: 'Account is not available' });
    return true;
  }
  if (isAuthAdmissionUnavailable(error) || isNativeAuthInfrastructureFailure(error)) {
    sendJson(response, 503, { error: 'Authentication is temporarily unavailable' });
    return true;
  }
  return false;
}

/** Keep the reserved writers' existing infrastructure messages and safe logs. */
function respondReservedNativeAdmissionFailure(response: ServerResponse, error: unknown): boolean {
  if (!(error instanceof AuthSubjectDeniedError) && !isAuthAdmissionUnavailable(error)) return false;
  return respondNativeAdmissionFailure(response, error);
}

// ---------------------------------------------------------------------------
// POST /auth/native/exchange
// ---------------------------------------------------------------------------

export async function handleNativeAuthExchange(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // Rate limit by IP
  const clientIp = getClientIp(req);
  const retryAfter = checkAuthRateLimit(clientIp);
  if (retryAfter === -1) {
    sendJson(res, 503, { error: 'Service temporarily overloaded' });
    return;
  }
  if (retryAfter !== null) {
    res.setHeader('Retry-After', String(retryAfter));
    sendJson(res, 429, { error: `Rate limit exceeded. Try again in ${retryAfter} seconds.` });
    return;
  }

  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { error: 'Request body must be a JSON object' });
    return;
  }

  const { transferToken } = body as Record<string, unknown>;
  if (typeof transferToken !== 'string' || transferToken.length === 0) {
    sendJson(res, 400, { error: 'transferToken is required' });
    return;
  }

  // Extract the signature before verification so we can check for replay
  const tokenParts = transferToken.split('.');
  if (tokenParts.length !== 2 || !tokenParts[1]) {
    sendJson(res, 401, { error: 'Invalid or expired transfer token' });
    return;
  }
  const tokenSignature = tokenParts[1];

  // Check if this transfer token has already been consumed (replay prevention)
  if (await isTokenConsumed(tokenSignature)) {
    logger.warn('[NativeAuth] Transfer token replay attempt detected');
    sendJson(res, 409, { error: 'Transfer token has already been used' });
    return;
  }

  // Verify the HMAC transfer token
  let verified: ReturnType<typeof verifyTransferToken>;
  try {
    verified = verifyTransferToken(transferToken);
  } catch (error) {
    if (respondNativeAdmissionFailure(res, error)) return;
    throw error;
  }
  if (!verified) {
    logger.warn('[NativeAuth] Transfer token verification failed');
    sendJson(res, 401, { error: 'Invalid or expired transfer token' });
    return;
  }

  // Do not consume the one-shot transfer capability during a known authority
  // outage. The real issuer checks again under the user lock in its transaction.
  try {
    if (!(await isHumanSubjectActive(verified.userId))) {
      sendJson(res, 401, { error: 'Account is not available' });
      return;
    }
  } catch (error) {
    if (!respondNativeAdmissionFailure(res, error)) sendJson(res, 500, { error: 'Internal server error' });
    return;
  }

  // Atomically mark the token as consumed. If another request consumed it
  // between the EXISTS check above and now, markTokenConsumed returns 'replay'.
  const consumeResult = await markTokenConsumed(tokenSignature);
  if (consumeResult === 'replay') {
    logger.warn('[NativeAuth] Transfer token replay attempt detected (race)');
    sendJson(res, 409, { error: 'Transfer token has already been used' });
    return;
  }
  if (consumeResult === 'overloaded') {
    logger.error('[NativeAuth] Consumed token map full — rejecting request');
    sendJson(res, 503, { error: 'Service temporarily overloaded' });
    return;
  }

  try {
    const tokenPair = await issueTokenPair(verified.userId, SIGN_IN_OF_UNKNOWN_AGE);
    logger.info(`[NativeAuth] Token exchange successful for user ${verified.userId}`);
    sendJson(res, 200, {
      ...tokenPair,
      ...(verified.accountCreation ? { accountCreation: verified.accountCreation } : {}),
    });
  } catch (error) {
    if (respondNativeAdmissionFailure(res, error)) return;
    logger.error('[NativeAuth] Token generation failed:', error);
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// POST /auth/native/credentials
// ---------------------------------------------------------------------------

export async function handleNativeAuthCredentials(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // Rate limit by IP (shared limiter with the other native-auth endpoints)
  const clientIp = getClientIp(req);
  const retryAfter = checkAuthRateLimit(clientIp);
  if (retryAfter === -1) {
    sendJson(res, 503, { error: 'Service temporarily overloaded' });
    return;
  }
  if (retryAfter !== null) {
    res.setHeader('Retry-After', String(retryAfter));
    sendJson(res, 429, { error: `Rate limit exceeded. Try again in ${retryAfter} seconds.` });
    return;
  }

  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { error: 'Request body must be a JSON object' });
    return;
  }

  const { email, password } = body as Record<string, unknown>;
  if (typeof email !== 'string' || email.length === 0 || typeof password !== 'string' || password.length === 0) {
    sendJson(res, 400, { error: 'email and password are required' });
    return;
  }

  try {
    const authenticatedUser = await authenticateCurrentStorePassword(db, email, password);
    if (!authenticatedUser) {
      sendJson(res, 401, { error: INVALID_CREDENTIALS_ERROR });
      return;
    }

    const authenticatedUserId = authenticatedUser.userId;
    // Issue only if the hash and generation bcrypt checked are still the
    // account's under the user lock: a check that passed just before a reset
    // must not mint a credential after it (BA-04 section 4).
    const tokenPair = await issueTokenPair(authenticatedUserId, {
      kind: 'sign-in',
      authenticatedAt: new Date(),
      passwordProof: {
        passwordHash: authenticatedUser.passwordHash,
        generation: authenticatedUser.generation,
      },
    });
    logger.info(`[NativeAuth] Credentials sign-in successful for user ${authenticatedUserId}`);
    const accountCreation = accountCreationReceipt(authenticatedUserId, false, 'email', authenticatedUser.createdAt);
    sendJson(res, 200, { ...tokenPair, ...(accountCreation ? { accountCreation } : {}) });
  } catch (error) {
    if (error instanceof PasswordProofStaleError) {
      sendJson(res, 401, { error: INVALID_CREDENTIALS_ERROR });
      return;
    }
    if (respondNativeAdmissionFailure(res, error)) return;
    logger.error('[NativeAuth] Credentials sign-in failed:', error);
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// POST /auth/native/register — create a Boardsesh account from the mobile app
//
// Mirrors the web register route (packages/web/app/api/auth/register/route.ts):
// it creates the same users + userCredentials + userProfiles rows. The
// difference is that on success we mint a mobile JWT pair and return it, so the
// app logs the user straight in (no web browser, no email round-trip) — the same
// auto-login behaviour the native OAuth and credentials handlers already have.
//
// Email verification: this adapter does not deliver verification email, and
// handleNativeAuthCredentials never checks emailVerified, so the new user is
// auto-logged-in on the device regardless. We still honour
// EMAIL_VERIFICATION_ENABLED for the stored emailVerified value, mirroring the
// web register route: when the flag is on, accounts are created UNVERIFIED
// (emailVerified: null) so this native path can't mint verified accounts for
// arbitrary emails and thereby bypass web's verification gate
// (auth-options.ts blocks unverified credentials login when the flag is on).
// When the flag is off (the default), accounts are created verified.
// ---------------------------------------------------------------------------

export async function handleNativeAuthRegister(
  req: IncomingMessage,
  res: ServerResponse,
  database: DbInstance = db,
): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // Rate limit by IP (shared limiter with the other native-auth endpoints)
  const clientIp = getClientIp(req);
  const retryAfter = checkAuthRateLimit(clientIp);
  if (retryAfter === -1) {
    sendJson(res, 503, { error: 'Service temporarily overloaded' });
    return;
  }
  if (retryAfter !== null) {
    res.setHeader('Retry-After', String(retryAfter));
    sendJson(res, 429, { error: `Rate limit exceeded. Try again in ${retryAfter} seconds.` });
    return;
  }

  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { error: 'Request body must be a JSON object' });
    return;
  }

  const validation = parseCurrentStorePasswordRegistration(body as Record<string, unknown>);
  if (!validation.ok) {
    sendJson(res, 400, { error: validation.error });
    return;
  }

  let configuration: ReturnType<typeof currentStoreNativeRegistrationConfiguration>;
  try {
    configuration = currentStoreNativeRegistrationConfiguration();
  } catch {
    logger.warn('[NativeAuth] Reserved registration unavailable', { category: 'configuration' });
    sendJson(res, 503, { error: 'Service temporarily unavailable' });
    return;
  }
  if (configuration.mode === 'reserved-staging') {
    await handleReservedNativeRegistration(res, database, configuration.authority, validation.registration);
    return;
  }

  try {
    const prepared = await prepareCurrentStorePasswordRegistration(database, validation.registration);
    if (!prepared) {
      sendJson(res, 409, {
        error: 'An account with this email already exists. Please sign in with your existing account.',
      });
      return;
    }

    // Mirror web: unverified when the verification gate is on, verified otherwise.
    const emailVerificationEnabled = process.env.EMAIL_VERIFICATION_ENABLED === 'true';

    const origin = signedInNow();
    const result = await database.transaction(async (tx) => {
      const identity = await insertCurrentStorePasswordIdentity(tx, prepared, emailVerificationEnabled);
      const tokenPair = await generateTokenPair(identity.userId, tx, origin);
      return {
        userId: identity.userId,
        tokenPair,
        accountCreation: accountCreationReceipt(identity.userId, true, 'email', identity.createdAt),
      };
    });

    logger.info(`[NativeAuth] Registration successful for user ${result.userId}`);
    sendJson(res, 201, { ...result.tokenPair, accountCreation: result.accountCreation });
  } catch (error) {
    // Race: a concurrent request created this email between the pre-check and
    // insert. PostgreSQL unique-violation code is '23505'. NOTE: users.email has
    // no unique index today, so this won't fire from the email column yet — the
    // pre-check above is the real guard. The handler stays correct once a
    // uniqueIndex on lower-cased users.email is added (tracked as follow-up).
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      sendJson(res, 409, { error: 'An account with this email already exists' });
      return;
    }
    if (respondNativeAdmissionFailure(res, error)) return;
    logger.error('[NativeAuth] Registration failed:', error);
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

const nativeAuthDriverCodes = new Set([
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

function isNativeAuthInfrastructureFailure(error: unknown): boolean {
  const code = getPostgresErrorCode(error);
  return (
    error instanceof CurrentStoreFoundationError ||
    error instanceof DrizzleQueryError ||
    (code !== undefined && (/^[0-9A-Z]{5}$/.test(code) || nativeAuthDriverCodes.has(code)))
  );
}

async function handleReservedNativeRegistration(
  response: ServerResponse,
  database: DbInstance,
  authority: WebPasswordAuthority,
  registration: Parameters<typeof prepareCurrentStorePasswordRegistration>[1],
) {
  try {
    // Validate authority before even an exact-email precheck can report409.
    // Bcrypt remains outside the global manifest's locked transaction.
    await preflight(database, authority);
    const prepared = await prepareCurrentStorePasswordRegistration(database, registration);
    const origin = signedInNow();
    const result = await database.transaction(async (transaction) => {
      await transactionSettings(transaction);
      const inserted = await insertReservedPasswordIdentity(transaction, authority, {
        email: registration.email,
        prepared,
        emailVerificationEnabled: authority.emailVerificationEnabled,
      });
      if (inserted.outcome === 'exists') return inserted;
      const { identity } = inserted;
      // This remains the installed native issuer, bound to the identity's tx.
      const tokenPair = await generateTokenPair(identity.userId, transaction, origin);
      return {
        outcome: 'created' as const,
        tokenPair,
        accountCreation: accountCreationReceipt(identity.userId, true, 'email', identity.createdAt),
      };
    });
    if (result.outcome === 'exists') {
      sendJson(response, 409, {
        error: 'An account with this email already exists. Please sign in with your existing account.',
      });
      return;
    }
    logger.info('[NativeAuth] Reserved registration successful', { category: 'created' });
    sendJson(response, 201, { ...result.tokenPair, accountCreation: result.accountCreation });
  } catch (error) {
    if (respondReservedNativeAdmissionFailure(response, error)) return;
    const unavailable = isNativeAuthInfrastructureFailure(error);
    // Never pass the original query/error/cause/parameters into logs or Sentry.
    // This branch returns before the unchanged legacy raw-error handler.
    if (unavailable) {
      logger.warn('[NativeAuth] Reserved registration unavailable', { category: 'authority-or-database' });
      sendJson(response, 503, { error: 'Service temporarily unavailable' });
    } else {
      logger.error('[NativeAuth] Reserved registration failed', new Error('Native registration internal failure'));
      sendJson(response, 500, { error: 'Internal server error' });
    }
  }
}

// ---------------------------------------------------------------------------
// POST /auth/native/oauth — native Sign in with Apple / Google
//
// The mobile app runs the native provider flow (expo-apple-authentication /
// @react-native-google-signin) and posts the provider's identity token here.
// We verify the token against the provider's JWKS, then find-or-create the
// Boardsesh user and issue our own mobile JWT pair. Account linking is by the
// provider's stable `sub`. Legacy mode retains its email-link fallback;
// explicitly staged resolution reserves new keys and rejects email-only links.
// ---------------------------------------------------------------------------

/** Apple's bundle identifier — the `aud` claim on Apple identity tokens. */
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID ?? 'com.boardsesh.app';

/** Apple's issuer for Sign in with Apple identity tokens. */
const APPLE_ISSUER = 'https://appleid.apple.com';

/**
 * Google accepts two issuer spellings on its ID tokens. Both are valid and
 * which one appears depends on the signing key / rollout.
 */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

// Module-level JWKS singletons. `createRemoteJWKSet` returns a function that
// caches the fetched keys internally and only re-fetches on key rotation, so
// constructing these once (not per-request) is the documented pattern.
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

type ForwardedName = { firstName?: string; lastName?: string };

/**
 * The identity claims we trust from a verified provider token. `sub` is the
 * provider's stable per-user id (used for account linking); `email` may be
 * absent on Apple resubmissions (handled by the sub lookup).
 */
type NativeOAuthVerification =
  | { status: 'verified'; identity: VerifiedOAuthIdentity }
  | { status: 'invalid' }
  | { status: 'unavailable' };

const invalidNativeOAuthCodes = new Set([
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_EXPIRED',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWS_INVALID',
  'ERR_JWT_INVALID',
  'ERR_JOSE_ALG_NOT_ALLOWED',
]);

/** JWT payload typings do not validate an arbitrary runtime subject. */
function validStagedNativeSubject(subject: unknown): subject is string {
  return typeof subject === 'string' && subject.trim().length > 0 && Buffer.byteLength(subject, 'utf8') <= 1024;
}

/**
 * The configured Google OAuth client IDs. Any of the iOS / Android / Web
 * client IDs is an accepted `aud` because @react-native-google-signin issues
 * ID tokens whose audience is the *webClientId*, while a raw native flow can
 * produce a platform-client audience.
 */
function getGoogleAudiences(): string[] {
  return [
    process.env.GOOGLE_IOS_CLIENT_ID,
    process.env.GOOGLE_ANDROID_CLIENT_ID,
    process.env.GOOGLE_WEB_CLIENT_ID,
  ].filter((clientId): clientId is string => typeof clientId === 'string' && clientId.length > 0);
}

/**
 * Best-effort nonce check, enforced only when the client supplies a `nonce`.
 * Apple echoes the request nonce into the token's `nonce` claim verbatim
 * (expo-apple-authentication passes it unmodified), so the client SHA-256-hashes
 * the nonce before handing it to Apple and sends us the raw value: the token
 * carries `SHA-256(raw)` and we re-hash to compare, so the raw nonce never lives
 * in the token. We also accept a verbatim match as a fallback for a client that
 * forwards the nonce unhashed. The JWT signature/audience is the real
 * authentication boundary; the nonce only ties a token to this sign-in attempt
 * (and is unenforced when omitted, e.g. Google's native SDK sends none).
 */
function verifyNonce(rawNonce: string | undefined, payloadNonce: unknown): boolean {
  if (!rawNonce) return true;
  if (typeof payloadNonce !== 'string' || payloadNonce.length === 0) return false;
  const hashedNonce = crypto.createHash('sha256').update(rawNonce).digest('hex');
  return payloadNonce === hashedNonce || payloadNonce === rawNonce;
}

/**
 * Verify a provider identity token against the provider's JWKS and extract the
 * claims we need. Staging separates authoritative invalid-token failures from
 * required-key/configuration uncertainty and logs only fixed categories.
 * Legacy callers retain the current failure response and diagnostics.
 */
async function verifyProviderIdentityToken(
  provider: OAuthProvider,
  identityToken: string,
  nonce?: string,
  staged = false,
): Promise<NativeOAuthVerification> {
  try {
    if (provider === 'apple') {
      if (staged && !APPLE_BUNDLE_ID.trim()) {
        logger.warn('[NativeAuth] OAuth verification unavailable', { category: 'provider-configuration' });
        return { status: 'unavailable' };
      }
      const { payload } = await jwtVerify(identityToken, appleJwks, {
        issuer: APPLE_ISSUER,
        audience: APPLE_BUNDLE_ID,
        // Both providers sign id tokens with RS256; pin it so a future JWKS that
        // also advertises a weaker/asymmetric-confusable alg can't be selected.
        algorithms: ['RS256'],
        clockTolerance: 60,
        ...(staged ? { requiredClaims: ['exp'] } : {}),
      });
      if (!payload.sub || (staged && !validStagedNativeSubject(payload.sub)) || !verifyNonce(nonce, payload.nonce))
        return { status: 'invalid' };
      return {
        status: 'verified',
        identity: {
          sub: payload.sub,
          email: typeof payload.email === 'string' ? payload.email : null,
          emailVerified: payload.email_verified === true || payload.email_verified === 'true',
          // Apple never returns the name in the token — it's delivered once, in
          // the authorization response, and forwarded by the client separately.
          name: null,
        },
      };
    }

    const audiences = getGoogleAudiences();
    if (audiences.length === 0) {
      if (staged) logger.warn('[NativeAuth] OAuth verification unavailable', { category: 'provider-configuration' });
      else logger.error('[NativeAuth] No Google client IDs configured — cannot verify Google token');
      return { status: staged ? 'unavailable' : 'invalid' };
    }
    const { payload } = await jwtVerify(identityToken, googleJwks, {
      issuer: GOOGLE_ISSUERS,
      audience: audiences,
      algorithms: ['RS256'],
      clockTolerance: 60,
      ...(staged ? { requiredClaims: ['exp'] } : {}),
    });
    if (!payload.sub || (staged && !validStagedNativeSubject(payload.sub)) || !verifyNonce(nonce, payload.nonce))
      return { status: 'invalid' };
    return {
      status: 'verified',
      identity: {
        sub: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
        emailVerified: payload.email_verified === true || payload.email_verified === 'true',
        name: typeof payload.name === 'string' ? payload.name : null,
      },
    };
  } catch (error) {
    if (staged) {
      const code = getPostgresErrorCode(error);
      const status = code !== undefined && invalidNativeOAuthCodes.has(code) ? 'invalid' : 'unavailable';
      logger.warn('[NativeAuth] OAuth verification rejected', {
        category: status === 'invalid' ? 'invalid-token' : 'provider-unavailable',
      });
      return { status };
    }
    logger.warn('[NativeAuth] OAuth identity token verification failed:', error);
    return { status: 'invalid' };
  }
}

/** Narrow an unknown `name` field from the request body to ForwardedName. */
function parseForwardedName(value: unknown): ForwardedName | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { firstName, lastName } = value as Record<string, unknown>;
  const forwarded: ForwardedName = {};
  if (typeof firstName === 'string') forwarded.firstName = firstName;
  if (typeof lastName === 'string') forwarded.lastName = lastName;
  return forwarded.firstName !== undefined || forwarded.lastName !== undefined ? forwarded : undefined;
}

type FindOrCreateResult =
  | {
      status: 'ok';
      tokenPair: Awaited<ReturnType<typeof generateTokenPair>>;
      userId: string;
      accountCreation?: AccountCreationReceipt;
    }
  | { status: 'no_email' };

/**
 * Resolve the Boardsesh user for a verified identity and mint a token pair,
 * all inside one transaction:
 *   1. Existing `accounts` row for (provider, sub) → that user.
 *   2. Else a `users` row matching the normalized email → link it (insert the
 *      accounts row; mark email verified when the provider asserts it).
 *   3. Else create the user + profile + accounts link.
 * Apple resubmissions omit the email but always resolve via step 1.
 */
async function findOrCreateOAuthUser(
  provider: OAuthProvider,
  identity: VerifiedOAuthIdentity,
  forwardedName: ForwardedName | undefined,
  origin: NativeCredentialOrigin,
  database: DbInstance = db,
): Promise<FindOrCreateResult> {
  return database.transaction(async (tx) => {
    // 1. Link by the provider's stable subject id.
    const linkedRows = await tx
      .select({ userId: accounts.userId, createdAt: users.createdAt })
      .from(accounts)
      .innerJoin(users, eq(users.id, accounts.userId))
      .where(and(eq(accounts.provider, provider), eq(accounts.providerAccountId, identity.sub)))
      .limit(1);
    const linked = linkedRows[0];
    if (linked) {
      const tokenPair = await generateTokenPair(linked.userId, tx, origin);
      return {
        status: 'ok',
        tokenPair,
        userId: linked.userId,
        accountCreation: accountCreationReceipt(linked.userId, false, provider, linked.createdAt),
      };
    }

    const normalizedEmail = identity.email ? identity.email.trim().toLowerCase() : null;

    // 2. Link by email — ONLY when the provider asserts the email is verified.
    // This is the security boundary NextAuth's allowDangerousEmailAccountLinking
    // leaves to the provider: auto-linking an *unverified* provider email to an
    // existing account would let anyone able to mint a token for an arbitrary
    // email claim take over that account. Apple always verifies (real or relay);
    // Google's email_verified is almost always true. An unverified email falls
    // through to creation, which anchors on the provider sub instead.
    if (normalizedEmail && identity.emailVerified) {
      const matchedRows = await tx
        .select({ id: users.id, emailVerified: users.emailVerified, createdAt: users.createdAt })
        .from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);
      const matched = matchedRows[0];
      if (matched) {
        await transactionSettings(tx);
        await requireHumanSubjectForIssuance(tx, matched.id);
        await tx
          .insert(accounts)
          .values({ userId: matched.id, type: 'oauth', provider, providerAccountId: identity.sub })
          .onConflictDoNothing();
        if (!matched.emailVerified) {
          await tx.update(users).set({ emailVerified: new Date() }).where(eq(users.id, matched.id));
        }
        const tokenPair = await generateTokenPair(matched.id, tx, origin);
        return {
          status: 'ok',
          tokenPair,
          userId: matched.id,
          accountCreation: accountCreationReceipt(matched.id, false, provider, matched.createdAt),
        };
      }
    }

    // 3. Create. Email is NOT NULL on `users`; Apple/Google both return an
    // email on first authorization (Apple's relay address when hidden), so a
    // brand-new sub without an email is unexpected — reject rather than
    // fabricate one.
    if (!normalizedEmail) {
      return { status: 'no_email' };
    }

    const newUserId = crypto.randomUUID();
    const createdAt = new Date();
    await tx.insert(users).values({
      id: newUserId,
      createdAt,
      email: normalizedEmail,
      name: resolveDisplayName(identity, forwardedName),
      emailVerified: identity.emailVerified ? new Date() : null,
    });
    // Mirror the web `createUser` event: every user gets a profile row. New
    // accounts start public (the column defaults); Private is opt-in.
    await tx.insert(userProfiles).values({ userId: newUserId }).onConflictDoNothing();
    await tx.insert(accounts).values({ userId: newUserId, type: 'oauth', provider, providerAccountId: identity.sub });
    const tokenPair = await generateTokenPair(newUserId, tx, origin);
    return {
      status: 'ok',
      tokenPair,
      userId: newUserId,
      accountCreation: accountCreationReceipt(newUserId, true, provider, createdAt),
    };
  });
}

export async function handleNativeAuthOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  database: DbInstance = db,
): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // Rate limit by IP (shared limiter with the other native-auth endpoints)
  const clientIp = getClientIp(req);
  const retryAfter = checkAuthRateLimit(clientIp);
  if (retryAfter === -1) {
    sendJson(res, 503, { error: 'Service temporarily overloaded' });
    return;
  }
  if (retryAfter !== null) {
    res.setHeader('Retry-After', String(retryAfter));
    sendJson(res, 429, { error: `Rate limit exceeded. Try again in ${retryAfter} seconds.` });
    return;
  }

  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { error: 'Request body must be a JSON object' });
    return;
  }

  const { provider, identityToken, nonce, name } = body as Record<string, unknown>;

  if (provider !== 'apple' && provider !== 'google') {
    sendJson(res, 400, { error: 'provider must be "apple" or "google"' });
    return;
  }
  if (typeof identityToken !== 'string' || identityToken.length === 0) {
    sendJson(res, 400, { error: 'identityToken is required' });
    return;
  }
  if (nonce !== undefined && typeof nonce !== 'string') {
    sendJson(res, 400, { error: 'nonce must be a string' });
    return;
  }

  let configuration: ReturnType<typeof currentStoreNativeOAuthConfiguration>;
  try {
    configuration = currentStoreNativeOAuthConfiguration();
  } catch {
    logger.warn('[NativeAuth] Reserved OAuth unavailable', { category: 'configuration' });
    sendJson(res, 503, { error: 'Service temporarily unavailable' });
    return;
  }
  const staged = configuration.mode === 'reserved-staging';
  if (configuration.mode === 'reserved-staging') {
    try {
      await preflight(database, configuration.authority);
    } catch (error) {
      reportReservedNativeOAuthFailure(res, error);
      return;
    }
  }
  const verified = await verifyProviderIdentityToken(provider, identityToken, nonce, staged);
  if (verified.status === 'invalid') {
    sendJson(res, 401, { error: 'Invalid or expired identity token' });
    return;
  }
  if (verified.status === 'unavailable') {
    sendJson(res, 503, { error: 'Service temporarily unavailable' });
    return;
  }
  const { identity } = verified;
  const origin = signedInNow();
  if (configuration.mode === 'reserved-staging') {
    await handleReservedNativeOAuth(
      res,
      database,
      configuration.authority,
      provider,
      identity,
      parseForwardedName(name),
      origin,
    );
    return;
  }

  try {
    const result = await findOrCreateOAuthUser(provider, identity, parseForwardedName(name), origin, database);
    if (result.status === 'no_email') {
      logger.warn(`[NativeAuth] ${provider} sign-in for a new account without an email — rejecting`);
      sendJson(res, 401, { error: 'An email is required to create an account' });
      return;
    }
    logger.info(`[NativeAuth] ${provider} sign-in successful for user ${result.userId}`);
    sendJson(res, 200, {
      ...result.tokenPair,
      ...(result.accountCreation ? { accountCreation: result.accountCreation } : {}),
    });
  } catch (error) {
    if (respondNativeAdmissionFailure(res, error)) return;
    logger.error('[NativeAuth] OAuth sign-in failed:', error);
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

function reportReservedNativeOAuthFailure(response: ServerResponse, error: unknown) {
  if (respondReservedNativeAdmissionFailure(response, error)) return;
  if (isNativeAuthInfrastructureFailure(error)) {
    logger.warn('[NativeAuth] Reserved OAuth unavailable', { category: 'authority-or-database' });
    sendJson(response, 503, { error: 'Service temporarily unavailable' });
  } else {
    logger.error('[NativeAuth] Reserved OAuth failed', new Error('Native OAuth internal failure'));
    sendJson(response, 500, { error: 'Internal server error' });
  }
}

async function handleReservedNativeOAuth(
  response: ServerResponse,
  database: DbInstance,
  authority: WebPasswordAuthority,
  provider: OAuthProvider,
  identity: VerifiedOAuthIdentity,
  name: ForwardedName | undefined,
  origin: NativeCredentialOrigin,
) {
  try {
    const result = await database.transaction(async (transaction) => {
      await transactionSettings(transaction);
      const resolved = await resolveReservedNativeOAuthIdentity(transaction, authority, provider, identity, name);
      if (resolved.outcome !== 'linked' && resolved.outcome !== 'created') return resolved;
      const tokenPair = await generateTokenPair(resolved.userId, transaction, origin);
      return {
        outcome: 'ok' as const,
        tokenPair,
        accountCreation: accountCreationReceipt(
          resolved.userId,
          resolved.outcome === 'created',
          provider,
          resolved.createdAt,
        ),
      };
    });
    if (result.outcome === 'conflict') {
      sendJson(response, 409, {
        error: 'This sign-in method is not linked to that account. Use your existing sign-in method.',
      });
    } else if (result.outcome === 'no_email') {
      sendJson(response, 401, { error: 'An email is required to create an account' });
    } else if (result.outcome === 'deleted') {
      sendJson(response, 401, { error: 'Account is not available' });
    } else {
      sendJson(response, 200, {
        ...result.tokenPair,
        ...(result.accountCreation ? { accountCreation: result.accountCreation } : {}),
      });
    }
  } catch (error) {
    reportReservedNativeOAuthFailure(response, error);
  }
}

// ---------------------------------------------------------------------------
// POST /auth/native/refresh
// ---------------------------------------------------------------------------

export async function handleNativeAuthRefresh(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // Rate limit by IP
  const clientIp = getClientIp(req);
  const retryAfter = checkAuthRateLimit(clientIp);
  if (retryAfter === -1) {
    sendJson(res, 503, { error: 'Service temporarily overloaded' });
    return;
  }
  if (retryAfter !== null) {
    res.setHeader('Retry-After', String(retryAfter));
    sendJson(res, 429, { error: `Rate limit exceeded. Try again in ${retryAfter} seconds.` });
    return;
  }

  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { error: 'Request body must be a JSON object' });
    return;
  }

  const { refreshToken } = body as Record<string, unknown>;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    sendJson(res, 400, { error: 'refreshToken is required' });
    return;
  }

  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

  try {
    // A non-locking hint is not token admission. Acquire the user lock before
    // touching refresh rows, then recheck the exact hash/UID and current state.
    const [hint] = await db
      .select({ userId: mobileRefreshTokens.userId })
      .from(mobileRefreshTokens)
      .where(eq(mobileRefreshTokens.tokenHash, tokenHash))
      .limit(1);
    if (!hint) {
      sendJson(res, 401, { error: 'Invalid refresh token' });
      return;
    }
    const result = await db.transaction(async (tx) => {
      await transactionSettings(tx);
      // The user lock first, then the generations in a statement of its own. A
      // reset or deletion that committed while this waited is seen here, and none
      // can commit before this does: each takes users FOR UPDATE, which this
      // KEY SHARE excludes. The parent is decided against these generations.
      const lockedState = await requireHumanSubjectForIssuance(tx, hint.userId);
      // Atomically revoke the token and return it in a single query.
      // This prevents TOCTOU races: if two concurrent requests present the same
      // refresh token, only one will get the row back — the other gets an empty
      // result because the WHERE clause requires revoked_at IS NULL.
      const revokedRows = await tx
        .update(mobileRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(mobileRefreshTokens.tokenHash, tokenHash),
            eq(mobileRefreshTokens.userId, hint.userId),
            isNull(mobileRefreshTokens.revokedAt),
          ),
        )
        .returning();

      const revokedToken = revokedRows[0];
      if (!revokedToken) {
        return { status: 401 as const, error: 'Invalid refresh token' };
      }

      if (revokedToken.expiresAt < new Date()) {
        return { status: 401 as const, error: 'Refresh token expired' };
      }

      const tokenPair = await generateTokenPair(
        revokedToken.userId,
        tx,
        { kind: 'refresh', parent: revokedToken },
        lockedState,
      );
      return { status: 200 as const, tokenPair, userId: revokedToken.userId };
    });

    if (result.status !== 200) {
      sendJson(res, result.status, { error: result.error });
      return;
    }

    logger.info(`[NativeAuth] Token refresh successful for user ${result.userId}`);
    sendJson(res, 200, result.tokenPair);
  } catch (error) {
    if (respondNativeAdmissionFailure(res, error)) return;
    logger.error('[NativeAuth] Token refresh failed:', error);
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// POST /auth/native/revoke
// ---------------------------------------------------------------------------

export async function handleNativeAuthRevoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // No rate limiting for revoke — the endpoint requires a valid refresh token
  // (a secret), so it's already gated. Exempting it prevents aggressive retry
  // loops from locking a user out of sign-out.

  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { error: 'Request body must be a JSON object' });
    return;
  }

  const { refreshToken } = body as Record<string, unknown>;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    sendJson(res, 400, { error: 'refreshToken is required' });
    return;
  }

  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

  try {
    // Look up the token to find the user. Only non-revoked tokens are valid
    // for initiating a full sign-out.
    const matchedToken = await db.transaction(async (transaction) => {
      const matchingRows = await transaction
        .update(mobileRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(mobileRefreshTokens.tokenHash, tokenHash), isNull(mobileRefreshTokens.revokedAt)))
        .returning({ userId: mobileRefreshTokens.userId });

      const matchingToken = matchingRows[0];
      if (!matchingToken) return null;

      // This endpoint signs out the whole account. The refresh secret remains
      // usable when the JWT has expired, so retire push devices in the same
      // transaction as token revocation rather than relying on bearer cleanup.
      await transaction
        .update(mobileRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(mobileRefreshTokens.userId, matchingToken.userId), isNull(mobileRefreshTokens.revokedAt)));
      await transaction
        .update(notificationDevices)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(notificationDevices.userId, matchingToken.userId));
      return matchingToken;
    });

    if (!matchedToken) {
      sendJson(res, 401, { error: 'Invalid refresh token' });
      return;
    }

    logger.info(`[NativeAuth] All tokens revoked for user ${matchedToken.userId}`);
    sendJson(res, 200, { revoked: true });
  } catch (error) {
    logger.error('[NativeAuth] Token revocation failed:', error);
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// Watch pairing — POST /api/watch/pair-code (authed) + POST /api/watch/pair
//
// A Garmin watch (Connect IQ) can only make plain HTTPS requests and has no
// good text entry, so it can't run the web OAuth transfer-token dance. Instead:
//   1. The already-logged-in phone/web app calls POST /api/watch/pair-code and
//      shows the returned short code to the user.
//   2. The user types the code on the watch, which POSTs /api/watch/pair to
//      exchange it for the same { jwt, refreshToken, expiresAt } mobile token
//      pair every other native client uses (generateTokenPair).
//
// The code lives in Redis with a short TTL and is single-use (GETDEL on
// consume). It must be cross-instance (the phone and watch may hit different
// backend instances), so pairing requires Redis — no in-memory fallback.
// ---------------------------------------------------------------------------

/** Pairing-code lifetime — long enough to read off a phone and type on a watch. */
const WATCH_PAIR_CODE_TTL_SECONDS = 300;

/** Pairing-code length in characters. */
const WATCH_PAIR_CODE_LENGTH = 8;

/**
 * Unambiguous alphabet for hand entry on a watch: A–Z minus I/L/O/U and digits
 * 2–9 (no 0/1). 30^8 ≈ 2^39 combinations — with the 300s TTL, single-use
 * consume, and the IP rate limit, brute-forcing a live code is infeasible.
 */
const WATCH_PAIR_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** Redis key prefix for live pairing codes. */
const WATCH_PAIR_CODE_REDIS_PREFIX = 'boardsesh:watch:pair:';

/** How many times to retry on the (astronomically unlikely) code collision. */
const WATCH_PAIR_CODE_MAX_ATTEMPTS = 5;

function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < WATCH_PAIR_CODE_LENGTH; i++) {
    code += WATCH_PAIR_CODE_ALPHABET[crypto.randomInt(WATCH_PAIR_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * POST /api/watch/pair-code
 * Headers: Authorization: Bearer <token>  (web NextAuth JWE or mobile JWS)
 * Body: none
 *
 * Mints a short, single-use pairing code bound to the authenticated user and
 * returns { code, expiresAt }. Called by the phone/web "Pair a Garmin watch"
 * UI, so it accepts either token family via validateToken.
 */
export async function handleWatchPairCode(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const clientIp = getClientIp(req);
  const retryAfter = checkAuthRateLimit(clientIp);
  if (retryAfter === -1) {
    sendJson(res, 503, { error: 'Service temporarily overloaded' });
    return;
  }
  if (retryAfter !== null) {
    res.setHeader('Retry-After', String(retryAfter));
    sendJson(res, 429, { error: `Rate limit exceeded. Try again in ${retryAfter} seconds.` });
    return;
  }

  const authHeader = req.headers['authorization'];
  const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!headerValue || !headerValue.startsWith('Bearer ')) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }
  const token = headerValue.slice(7).trim();
  const admission = token ? await validateHttpAuthToken(token, res) : { available: true as const, auth: null };
  if (!admission.available) return;
  const auth = admission.auth;
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  if (!redisClientManager.isRedisConnected()) {
    // Pairing codes must be readable across instances; without Redis a code
    // minted on one instance couldn't be consumed on another.
    logger.error('[WatchPair] Redis unavailable — cannot mint pairing code');
    sendJson(res, 503, { error: 'Service temporarily unavailable' });
    return;
  }

  try {
    const { publisher } = redisClientManager.getClients();
    let code: string | null = null;
    for (let attempt = 0; attempt < WATCH_PAIR_CODE_MAX_ATTEMPTS; attempt++) {
      const candidate = generatePairingCode();
      // SET NX so a rare collision with a live code doesn't overwrite it.
      const stored = await publisher.set(
        `${WATCH_PAIR_CODE_REDIS_PREFIX}${candidate}`,
        auth.userId,
        'EX',
        WATCH_PAIR_CODE_TTL_SECONDS,
        'NX',
      );
      if (stored === 'OK') {
        code = candidate;
        break;
      }
    }

    if (!code) {
      logger.error('[WatchPair] Failed to allocate a unique pairing code after retries');
      sendJson(res, 503, { error: 'Service temporarily overloaded' });
      return;
    }

    const expiresAt = new Date(Date.now() + WATCH_PAIR_CODE_TTL_SECONDS * 1000).toISOString();
    logger.info(`[WatchPair] Issued pairing code for user ${auth.userId}`);
    sendJson(res, 200, { code, expiresAt });
  } catch (error) {
    logger.error('[WatchPair] Failed to issue pairing code:', error);
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

/**
 * POST /api/watch/pair
 * Body: { code: string }
 *
 * Consumes a pairing code (single-use) and returns a mobile token pair for the
 * user the code was minted for. Unauthenticated — the code is the credential.
 */
export async function handleWatchPair(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const clientIp = getClientIp(req);
  const retryAfter = checkAuthRateLimit(clientIp);
  if (retryAfter === -1) {
    sendJson(res, 503, { error: 'Service temporarily overloaded' });
    return;
  }
  if (retryAfter !== null) {
    res.setHeader('Retry-After', String(retryAfter));
    sendJson(res, 429, { error: `Rate limit exceeded. Try again in ${retryAfter} seconds.` });
    return;
  }

  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { error: 'Request body must be a JSON object' });
    return;
  }

  const { code } = body as Record<string, unknown>;
  if (typeof code !== 'string' || code.length === 0) {
    sendJson(res, 400, { error: 'code is required' });
    return;
  }

  // Normalize hand entry: strip separators/whitespace, uppercase. A correct
  // code is exactly WATCH_PAIR_CODE_LENGTH alphanumerics after normalization.
  const normalized = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (normalized.length !== WATCH_PAIR_CODE_LENGTH) {
    sendJson(res, 400, { error: 'Invalid pairing code' });
    return;
  }

  if (!redisClientManager.isRedisConnected()) {
    logger.error('[WatchPair] Redis unavailable — cannot consume pairing code');
    sendJson(res, 503, { error: 'Service temporarily unavailable' });
    return;
  }

  try {
    const { publisher } = redisClientManager.getClients();
    const pendingUserId = await publisher.get(`${WATCH_PAIR_CODE_REDIS_PREFIX}${normalized}`);
    if (!pendingUserId || !(await isHumanSubjectActive(pendingUserId))) {
      sendJson(res, 401, { error: 'Invalid or expired pairing code' });
      return;
    }
    // Admission awaited the primary. An expired/replaced code must not let
    // this older request consume a newer owner's capability at the same key.
    let userId: unknown;
    try {
      userId = await publisher.eval(
        "local owner = redis.call('GET', KEYS[1]); if owner == ARGV[1] then redis.call('DEL', KEYS[1]); return owner end; return false",
        1,
        `${WATCH_PAIR_CODE_REDIS_PREFIX}${normalized}`,
        pendingUserId,
      );
    } catch {
      // Redis errors can retain command arguments. Keep them out of logs and
      // never restore a claim after an uncertain atomic command outcome.
      throw new AuthAdmissionUnavailableError();
    }
    if (!userId || userId !== pendingUserId) {
      sendJson(res, 401, { error: 'Invalid or expired pairing code' });
      return;
    }

    const tokenPair = await issueTokenPair(userId, SIGN_IN_OF_UNKNOWN_AGE);
    logger.info(`[WatchPair] Pairing successful for user ${userId}`);
    sendJson(res, 200, tokenPair);
  } catch (error) {
    if (respondNativeAdmissionFailure(res, error)) return;
    logger.error('[WatchPair] Pairing failed:', error);
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// Periodic cleanup of expired / revoked refresh tokens
// ---------------------------------------------------------------------------

/** How often to run the cleanup (every 6 hours). */
const REFRESH_TOKEN_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Revoked tokens older than this are deleted (7 days). */
const REVOKED_TOKEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

let refreshTokenCleanupHandle: ReturnType<typeof setInterval> | null = null;

async function runRefreshTokenCleanup(): Promise<void> {
  const revokedCutoff = new Date(Date.now() - REVOKED_TOKEN_RETENTION_MS);
  const now = new Date();
  try {
    const result = await db
      .delete(mobileRefreshTokens)
      .where(
        or(
          // Revoked tokens older than 7 days
          and(isNotNull(mobileRefreshTokens.revokedAt), lt(mobileRefreshTokens.revokedAt, revokedCutoff)),
          // Expired tokens
          lt(mobileRefreshTokens.expiresAt, now),
        ),
      )
      .returning({ id: mobileRefreshTokens.id });
    if (result.length > 0) {
      logger.info(`[NativeAuth Cleanup] Removed ${String(result.length)} expired/revoked refresh token(s)`);
    }
  } catch (error) {
    logger.error('[NativeAuth Cleanup] Failed to remove expired refresh tokens:', error);
  }
}

/** Start the periodic refresh token cleanup loop. */
export function startRefreshTokenCleanup(): void {
  if (refreshTokenCleanupHandle !== null) return;
  logger.info(
    `[NativeAuth Cleanup] Started (interval=${String(REFRESH_TOKEN_CLEANUP_INTERVAL_MS)}ms, ` +
      `revokedRetention=${String(REVOKED_TOKEN_RETENTION_MS / (24 * 60 * 60 * 1000))}d)`,
  );

  // Run once shortly after startup, then on the regular interval.
  const initialDelay = setTimeout(() => {
    runRefreshTokenCleanup().catch((error) => {
      logger.error('[NativeAuth Cleanup] Initial tick failed:', error);
    });
  }, 60 * 1000);
  if (typeof initialDelay.unref === 'function') initialDelay.unref();

  refreshTokenCleanupHandle = setInterval(() => {
    runRefreshTokenCleanup().catch((error) => {
      logger.error('[NativeAuth Cleanup] Tick failed:', error);
    });
  }, REFRESH_TOKEN_CLEANUP_INTERVAL_MS);

  if (typeof refreshTokenCleanupHandle.unref === 'function') refreshTokenCleanupHandle.unref();
}

export function stopRefreshTokenCleanup(): void {
  if (refreshTokenCleanupHandle === null) return;
  clearInterval(refreshTokenCleanupHandle);
  refreshTokenCleanupHandle = null;
  logger.info('[NativeAuth Cleanup] Stopped');
}

// ---------------------------------------------------------------------------
// Test-only utilities
// ---------------------------------------------------------------------------

/** Reset the in-memory rate limit and consumed token maps. Test-only. */
export function __resetNativeAuthStateForTests(): void {
  authRateLimitMap.clear();
  consumedTransferTokens.clear();
}

/** Fill the consumed-token map with fresh entries for capacity testing. Test-only. */
export function __fillConsumedTokenMapForTests(count: number): void {
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    consumedTransferTokens.set(`test-sig-${String(i)}`, now);
  }
}

/** Fill the rate-limit map with non-expired entries for capacity testing. Test-only. */
export function __fillRateLimitMapForTests(count: number): void {
  const futureReset = Date.now() + AUTH_RATE_LIMIT_WINDOW_MS;
  for (let i = 0; i < count; i++) {
    authRateLimitMap.set(`test-ip-${String(i)}`, { count: 1, resetAt: futureReset });
  }
}

/** Run the refresh token cleanup tick directly. Test-only. */
export async function __runRefreshTokenCleanupForTests(): Promise<void> {
  await runRefreshTokenCleanup();
}
